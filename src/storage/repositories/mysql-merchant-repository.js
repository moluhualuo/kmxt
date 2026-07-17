import { randomUUID } from 'node:crypto';
import { AppError } from '../../core/app-error.js';
import { Roles } from '../../services/access-control.js';

function parsePayload(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function sqlDate(value) { return value ? new Date(value) : null; }

function parseMerchantRow(row) {
  const merchant = parsePayload(row.payload);
  if (Object.hasOwn(row, 'status')) merchant.status = row.status;
  return merchant;
}

function assertPlatformAdmin(actor) {
  if (actor.role !== Roles.PLATFORM_ADMIN) {
    throw new AppError('FORBIDDEN', 'You do not have permission to perform this action', 403);
  }
}

function assertMerchantAccess(actor, merchantId) {
  if (actor.role !== Roles.PLATFORM_ADMIN && actor.merchantId !== merchantId) {
    throw new AppError('FORBIDDEN', 'Cross-merchant access is not allowed', 403);
  }
}

// Author: 花落. MySQL merchant management transactions are provided under the MIT License.
export class MysqlMerchantRepository {
  constructor(pool) { this.pool = pool; }

  async create(actor, merchant) {
    assertPlatformAdmin(actor);
    try {
      return await this.#transaction(async (connection) => {
        await connection.execute(
          'INSERT INTO merchants (id, code, status, created_at, payload) VALUES (?, ?, ?, ?, ?)',
          [merchant.id, merchant.code, merchant.status, sqlDate(merchant.createdAt), JSON.stringify(merchant)],
        );
        await this.#audit(connection, actor, merchant.id, 'merchant.create', 'merchant', merchant.id, { code: merchant.code }, merchant.createdAt);
        return merchant;
      });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY' && /uq_merchants_code/i.test(error.message || '')) {
        throw new AppError('MERCHANT_CODE_EXISTS', 'Merchant code already exists', 409);
      }
      throw error;
    }
  }

  async list(actor) {
    assertPlatformAdmin(actor);
    const [rows] = await this.pool.execute('SELECT payload, status FROM merchants ORDER BY created_at DESC');
    return rows.map(parseMerchantRow);
  }

  async get(actor, merchantId) {
    const [rows] = await this.pool.execute('SELECT payload, status FROM merchants WHERE id = ?', [merchantId]);
    if (!rows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
    const merchant = parseMerchantRow(rows[0]);
    assertMerchantAccess(actor, merchant.id);
    return merchant;
  }

  async setStatus(actor, merchantId, status) {
    assertPlatformAdmin(actor);
    return this.#transaction(async (connection) => {
      const [rows] = await connection.execute('SELECT payload, status FROM merchants WHERE id = ? FOR UPDATE', [merchantId]);
      if (!rows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
      const merchant = parseMerchantRow(rows[0]);
      const now = new Date().toISOString();
      merchant.status = status;
      merchant.updatedAt = now;
      await connection.execute('UPDATE merchants SET status = ?, payload = ? WHERE id = ?', [merchant.status, JSON.stringify(merchant), merchant.id]);
      if (status === 'disabled') {
        await connection.execute(
          'DELETE sessions FROM admin_sessions AS sessions INNER JOIN users AS users ON users.id = sessions.user_id WHERE users.merchant_id = ?',
          [merchant.id],
        );
        await connection.execute('DELETE FROM client_sessions WHERE merchant_id = ?', [merchant.id]);
      }
      await this.#audit(connection, actor, merchant.id, 'merchant.status.update', 'merchant', merchant.id, { status }, now);
      return merchant;
    });
  }

  async update(actor, merchantId, name) {
    assertPlatformAdmin(actor);
    return this.#transaction(async (connection) => {
      const [rows] = await connection.execute('SELECT payload, status FROM merchants WHERE id = ? FOR UPDATE', [merchantId]);
      if (!rows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
      const merchant = parseMerchantRow(rows[0]);
      const now = new Date().toISOString();
      merchant.name = name;
      merchant.updatedAt = now;
      await connection.execute('UPDATE merchants SET payload = ? WHERE id = ?', [JSON.stringify(merchant), merchant.id]);
      await this.#audit(connection, actor, merchant.id, 'merchant.update', 'merchant', merchant.id, { name }, now);
      return merchant;
    });
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
