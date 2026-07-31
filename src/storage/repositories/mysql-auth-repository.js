import { randomUUID } from 'node:crypto';
import { AppError } from '../../core/app-error.js';
import { Roles } from '../../services/access-control.js';

function parsePayload(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function sqlDate(value) { return value ? new Date(value) : null; }

function parseUserRow(row) {
  const user = parsePayload(row.payload);
  if (Object.hasOwn(row, 'merchant_id')) user.merchantId = row.merchant_id ?? null;
  if (Object.hasOwn(row, 'status')) user.status = row.status;
  return user;
}

function assertMerchantAccess(actor, merchantId) {
  if (actor.role !== Roles.PLATFORM_ADMIN && actor.merchantId !== merchantId) {
    throw new AppError('FORBIDDEN', 'Cross-merchant access is not allowed', 403);
  }
}

// Author: 花落. MySQL administrator identity and session operations are MIT licensed.
export class MysqlAuthRepository {
  constructor(pool) { this.pool = pool; }

  async bootstrapPlatformAdmin(user) {
    try {
      return await this.#transaction(async (connection) => {
        // The singleton row serializes first-admin bootstrap without a global MySQL advisory lock.
        await connection.execute('SELECT singleton_id FROM kmxt_meta WHERE singleton_id = 1 FOR UPDATE');
        const [rows] = await connection.execute(
          'SELECT id FROM users WHERE role = ? LIMIT 1 FOR UPDATE',
          [Roles.PLATFORM_ADMIN],
        );
        if (rows[0]) throw new AppError('PLATFORM_ADMIN_EXISTS', 'A platform administrator already exists', 409);
        await this.#insertUser(connection, user);
        await this.#audit(connection, user, null, 'platform_admin.bootstrap', 'user', user.id, {}, user.createdAt);
        return user;
      });
    } catch (error) {
      throw this.#usernameConflict(error);
    }
  }

  async findByUsername(usernameNormalized) {
    const [rows] = await this.pool.execute('SELECT payload, merchant_id, status FROM users WHERE username_normalized = ?', [usernameNormalized]);
    return rows[0] ? parseUserRow(rows[0]) : null;
  }

  async findUser(userId) {
    const [rows] = await this.pool.execute('SELECT payload, merchant_id, status FROM users WHERE id = ?', [userId]);
    return rows[0] ? parseUserRow(rows[0]) : null;
  }

  async createMerchantUser(actor, user) {
    try {
      return await this.#transaction(async (connection) => {
        await this.#requireActiveMerchant(connection, user.merchantId);
        const [existingRows] = await connection.execute(
          'SELECT id FROM users WHERE username_normalized = ? FOR UPDATE',
          [user.usernameNormalized],
        );
        if (existingRows[0]) throw new AppError('USERNAME_EXISTS', 'Username already exists', 409);
        await this.#insertUser(connection, user);
        await this.#audit(connection, actor, user.merchantId, 'merchant_user.create', 'user', user.id, { role: user.role }, user.createdAt);
        return user;
      });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY' && /uq_users_username/i.test(error.message || '')) {
        throw new AppError('USERNAME_EXISTS', 'Username already exists', 409);
      }
      throw error;
    }
  }

  async finalizeLogin(userId, tokenDigest, expiresAt) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [identityRows] = await connection.execute('SELECT merchant_id, status FROM users WHERE id = ?', [userId]);
      if (!identityRows[0] || identityRows[0].status !== 'active') {
        throw new AppError('INVALID_CREDENTIALS', 'Username or password is incorrect', 401);
      }
      if (identityRows[0].merchant_id) await this.#requireActiveMerchant(connection, identityRows[0].merchant_id);
      const [rows] = await connection.execute('SELECT payload, merchant_id, status FROM users WHERE id = ? FOR UPDATE', [userId]);
      const user = rows[0] ? parseUserRow(rows[0]) : null;
      if (!user || rows[0].status !== 'active') throw new AppError('INVALID_CREDENTIALS', 'Username or password is incorrect', 401);
      const now = new Date().toISOString();
      await connection.execute('DELETE FROM admin_sessions WHERE expires_at <= ?', [new Date()]);
      const session = { id: randomUUID(), userId: user.id, tokenDigest, createdAt: now, expiresAt };
      await connection.execute('INSERT INTO admin_sessions (id, user_id, token_digest, expires_at, payload) VALUES (?, ?, ?, ?, ?)', [session.id, session.userId, session.tokenDigest, sqlDate(session.expiresAt), JSON.stringify(session)]);
      user.lastLoginAt = now;
      user.updatedAt = now;
      await connection.execute('UPDATE users SET payload = ? WHERE id = ?', [JSON.stringify(user), user.id]);
      await this.#audit(connection, user, user.merchantId, 'auth.login', 'session', null, {}, now);
      await connection.commit();
      return user;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async authenticate(tokenDigest, now = Date.now()) {
    const [rows] = await this.pool.execute(
      `SELECT u.payload AS user_payload, u.status AS user_status, u.merchant_id, m.status AS merchant_status
       FROM admin_sessions s
       INNER JOIN users u ON u.id = s.user_id
       LEFT JOIN merchants m ON m.id = u.merchant_id
       WHERE s.token_digest = ? AND s.expires_at > ?`,
      [tokenDigest, new Date(now)],
    );
    if (!rows[0]) throw new AppError('UNAUTHORIZED', 'The administrator session is invalid or expired', 401);
    const row = rows[0];
    if (row.user_status !== 'active') throw new AppError('UNAUTHORIZED', 'The administrator account is unavailable', 401);
    if (row.merchant_id && !row.merchant_status) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
    if (row.merchant_id && row.merchant_status !== 'active') throw new AppError('MERCHANT_DISABLED', 'Merchant is disabled', 403);
    const user = parsePayload(row.user_payload);
    user.merchantId = row.merchant_id ?? null;
    user.status = row.user_status;
    return user;
  }

  async logout(actor, tokenDigest) {
    return this.#transaction(async (connection) => {
      await connection.execute('DELETE FROM admin_sessions WHERE token_digest = ?', [tokenDigest]);
      const now = new Date().toISOString();
      await this.#audit(connection, actor, actor.merchantId, 'auth.logout', 'session', null, {}, now);
    });
  }

  async changePassword(actor, expectedHash, passwordHash) {
    return this.#transaction(async (connection) => {
      const [rows] = await connection.execute('SELECT payload, merchant_id, status FROM users WHERE id = ? FOR UPDATE', [actor.id]);
      const user = rows[0] ? parseUserRow(rows[0]) : null;
      if (!user || rows[0].status !== 'active') throw new AppError('UNAUTHORIZED', 'The administrator account is unavailable', 401);
      if (user.passwordHash !== expectedHash) throw new AppError('PASSWORD_CHANGED_RETRY', 'The password was changed by another request', 409);
      const now = new Date().toISOString();
      user.passwordHash = passwordHash;
      user.updatedAt = now;
      await connection.execute('UPDATE users SET payload = ? WHERE id = ?', [JSON.stringify(user), user.id]);
      const [result] = await connection.execute('DELETE FROM admin_sessions WHERE user_id = ?', [user.id]);
      await this.#audit(connection, user, user.merchantId, 'auth.password.change', 'user', user.id, {}, now);
      return { passwordChanged: true, sessionsRevoked: Number(result.affectedRows ?? 0) };
    });
  }

  async resetMerchantUserPassword(actor, userId, expectedHash, passwordHash) {
    return this.#transaction(async (connection) => {
      const [rows] = await connection.execute('SELECT payload, merchant_id, status FROM users WHERE id = ? FOR UPDATE', [userId]);
      const user = rows[0] ? parseUserRow(rows[0]) : null;
      if (!user || !rows[0].merchant_id) throw new AppError('USER_NOT_FOUND', 'Merchant user was not found', 404);
      assertMerchantAccess(actor, user.merchantId);
      if (user.id === actor.id) throw new AppError('USE_SELF_PASSWORD_CHANGE', 'Use the self-service password endpoint', 409);
      if (user.passwordHash !== expectedHash) throw new AppError('PASSWORD_CHANGED_RETRY', 'The password was changed by another request', 409);
      const now = new Date().toISOString();
      user.passwordHash = passwordHash;
      user.updatedAt = now;
      await connection.execute('UPDATE users SET payload = ? WHERE id = ?', [JSON.stringify(user), user.id]);
      const [result] = await connection.execute('DELETE FROM admin_sessions WHERE user_id = ?', [user.id]);
      await this.#audit(connection, actor, user.merchantId, 'merchant_user.password.reset', 'user', user.id, {}, now);
      return { user, sessionsRevoked: Number(result.affectedRows ?? 0) };
    });
  }

  async listMerchantUsers(actor, merchantId) {
    assertMerchantAccess(actor, merchantId);
    const [merchantRows] = await this.pool.execute('SELECT id FROM merchants WHERE id = ?', [merchantId]);
    if (!merchantRows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
    const [rows] = await this.pool.execute('SELECT payload, merchant_id, status FROM users WHERE merchant_id = ? ORDER BY created_at DESC', [merchantId]);
    return rows.map(parseUserRow);
  }

  async setUserStatus(actor, userId, status) {
    return this.#transaction(async (connection) => {
      const [rows] = await connection.execute('SELECT payload, merchant_id, status FROM users WHERE id = ? FOR UPDATE', [userId]);
      const user = rows[0] ? parseUserRow(rows[0]) : null;
      if (!user || !rows[0].merchant_id) throw new AppError('USER_NOT_FOUND', 'Merchant user was not found', 404);
      assertMerchantAccess(actor, user.merchantId);
      if (user.id === actor.id && status === 'disabled') throw new AppError('SELF_DISABLE_FORBIDDEN', 'You cannot disable your own account', 409);
      const now = new Date().toISOString();
      user.status = status;
      user.updatedAt = now;
      await connection.execute('UPDATE users SET status = ?, payload = ? WHERE id = ?', [user.status, JSON.stringify(user), user.id]);
      const sessionsRevoked = status === 'disabled'
        ? Number((await connection.execute('DELETE FROM admin_sessions WHERE user_id = ?', [user.id]))[0].affectedRows ?? 0)
        : 0;
      await this.#audit(connection, actor, user.merchantId, 'merchant_user.status.update', 'user', user.id, { status }, now);
      return { user, sessionsRevoked };
    });
  }

  // Role changes stay inside the operator/merchant_admin pair; the service enum blocks platform_admin.
  async setUserRole(actor, userId, role) {
    return this.#transaction(async (connection) => {
      const [rows] = await connection.execute('SELECT payload, merchant_id, status FROM users WHERE id = ? FOR UPDATE', [userId]);
      const user = rows[0] ? parseUserRow(rows[0]) : null;
      if (!user || !rows[0].merchant_id) throw new AppError('USER_NOT_FOUND', 'Merchant user was not found', 404);
      assertMerchantAccess(actor, user.merchantId);
      if (user.id === actor.id) throw new AppError('SELF_ROLE_FORBIDDEN', 'You cannot change your own role', 409);
      const previousRole = user.role;
      if (previousRole === role) return { user, sessionsRevoked: 0, roleChanged: false };
      const now = new Date().toISOString();
      user.role = role;
      user.updatedAt = now;
      await connection.execute('UPDATE users SET role = ?, payload = ? WHERE id = ?', [user.role, JSON.stringify(user), user.id]);
      const [result] = await connection.execute('DELETE FROM admin_sessions WHERE user_id = ?', [user.id]);
      await this.#audit(connection, actor, user.merchantId, 'merchant_user.role.update', 'user', user.id, { from: previousRole, to: role }, now);
      return { user, sessionsRevoked: Number(result.affectedRows ?? 0), roleChanged: true };
    });
  }

  async #requireActiveMerchant(connection, merchantId) {
    const [rows] = await connection.execute('SELECT status FROM merchants WHERE id = ? FOR UPDATE', [merchantId]);
    if (!rows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
    if (rows[0].status !== 'active') throw new AppError('MERCHANT_DISABLED', 'Merchant is disabled', 403);
  }

  async #insertUser(connection, user) {
    await connection.execute(
      'INSERT INTO users (id, merchant_id, username_normalized, role, status, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [user.id, user.merchantId, user.usernameNormalized, user.role, user.status, sqlDate(user.createdAt), JSON.stringify(user)],
    );
  }

  #usernameConflict(error) {
    if (error?.code === 'ER_DUP_ENTRY' && /uq_users_username/i.test(error.message || '')) {
      return new AppError('USERNAME_EXISTS', 'Username already exists', 409);
    }
    return error;
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
