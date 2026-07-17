import { randomUUID } from 'node:crypto';
import { AppError } from '../../core/app-error.js';
import { Roles } from '../../services/access-control.js';

function parsePayload(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function sqlDate(value) { return value ? new Date(value) : null; }
function pageLimit(pagination) { return Math.max(1, Math.trunc(Number(pagination.limit) || 20)); }
function pageOffset(pagination) { return Math.max(0, Math.trunc(Number(pagination.offset) || 0)); }
function assertAccess(actor, merchantId) {
  if (actor.role !== Roles.PLATFORM_ADMIN && actor.merchantId !== merchantId) {
    throw new AppError('FORBIDDEN', 'Cross-merchant access is not allowed', 403);
  }
}

// Author: 花落. MySQL license management queries are provided under the MIT License.
export class MysqlLicenseRepository {
  constructor(pool) { this.pool = pool; }

  async generate(actor, appId, createArtifacts) {
    try {
      return await this.#transaction(async (connection) => {
        const application = await this.#lockActiveApplication(connection, appId);
        assertAccess(actor, application.merchantId);
        const artifacts = await createArtifacts(application);
        await connection.execute(
          'INSERT INTO license_batches (id, merchant_id, app_id, source_id, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
          [artifacts.batch.id, artifacts.batch.merchantId, artifacts.batch.appId, artifacts.batch.sourceId ?? null, sqlDate(artifacts.batch.createdAt), JSON.stringify(artifacts.batch)],
        );
        for (const license of artifacts.licenses) {
          await connection.execute(
            'INSERT INTO licenses (id, merchant_id, app_id, batch_id, key_digest, status, expires_at, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [license.id, license.merchantId, license.appId, license.batchId, license.keyDigest, license.status, sqlDate(license.expiresAt), sqlDate(license.createdAt), JSON.stringify(license)],
          );
        }
        await this.#audit(connection, actor, application.merchantId, 'license_batch.create', 'license_batch', artifacts.batch.id, {
          appId,
          count: artifacts.batch.count,
          durationDays: artifacts.batch.durationDays,
          fixedExpiresAt: artifacts.batch.fixedExpiresAt,
          maxDevices: artifacts.batch.maxDevices,
        }, artifacts.batch.createdAt);
        return artifacts;
      });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY' && /uq_licenses_key_digest/i.test(error.message || '')) {
        throw new AppError('LICENSE_COLLISION', 'Generated license collision; retry the request', 409);
      }
      throw error;
    }
  }

  async list(actor, appId, pagination, filters) {
    const application = await this.#application(actor, appId);
    const conditions = ['app_id = ?'];
    const values = [application.id];
    if (filters.status && filters.status !== 'expired') { conditions.push('status = ?'); values.push(filters.status); }
    if (filters.status === 'expired') {
      conditions.push("status <> 'disabled'");
      conditions.push('expires_at IS NOT NULL');
      conditions.push('expires_at <= ?');
      values.push(new Date());
    }
    if (filters.keyDigest) { conditions.push('key_digest = ?'); values.push(filters.keyDigest); }
    const where = ` WHERE ${conditions.join(' AND ')}`;
    const limit = pageLimit(pagination);
    const offset = pageOffset(pagination);
    const [[countRows], [rows]] = await Promise.all([
      this.pool.execute(`SELECT COUNT(*) AS total FROM licenses${where}`, values),
      this.pool.execute(`SELECT payload FROM licenses${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, values),
    ]);
    const items = rows.map((row) => parsePayload(row.payload));
    return { items, page: pagination.page, limit: pagination.limit, total: Number(countRows[0]?.total ?? 0) };
  }

  async listBatches(actor, appId, pagination) {
    const application = await this.#application(actor, appId);
    const limit = pageLimit(pagination);
    const offset = pageOffset(pagination);
    const [[countRows], [rows]] = await Promise.all([
      this.pool.execute('SELECT COUNT(*) AS total FROM license_batches WHERE app_id = ?', [application.id]),
      this.pool.execute(`SELECT payload FROM license_batches WHERE app_id = ? ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, [application.id]),
    ]);
    return { items: rows.map((row) => parsePayload(row.payload)), page: pagination.page, limit: pagination.limit, total: Number(countRows[0]?.total ?? 0) };
  }

  async setStatus(actor, licenseId, requestedStatus, now = Date.now()) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [identityRows] = await connection.execute('SELECT merchant_id FROM licenses WHERE id = ?', [licenseId]);
      if (!identityRows[0]) throw new AppError('LICENSE_NOT_FOUND', 'License was not found', 404);
      await this.#requireActiveMerchant(connection, identityRows[0].merchant_id);
      const [rows] = await connection.execute('SELECT payload FROM licenses WHERE id = ? FOR UPDATE', [licenseId]);
      if (!rows[0]) throw new AppError('LICENSE_NOT_FOUND', 'License was not found', 404);
      const license = parsePayload(rows[0].payload);
      assertAccess(actor, license.merchantId);
      if (requestedStatus === 'active' && license.expiresAt && Date.parse(license.expiresAt) <= now) {
        throw new AppError('LICENSE_EXPIRED', 'An expired license cannot be enabled', 409);
      }
      license.status = requestedStatus === 'disabled' ? 'disabled' : license.activatedAt ? 'active' : 'pending';
      license.updatedAt = new Date(now).toISOString();
      await connection.execute('UPDATE licenses SET status = ?, payload = ? WHERE id = ?', [license.status, JSON.stringify(license), license.id]);
      if (requestedStatus === 'disabled') await connection.execute('DELETE FROM client_sessions WHERE license_id = ?', [license.id]);
      await this.#audit(connection, actor, license.merchantId, 'license.status.update', 'license', license.id, { status: license.status }, license.updatedAt);
      await connection.commit();
      return license;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  // Author: 花落. Sensitive key reveal and license removal are provided under the MIT License.
  async reveal(actor, licenseId, decryptKey) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [licenseRows] = await connection.execute('SELECT payload FROM licenses WHERE id = ? FOR UPDATE', [licenseId]);
      if (!licenseRows[0]) throw new AppError('LICENSE_NOT_FOUND', 'License was not found', 404);
      const license = parsePayload(licenseRows[0].payload);
      assertAccess(actor, license.merchantId);
      let order = null;
      if (!license.keyEncrypted) {
        const [orderRows] = await connection.execute('SELECT payload FROM orders WHERE license_id = ? FOR UPDATE', [licenseId]);
        order = orderRows[0] ? parsePayload(orderRows[0].payload) : null;
      }
      const key = await decryptKey(license, order);
      const now = new Date().toISOString();
      await this.#audit(connection, actor, license.merchantId, 'license.key.reveal', 'license', license.id, { appId: license.appId }, now);
      await connection.commit();
      return { licenseId, key };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async delete(actor, licenseId) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [licenseRows] = await connection.execute('SELECT payload FROM licenses WHERE id = ? FOR UPDATE', [licenseId]);
      if (!licenseRows[0]) throw new AppError('LICENSE_NOT_FOUND', 'License was not found', 404);
      const license = parsePayload(licenseRows[0].payload);
      assertAccess(actor, license.merchantId);
      const [orderRows] = await connection.execute('SELECT id FROM orders WHERE license_id = ? FOR UPDATE', [licenseId]);
      if (orderRows[0]) {
        throw new AppError('LICENSE_HAS_ORDER', 'A fulfilled store order keeps this license for delivery history', 409);
      }
      await connection.execute('DELETE FROM client_sessions WHERE license_id = ?', [licenseId]);
      await connection.execute('DELETE FROM verification_logs WHERE license_id = ?', [licenseId]);
      const [bindingResult] = await connection.execute('DELETE FROM device_bindings WHERE license_id = ?', [licenseId]);
      await connection.execute('DELETE FROM licenses WHERE id = ?', [licenseId]);
      const deletedBindings = Number(bindingResult.affectedRows ?? 0);
      const now = new Date().toISOString();
      await this.#audit(
        connection,
        actor,
        license.merchantId,
        'license.delete',
        'license',
        license.id,
        { appId: license.appId, deletedBindings },
        now,
      );
      await connection.commit();
      return { licenseId, deletedBindings };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  // Author: 花落. Bulk MySQL license deletion preserves per-license audit semantics under the MIT License.
  async bulkDelete(actor, appId, licenseIds) {
    await this.#application(actor, appId);
    const results = [];
    const failed = [];
    for (const licenseId of licenseIds) {
      try {
        const [rows] = await this.pool.execute('SELECT app_id FROM licenses WHERE id = ?', [licenseId]);
        if (!rows[0]) throw new AppError('LICENSE_NOT_FOUND', 'License was not found', 404);
        if (rows[0].app_id !== appId) {
          throw new AppError('LICENSE_APP_MISMATCH', 'License does not belong to the selected application', 400);
        }
        results.push(await this.delete(actor, licenseId));
      } catch (error) {
        failed.push({
          licenseId,
          code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
          message: error instanceof AppError ? error.message : 'An internal server error occurred',
        });
      }
    }
    return {
      requestedCount: licenseIds.length,
      deletedCount: results.length,
      deletedBindings: results.reduce((sum, item) => sum + Number(item.deletedBindings || 0), 0),
      deleted: results.map((item) => ({ licenseId: item.licenseId, deletedBindings: item.deletedBindings })),
      failed,
    };
  }

  async listDevices(actor, licenseId) {
    const [licenseRows] = await this.pool.execute('SELECT merchant_id FROM licenses WHERE id = ?', [licenseId]);
    if (!licenseRows[0]) throw new AppError('LICENSE_NOT_FOUND', 'License was not found', 404);
    assertAccess(actor, licenseRows[0].merchant_id);
    const [rows] = await this.pool.execute('SELECT payload FROM device_bindings WHERE license_id = ? ORDER BY created_at DESC', [licenseId]);
    return rows.map((row) => parsePayload(row.payload));
  }

  async unbind(actor, bindingId) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute('SELECT payload FROM device_bindings WHERE id = ? FOR UPDATE', [bindingId]);
      if (!rows[0]) throw new AppError('DEVICE_BINDING_NOT_FOUND', 'Device binding was not found', 404);
      const binding = parsePayload(rows[0].payload);
      assertAccess(actor, binding.merchantId);
      if (binding.status === 'revoked') { await connection.commit(); return binding; }
      const now = new Date().toISOString();
      binding.status = 'revoked'; binding.revokedAt = now; binding.updatedAt = now;
      await connection.execute('UPDATE device_bindings SET status = ?, payload = ? WHERE id = ?', [binding.status, JSON.stringify(binding), binding.id]);
      await connection.execute('DELETE FROM client_sessions WHERE binding_id = ?', [binding.id]);
      await this.#audit(connection, actor, binding.merchantId, 'device.unbind', 'device_binding', binding.id, { appId: binding.appId, licenseId: binding.licenseId }, now);
      await connection.commit();
      return binding;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  // Author: 花落. Bulk device revocation is provided under the MIT License.
  async unbindAll(actor, licenseId) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [licenseRows] = await connection.execute('SELECT payload FROM licenses WHERE id = ? FOR UPDATE', [licenseId]);
      if (!licenseRows[0]) throw new AppError('LICENSE_NOT_FOUND', 'License was not found', 404);
      const license = parsePayload(licenseRows[0].payload);
      assertAccess(actor, license.merchantId);
      const [bindingRows] = await connection.execute(
        "SELECT payload FROM device_bindings WHERE license_id = ? AND status = 'active' FOR UPDATE",
        [licenseId],
      );
      const bindings = bindingRows.map((row) => parsePayload(row.payload));
      const now = new Date().toISOString();
      for (const binding of bindings) {
        binding.status = 'revoked';
        binding.revokedAt = now;
        binding.updatedAt = now;
        await connection.execute(
          'UPDATE device_bindings SET status = ?, payload = ? WHERE id = ?',
          [binding.status, JSON.stringify(binding), binding.id],
        );
      }
      await connection.execute('DELETE FROM client_sessions WHERE license_id = ?', [licenseId]);
      if (bindings.length > 0) {
        await this.#audit(
          connection,
          actor,
          license.merchantId,
          'license.devices.unbind_all',
          'license',
          license.id,
          { appId: license.appId, unboundCount: bindings.length },
          now,
        );
      }
      await connection.commit();
      return { licenseId, unboundCount: bindings.length };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async #application(actor, appId) {
    const [rows] = await this.pool.execute('SELECT payload, merchant_id FROM applications WHERE id = ?', [appId]);
    if (!rows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    assertAccess(actor, rows[0].merchant_id);
    return parsePayload(rows[0].payload);
  }

  async #lockActiveApplication(connection, appId) {
    const [identityRows] = await connection.execute('SELECT merchant_id FROM applications WHERE id = ?', [appId]);
    if (!identityRows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    await this.#requireActiveMerchant(connection, identityRows[0].merchant_id);
    const [rows] = await connection.execute('SELECT payload, merchant_id, status FROM applications WHERE id = ? FOR UPDATE', [appId]);
    if (!rows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    if (rows[0].status !== 'active') throw new AppError('APPLICATION_DISABLED', 'Application is disabled', 403);
    const application = parsePayload(rows[0].payload);
    application.merchantId = rows[0].merchant_id;
    application.status = rows[0].status;
    return application;
  }

  async #requireActiveMerchant(connection, merchantId) {
    const [rows] = await connection.execute('SELECT status FROM merchants WHERE id = ? FOR UPDATE', [merchantId]);
    if (!rows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
    if (rows[0].status !== 'active') throw new AppError('MERCHANT_DISABLED', 'Merchant is disabled', 403);
  }

  async #transaction(operation) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async #audit(connection, actor, merchantId, action, resourceType, resourceId, metadata, createdAt) {
    const entry = { id: randomUUID(), merchantId, actorUserId: actor.id, actorUsername: actor.username ?? 'system', action, resourceType, resourceId, metadata, createdAt };
    await connection.execute('INSERT INTO audit_logs (id, merchant_id, actor_id, action, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)', [entry.id, entry.merchantId, entry.actorUserId, entry.action, sqlDate(entry.createdAt), JSON.stringify(entry)]);
  }
}
