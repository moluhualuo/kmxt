import { randomUUID } from 'node:crypto';
import { AppError } from '../../core/app-error.js';
import { Roles } from '../../services/access-control.js';

function parsePayload(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function sqlDate(value) { return value ? new Date(value) : null; }

function parseApplicationRow(row) {
  const application = parsePayload(row.payload);
  if (Object.hasOwn(row, 'merchant_id')) application.merchantId = row.merchant_id;
  if (Object.hasOwn(row, 'status')) application.status = row.status;
  return application;
}

function assertMerchantAccess(actor, merchantId) {
  if (actor.role !== Roles.PLATFORM_ADMIN && actor.merchantId !== merchantId) {
    throw new AppError('FORBIDDEN', 'Cross-merchant access is not allowed', 403);
  }
}

// Author: 花落. MySQL application management uses scoped rows and MIT licensed transactions.
export class MysqlApplicationRepository {
  constructor(pool) { this.pool = pool; }

  async create(actor, application) {
    assertMerchantAccess(actor, application.merchantId);
    try {
      return await this.#transaction(async (connection) => {
        await this.#requireActiveMerchant(connection, application.merchantId);
        await connection.execute(
          'INSERT INTO applications (id, merchant_id, code, status, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
          [application.id, application.merchantId, application.code, application.status, sqlDate(application.createdAt), JSON.stringify(application)],
        );
        await this.#audit(connection, actor, application.merchantId, 'application.create', 'application', application.id, { code: application.code }, application.createdAt);
        return application;
      });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY' && /uq_applications_merchant_code/i.test(error.message || '')) {
        throw new AppError('APPLICATION_CODE_EXISTS', 'Application code already exists for this merchant', 409);
      }
      throw error;
    }
  }

  async list(actor, merchantId) {
    assertMerchantAccess(actor, merchantId);
    await this.#requireMerchant(merchantId);
    const [rows] = await this.pool.execute(
      'SELECT payload, merchant_id, status FROM applications WHERE merchant_id = ? ORDER BY created_at DESC',
      [merchantId],
    );
    return rows.map(parseApplicationRow);
  }

  async get(actor, appId) {
    const application = await this.#findApplication(appId);
    assertMerchantAccess(actor, application.merchantId);
    return application;
  }

  async getActive(appId) {
    const application = await this.#findApplication(appId);
    if (application.status !== 'active') throw new AppError('APPLICATION_DISABLED', 'Application is disabled', 403);
    await this.#requireActiveMerchantRead(application.merchantId);
    return application;
  }

  async setStatus(actor, appId, status) {
    return this.#transaction(async (connection) => {
      const application = await this.#lockApplication(connection, appId);
      assertMerchantAccess(actor, application.merchantId);
      const now = new Date().toISOString();
      application.status = status;
      application.updatedAt = now;
      await connection.execute('UPDATE applications SET status = ?, payload = ? WHERE id = ?', [application.status, JSON.stringify(application), application.id]);
      if (status === 'disabled') await connection.execute('DELETE FROM client_sessions WHERE app_id = ?', [application.id]);
      await this.#audit(connection, actor, application.merchantId, 'application.status.update', 'application', application.id, { status }, now);
      return application;
    });
  }

  async update(actor, appId, mutate) {
    return this.#transaction(async (connection) => {
      const application = await this.#lockApplication(connection, appId);
      assertMerchantAccess(actor, application.merchantId);
      mutate(application);
      application.updatedAt = new Date().toISOString();
      await connection.execute('UPDATE applications SET payload = ? WHERE id = ?', [JSON.stringify(application), application.id]);
      await this.#audit(connection, actor, application.merchantId, 'application.update', 'application', application.id, {}, application.updatedAt);
      return application;
    });
  }

  async #findApplication(appId) {
    const [rows] = await this.pool.execute('SELECT payload, merchant_id, status FROM applications WHERE id = ?', [appId]);
    if (!rows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    return parseApplicationRow(rows[0]);
  }

  async #lockApplication(connection, appId) {
    const [identityRows] = await connection.execute('SELECT merchant_id FROM applications WHERE id = ?', [appId]);
    if (!identityRows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    await this.#requireActiveMerchant(connection, identityRows[0].merchant_id);
    const [rows] = await connection.execute('SELECT payload, merchant_id, status FROM applications WHERE id = ? FOR UPDATE', [appId]);
    if (!rows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    return parseApplicationRow(rows[0]);
  }

  async #requireMerchant(merchantId) {
    const [rows] = await this.pool.execute('SELECT id FROM merchants WHERE id = ?', [merchantId]);
    if (!rows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
  }

  async #requireActiveMerchantRead(merchantId) {
    const [rows] = await this.pool.execute('SELECT status FROM merchants WHERE id = ?', [merchantId]);
    if (!rows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
    if (rows[0].status !== 'active') throw new AppError('MERCHANT_DISABLED', 'Merchant is disabled', 403);
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
    await connection.execute(
      'INSERT INTO audit_logs (id, merchant_id, actor_id, action, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
      [entry.id, entry.merchantId, entry.actorUserId, entry.action, sqlDate(entry.createdAt), JSON.stringify(entry)],
    );
  }
}
