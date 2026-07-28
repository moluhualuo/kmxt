import { randomUUID } from 'node:crypto';
import { AppError } from '../../core/app-error.js';
import { Roles } from '../../services/access-control.js';

function parsePayload(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function sqlDate(value) { return value ? new Date(value) : null; }

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  const normalized = String(value).replace(' ', 'T');
  return normalized.endsWith('Z') ? normalized : `${normalized}Z`;
}

function assertAccess(actor, merchantId) {
  if (actor.role !== Roles.PLATFORM_ADMIN && actor.merchantId !== merchantId) {
    throw new AppError('FORBIDDEN', 'Cross-merchant access is not allowed', 403);
  }
}

function parseArtifactRow(row) {
  const artifact = parsePayload(row.payload);
  if (Object.hasOwn(row, 'merchant_id')) artifact.merchantId = row.merchant_id;
  if (Object.hasOwn(row, 'app_id')) artifact.appId = row.app_id;
  if (Object.hasOwn(row, 'status')) artifact.status = row.status;
  return artifact;
}

// Author: 花落. Scoped MySQL model artifact and lease transactions use the MIT License.
export class MysqlModelDeliveryRepository {
  constructor(pool) { this.pool = pool; }

  async register(actor, appId, createArtifact) {
    try {
      return await this.#transaction(async (connection) => {
        const application = await this.#lockActiveApplication(connection, appId);
        assertAccess(actor, application.merchantId);
        const artifact = await createArtifact(application);
        await connection.execute(
          `INSERT INTO model_artifacts
            (id, merchant_id, app_id, name, version, format, status, cipher_sha256, size, created_at, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            artifact.id,
            artifact.merchantId,
            artifact.appId,
            artifact.name,
            artifact.version,
            artifact.format,
            artifact.status,
            artifact.cipherSha256,
            artifact.size,
            sqlDate(artifact.createdAt),
            JSON.stringify(artifact),
          ],
        );
        await this.#audit(
          connection,
          actor,
          artifact.merchantId,
          'model-artifact.register',
          'model_artifact',
          artifact.id,
          {
            appId: artifact.appId,
            name: artifact.name,
            version: artifact.version,
            format: artifact.format,
            cipherSha256: artifact.cipherSha256,
            size: artifact.size,
          },
          artifact.createdAt,
        );
        return artifact;
      });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY' && /uq_model_artifacts_version/i.test(error.message || '')) {
        throw new AppError('ARTIFACT_EXISTS', 'Artifact name and version already exist', 409);
      }
      throw error;
    }
  }

  async list(actor, appId) {
    const application = await this.#application(appId);
    assertAccess(actor, application.merchantId);
    const [rows] = await this.pool.execute(
      `SELECT payload, merchant_id, app_id, status
       FROM model_artifacts
       WHERE app_id = ?
       ORDER BY created_at DESC`,
      [appId],
    );
    return rows.map(parseArtifactRow);
  }

  async setStatus(actor, artifactId, nextStatus) {
    return this.#transaction(async (connection) => {
      const [identityRows] = await connection.execute(
        'SELECT merchant_id, app_id FROM model_artifacts WHERE id = ?',
        [artifactId],
      );
      if (!identityRows[0]) {
        throw new AppError('ARTIFACT_NOT_FOUND', 'Model artifact was not found', 404);
      }
      assertAccess(actor, identityRows[0].merchant_id);
      await this.#requireActiveMerchant(connection, identityRows[0].merchant_id);
      const [applicationRows] = await connection.execute(
        'SELECT id FROM applications WHERE id = ? FOR UPDATE',
        [identityRows[0].app_id],
      );
      if (!applicationRows[0]) {
        throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
      }
      const [artifactRows] = await connection.execute(
        'SELECT payload, merchant_id, app_id, status FROM model_artifacts WHERE id = ? FOR UPDATE',
        [artifactId],
      );
      if (!artifactRows[0]) {
        throw new AppError('ARTIFACT_NOT_FOUND', 'Model artifact was not found', 404);
      }
      const artifact = parseArtifactRow(artifactRows[0]);
      if (artifact.status === 'revoked') {
        if (nextStatus === 'revoked') return artifact;
        throw new AppError('ARTIFACT_REVOKED', 'A revoked model artifact cannot be restored', 409);
      }

      const now = new Date().toISOString();
      artifact.status = nextStatus;
      artifact.updatedAt = now;
      await connection.execute(
        'UPDATE model_artifacts SET status = ?, payload = ? WHERE id = ?',
        [artifact.status, JSON.stringify(artifact), artifact.id],
      );
      if (nextStatus === 'revoked') {
        await connection.execute(
          `UPDATE model_leases
           SET status = 'revoked',
               payload = JSON_SET(payload, '$.status', 'revoked', '$.updatedAt', ?)
           WHERE artifact_id = ? AND status = 'active'`,
          [now, artifact.id],
        );
      }
      await this.#audit(
        connection,
        actor,
        artifact.merchantId,
        'model-artifact.status',
        'model_artifact',
        artifact.id,
        { appId: artifact.appId, status: nextStatus },
        now,
      );
      return artifact;
    });
  }

  async delete(actor, artifactId) {
    return this.#transaction(async (connection) => {
      const [identityRows] = await connection.execute(
        'SELECT merchant_id, app_id FROM model_artifacts WHERE id = ?',
        [artifactId],
      );
      if (!identityRows[0]) {
        throw new AppError('ARTIFACT_NOT_FOUND', 'Model artifact was not found', 404);
      }
      assertAccess(actor, identityRows[0].merchant_id);
      await this.#requireActiveMerchant(connection, identityRows[0].merchant_id);
      const [applicationRows] = await connection.execute(
        'SELECT id FROM applications WHERE id = ? FOR UPDATE',
        [identityRows[0].app_id],
      );
      if (!applicationRows[0]) {
        throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
      }
      const [artifactRows] = await connection.execute(
        'SELECT payload, merchant_id, app_id, status FROM model_artifacts WHERE id = ? FOR UPDATE',
        [artifactId],
      );
      if (!artifactRows[0]) {
        throw new AppError('ARTIFACT_NOT_FOUND', 'Model artifact was not found', 404);
      }
      const artifact = parseArtifactRow(artifactRows[0]);
      if (artifact.status !== 'draft' && artifact.status !== 'revoked') {
        throw new AppError('ARTIFACT_ACTIVE', 'Only draft or revoked artifacts can be deleted', 409);
      }
      const [leaseRows] = await connection.execute(
        'SELECT COUNT(*) AS count FROM model_leases WHERE artifact_id = ?',
        [artifactId],
      );
      const deletedLeases = Number(leaseRows[0]?.count ?? 0);
      // fk_model_leases_artifact declares ON DELETE CASCADE, so deleting the artifact
      // removes its leases; delete them first anyway to keep the intent explicit.
      await connection.execute('DELETE FROM model_leases WHERE artifact_id = ?', [artifactId]);
      await connection.execute('DELETE FROM model_artifacts WHERE id = ?', [artifactId]);
      await this.#audit(
        connection,
        actor,
        artifact.merchantId,
        'model-artifact.delete',
        'model_artifact',
        artifactId,
        {
          appId: artifact.appId,
          name: artifact.name,
          version: artifact.version,
          deletedLeases,
        },
        new Date().toISOString(),
      );
      return { deletedLeases };
    });
  }

  async issueLease(input, createLease) {
    return this.#transaction(async (connection) => {
      const application = await this.#lockActiveApplication(connection, input.appId);
      const [artifactRows] = await connection.execute(
        `SELECT payload, merchant_id, app_id, status
         FROM model_artifacts
         WHERE id = ? AND app_id = ?
         FOR UPDATE`,
        [input.artifactId, input.appId],
      );
      if (!artifactRows[0]) {
        throw new AppError('ARTIFACT_NOT_FOUND', 'Model artifact was not found', 404);
      }
      const artifact = parseArtifactRow(artifactRows[0]);
      if (artifact.status !== 'active') {
        throw new AppError('ARTIFACT_UNAVAILABLE', 'Model artifact is not active', 403);
      }

      // Match VerificationRepository's session -> license -> binding lock order.
      const [sessionRows] = await connection.execute(
        `SELECT payload, expires_at
         FROM client_sessions
         WHERE app_id = ? AND binding_id = ? AND token_digest = ?
         FOR UPDATE`,
        [input.appId, input.bindingId, input.sessionDigest],
      );
      const session = sessionRows[0] ? parsePayload(sessionRows[0].payload) : null;
      if (sessionRows[0]?.expires_at) session.expiresAt = toIso(sessionRows[0].expires_at);
      const sessionExpiry = session ? Date.parse(session.expiresAt) : Number.NaN;
      if (!session
        || !Number.isFinite(sessionExpiry)
        || sessionExpiry <= input.nowMilliseconds) {
        throw new AppError('SESSION_EXPIRED', 'Verification session is invalid or expired', 401);
      }

      const [licenseRows] = await connection.execute(
        'SELECT payload, status, expires_at FROM licenses WHERE id = ? FOR UPDATE',
        [input.licenseId],
      );
      if (!licenseRows[0]) {
        throw new AppError('LICENSE_NOT_FOUND', 'License was not found', 404);
      }
      const license = parsePayload(licenseRows[0].payload);
      license.status = licenseRows[0].status;
      if (licenseRows[0].expires_at) license.expiresAt = toIso(licenseRows[0].expires_at);
      if (license.appId !== input.appId) {
        throw new AppError('LICENSE_INVALID', 'License belongs to another application', 401);
      }
      if (session.licenseId !== license.id || session.bindingId !== input.bindingId) {
        throw new AppError('SESSION_EXPIRED', 'Verification session is invalid or expired', 401);
      }

      const [bindingRows] = await connection.execute(
        `SELECT payload, status, device_digest
         FROM device_bindings
         WHERE id = ? AND app_id = ? AND license_id = ?
         FOR UPDATE`,
        [input.bindingId, input.appId, license.id],
      );
      const binding = bindingRows[0] ? parsePayload(bindingRows[0].payload) : null;
      if (!binding
        || bindingRows[0].status !== 'active'
        || bindingRows[0].device_digest !== input.deviceDigest) {
        throw new AppError('DEVICE_MISMATCH', 'The verification device does not match the binding', 401);
      }
      binding.status = bindingRows[0].status;
      binding.deviceDigest = bindingRows[0].device_digest;

      const prepared = await createLease({ application, artifact, license, binding, session });
      const { lease } = prepared;
      await connection.execute(
        `INSERT INTO model_leases
          (id, merchant_id, app_id, artifact_id, license_id, binding_id, jti,
           client_key_fingerprint, status, expires_at, created_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          lease.id,
          lease.merchantId,
          lease.appId,
          lease.artifactId,
          lease.licenseId,
          lease.bindingId,
          lease.jti,
          lease.clientKeyFingerprint,
          lease.status,
          sqlDate(lease.expiresAt),
          sqlDate(lease.createdAt),
          JSON.stringify(lease),
        ],
      );
      await this.#audit(
        connection,
        null,
        application.merchantId,
        'model-lease.issue',
        'model_lease',
        lease.id,
        {
          appId: input.appId,
          artifactId: artifact.id,
          licenseId: license.id,
          bindingId: binding.id,
          clientKeyFingerprint: lease.clientKeyFingerprint,
          expiresAt: lease.expiresAt,
        },
        lease.createdAt,
      );
      return { application, artifact, license, binding, session, ...prepared };
    });
  }

  async cleanupExpiredLeases(now = Date.now(), connection = null) {
    const executor = connection || this.pool;
    const [result] = await executor.execute(
      'DELETE FROM model_leases WHERE expires_at <= ?',
      [new Date(now)],
    );
    return Number(result.affectedRows ?? 0);
  }

  async #application(appId) {
    const [rows] = await this.pool.execute(
      'SELECT payload, merchant_id, status FROM applications WHERE id = ?',
      [appId],
    );
    if (!rows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    const application = parsePayload(rows[0].payload);
    application.merchantId = rows[0].merchant_id;
    application.status = rows[0].status;
    return application;
  }

  async #lockActiveApplication(connection, appId) {
    const [identityRows] = await connection.execute(
      'SELECT merchant_id FROM applications WHERE id = ?',
      [appId],
    );
    if (!identityRows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    await this.#requireActiveMerchant(connection, identityRows[0].merchant_id);
    const [rows] = await connection.execute(
      'SELECT payload, merchant_id, status FROM applications WHERE id = ? FOR UPDATE',
      [appId],
    );
    if (!rows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    if (rows[0].status !== 'active') {
      throw new AppError('APPLICATION_DISABLED', 'Application is disabled', 403);
    }
    const application = parsePayload(rows[0].payload);
    application.merchantId = rows[0].merchant_id;
    application.status = rows[0].status;
    return application;
  }

  async #requireActiveMerchant(connection, merchantId) {
    const [rows] = await connection.execute(
      'SELECT status FROM merchants WHERE id = ? FOR UPDATE',
      [merchantId],
    );
    if (!rows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
    if (rows[0].status !== 'active') {
      throw new AppError('MERCHANT_DISABLED', 'Merchant is disabled', 403);
    }
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
    } finally {
      connection.release();
    }
  }

  async #audit(connection, actor, merchantId, action, resourceType, resourceId, metadata, createdAt) {
    const entry = {
      id: randomUUID(),
      merchantId,
      actorUserId: actor?.id ?? null,
      actorUsername: actor?.username ?? 'system',
      action,
      resourceType,
      resourceId,
      metadata,
      createdAt,
    };
    await connection.execute(
      'INSERT INTO audit_logs (id, merchant_id, actor_id, action, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
      [entry.id, entry.merchantId, entry.actorUserId, entry.action, sqlDate(entry.createdAt), JSON.stringify(entry)],
    );
  }
}
