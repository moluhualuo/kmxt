import assert from 'node:assert/strict';
import test from 'node:test';
import { MysqlDashboardRepository } from '../src/storage/repositories/mysql-dashboard-repository.js';
import { MysqlOrderRepository } from '../src/storage/repositories/mysql-order-repository.js';
import { MysqlVerificationRepository } from '../src/storage/repositories/mysql-verification-repository.js';
import { MysqlLicenseRepository } from '../src/storage/repositories/mysql-license-repository.js';
import { MysqlAuthRepository } from '../src/storage/repositories/mysql-auth-repository.js';
import { MysqlMerchantRepository } from '../src/storage/repositories/mysql-merchant-repository.js';
import { MysqlApplicationRepository } from '../src/storage/repositories/mysql-application-repository.js';
import { MysqlProductRepository } from '../src/storage/repositories/mysql-product-repository.js';
import { MysqlAuditRepository } from '../src/storage/repositories/mysql-audit-repository.js';
import { MysqlMaintenanceRepository } from '../src/storage/repositories/mysql-maintenance-repository.js';
import { MysqlOnlineDeviceRepository } from '../src/storage/repositories/mysql-online-device-repository.js';
import { MysqlStore } from '../src/storage/mysql-store.js';
import { AuthService } from '../src/services/auth-service.js';
import { LicenseService } from '../src/services/license-service.js';
import { OrderService } from '../src/services/order-service.js';
import { MaintenanceService } from '../src/services/maintenance-service.js';
import { digestSecret, encryptText, hashPassword } from '../src/security/crypto.js';

test('MySQL dashboard repository counts LICENSE_VALID activation and verification records', async () => {
  const calls = [];
  const results = [
    [[{ id: 'merchant-1' }]],
    [[{ total: 1 }]], [[{ total: 2 }]], [[{ total: 3 }]], [[{ total: 4 }]], [[{ total: 5 }]], [[{ total: 6, successful: 4 }]],
  ];
  const pool = { async execute(sql, values) { calls.push({ sql, values }); return results.shift(); } };
  const repository = new MysqlDashboardRepository(pool);
  const result = await repository.get({ role: 'merchant_admin', merchantId: 'merchant-1' }, {});
  assert.deepEqual(result, { merchants: 1, applications: 2, pendingOrders: 3, licenses: 4, activeBindings: 5, verification24h: { total: 6, successful: 4, failed: 2 } });
  assert.equal(calls.length, 7);
  assert.ok(calls.every((call) => !/payload/i.test(call.sql)));
  assert.ok(calls.some((call) => /orders WHERE merchant_id = \? AND status = 'pending'/.test(call.sql)));
  const verificationCall = calls.find((call) => call.sql.includes('FROM verification_logs'));
  assert.match(verificationCall.sql, /SUM\(result_code = \?\)/);
  assert.match(verificationCall.sql, /event IN \(\?, \?\)/);
  assert.deepEqual(verificationCall.values.slice(0, -1), ['LICENSE_VALID', 'merchant-1', 'activate', 'verify']);
  assert.equal(verificationCall.values.at(-1) instanceof Date, true);
});

test('MySQL online-device repository scopes presence and returns safe device metadata', async () => {
  const calls = [];
  const application = { id: 'app-1', merchantId: 'merchant-1', settings: { heartbeatSeconds: 90 } };
  const binding = {
    id: 'binding-1', merchantId: 'merchant-1', appId: 'app-1', licenseId: 'license-1',
    deviceLabel: 'Primary PC', status: 'active', boundAt: '2026-07-18T00:00:00.000Z',
    lastVerifiedAt: '2026-07-18T00:10:00.000Z', lastClientVersion: '1.2.3', lastIpAddress: '127.0.0.1',
  };
  const license = { id: 'license-1', keyPreview: 'KMXT-APP-****-1234' };
  const session = { bindingId: 'binding-1', lastVerifiedAt: '2026-07-18T00:10:00.000Z', expiresAt: '2026-07-18T00:30:00.000Z', clientVersion: '1.2.3', ipAddress: '127.0.0.1' };
  const pool = {
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT payload, merchant_id FROM applications')) {
        return [[{ payload: JSON.stringify(application), merchant_id: 'merchant-1' }]];
      }
      if (sql.includes('SUM(CASE WHEN')) return [[{ total: 2, online: 1 }]];
      if (sql.startsWith('SELECT COUNT(*) AS total FROM device_bindings')) return [[{ total: 1 }]];
      if (sql.startsWith('SELECT db.payload AS binding_payload')) {
        return [[{ binding_payload: JSON.stringify(binding), license_payload: JSON.stringify(license), session_payload: JSON.stringify(session) }]];
      }
      return [[]];
    },
  };
  const repository = new MysqlOnlineDeviceRepository(pool);
  const result = await repository.list(
    { role: 'merchant_admin', merchantId: 'merchant-1' },
    'app-1',
    { page: 1, limit: 20, offset: 0 },
    { status: 'online', search: 'primary', nowMilliseconds: Date.parse('2026-07-18T00:11:00.000Z'), fallbackHeartbeatSeconds: 300 },
  );
  assert.deepEqual(result.summary, { total: 2, online: 1, offline: 1, onlineWindowSeconds: 180 });
  assert.equal(result.items[0].online, true);
  assert.equal(result.items[0].deviceLabel, 'Primary PC');
  assert.equal(result.items[0].licenseKeyPreview, 'KMXT-APP-****-1234');
  assert.ok(calls.some((call) => /client_sessions filtered_session/.test(call.sql)));
  assert.ok(calls.every((call) => !String(call.sql).includes('device_digest')));
});

test('MySQL verification repository self-unbinds only the matching active device session', async () => {
  const calls = [];
  const application = { id: 'app-1', merchantId: 'merchant-1', settings: { heartbeatSeconds: 300 } };
  const session = { id: 'session-1', appId: 'app-1', bindingId: 'binding-1', expiresAt: '2026-07-18T01:00:00.000Z' };
  const binding = { id: 'binding-1', merchantId: 'merchant-1', appId: 'app-1', licenseId: 'license-1', deviceDigest: 'device-digest', status: 'active', boundAt: '2026-07-18T00:00:00.000Z' };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT merchant_id FROM applications')) return [[{ merchant_id: 'merchant-1' }]];
      if (sql.startsWith('SELECT status FROM merchants')) return [[{ status: 'active' }]];
      if (sql.startsWith('SELECT payload, status FROM applications')) return [[{ payload: JSON.stringify(application), status: 'active' }]];
      if (sql.startsWith('SELECT payload FROM client_sessions')) return [[{ payload: JSON.stringify(session) }]];
      if (sql.startsWith('SELECT payload FROM device_bindings')) return [[{ payload: JSON.stringify(binding) }]];
      if (sql.startsWith('DELETE FROM client_sessions')) return [{ affectedRows: 1 }];
      return [[]];
    },
  };
  const repository = new MysqlVerificationRepository({ async getConnection() { return connection; } });
  const result = await repository.unbind({
    appId: 'app-1', sessionDigest: 'session-digest', deviceDigest: 'device-digest',
    clientVersion: '1.0.0', clientIp: '127.0.0.1',
    nowMilliseconds: Date.parse('2026-07-18T00:10:00.000Z'), now: '2026-07-18T00:10:00.000Z',
  });
  assert.equal(result.bindingId, 'binding-1');
  assert.equal(result.sessionsRevoked, 1);
  assert.equal(JSON.parse(calls.find((call) => call.sql.startsWith('UPDATE device_bindings')).values[1]).status, 'revoked');
  assert.ok(calls.some((call) => call.sql.startsWith('DELETE FROM client_sessions')));
  assert.ok(calls.some((call) => call.sql.startsWith('INSERT INTO verification_logs')));
});

test('MySQL activation locks the license and skips device counting for unlimited licenses', async () => {
  const calls = [];
  const application = { id: 'app-1', merchantId: 'merchant-1', settings: { heartbeatSeconds: 300, offlineGraceSeconds: 900 } };
  const license = { id: 'license-1', merchantId: 'merchant-1', appId: 'app-1', status: 'pending', activatedAt: null, expiresAt: null, durationDays: 30, maxDevices: 0 };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT merchant_id FROM applications')) return [[{ merchant_id: 'merchant-1' }]];
      if (sql.startsWith('SELECT payload, status FROM applications')) return [[{ payload: JSON.stringify(application), status: 'active' }]];
      if (sql.startsWith('SELECT status FROM merchants')) return [[{ status: 'active' }]];
      if (sql.startsWith('SELECT payload FROM licenses WHERE app_id')) return [[{ payload: JSON.stringify(license) }]];
      if (sql.startsWith('SELECT payload FROM device_bindings')) return [[]];
      return [[]];
    },
  };
  const repository = new MysqlVerificationRepository({ async getConnection() { return connection; } });
  const result = await repository.activate({
    appId: 'app-1', licenseDigest: 'license-digest', deviceDigest: 'device-digest', deviceLabel: 'Desktop', clientVersion: '1.0.0',
    sessionDigest: 'session-digest', nowMilliseconds: Date.parse('2026-07-15T00:00:00.000Z'), now: '2026-07-15T00:00:00.000Z', clientSessionTtlSeconds: 1800,
  });
  assert.equal(result.licenseId, 'license-1');
  assert.ok(calls.some((call) => call.sql === 'SELECT payload FROM licenses WHERE app_id = ? AND key_digest = ? FOR UPDATE'));
  assert.ok(calls.some((call) => /INSERT INTO client_sessions/.test(call.sql)));
  assert.ok(calls.some((call) => /INSERT INTO verification_logs/.test(call.sql)));
  assert.equal(calls.some((call) => /COUNT\(\*\).*device_bindings/.test(call.sql)), false);
});

test('MySQL order repository scopes pagination and locks only the reviewed order for fulfillment', async () => {
  const calls = [];
  const pendingOrder = { id: 'order-1', orderNo: 'KMO-20260715-ABC', merchantId: 'merchant-1', appId: 'app-1', productSnapshot: { durationDays: 30, maxDevices: 1 }, status: 'pending' };
  const merchant = { id: 'merchant-1', status: 'active' };
  const application = { id: 'app-1', status: 'active', code: 'APP' };
  const pool = {
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql === 'SELECT id FROM merchants WHERE id = ?') return [[{ id: 'merchant-1' }]];
      if (sql.startsWith('SELECT COUNT(*)')) return [[{ total: 1 }]];
      if (sql.startsWith('SELECT payload FROM orders')) return [[{ payload: JSON.stringify(pendingOrder) }]];
      return [[]];
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async execute(sql, values) {
          calls.push({ sql, values });
          if (sql.startsWith('SELECT payload FROM orders')) return [[{ payload: JSON.stringify(pendingOrder) }]];
          if (sql.startsWith('SELECT payload, status FROM merchants')) return [[{ payload: JSON.stringify(merchant), status: 'active' }]];
          if (sql.startsWith('SELECT payload, status FROM applications')) return [[{ payload: JSON.stringify(application), status: 'active' }]];
          return [[]];
        },
      };
    },
  };
  const repository = new MysqlOrderRepository(pool);
  const list = await repository.list('merchant-1', { page: 1, limit: 20, offset: 0 }, { status: 'pending', orderNo: 'KMO', from: null, to: null });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].id, 'order-1');
  const fulfilled = await repository.fulfill({ id: 'user-1', username: 'owner', role: 'merchant_admin', merchantId: 'merchant-1' }, 'order-1', () => ({
    now: '2026-07-15T00:00:00.000Z', licenseKeyEncrypted: 'encrypted-key',
    batch: { id: 'batch-1', merchantId: 'merchant-1', appId: 'app-1', sourceId: 'order-1', createdAt: '2026-07-15T00:00:00.000Z' },
    license: { id: 'license-1', merchantId: 'merchant-1', appId: 'app-1', batchId: 'batch-1', keyDigest: 'digest', status: 'pending', expiresAt: null, createdAt: '2026-07-15T00:00:00.000Z' },
  }));
  assert.equal(fulfilled.licenseId, 'license-1');
  assert.ok(calls.some((call) => call.sql === 'SELECT payload FROM orders WHERE id = ? FOR UPDATE'));
  assert.ok(calls.some((call) => /INSERT INTO license_batches/.test(call.sql) && call.values.includes('order-1')));
  assert.ok(calls.some((call) => /UPDATE orders SET license_id/.test(call.sql)));
});

test('MySQL license disable locks the license and revokes its client sessions', async () => {
  const calls = [];
  const license = { id: 'license-1', merchantId: 'merchant-1', status: 'active', activatedAt: '2026-07-01T00:00:00.000Z', expiresAt: '2026-08-01T00:00:00.000Z' };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql === 'SELECT merchant_id FROM licenses WHERE id = ?') return [[{ merchant_id: 'merchant-1' }]];
      if (sql === 'SELECT payload FROM licenses WHERE id = ? FOR UPDATE') return [[{ payload: JSON.stringify(license) }]];
      if (sql.startsWith('SELECT status FROM merchants')) return [[{ status: 'active' }]];
      return [[]];
    },
  };
  const repository = new MysqlLicenseRepository({ async getConnection() { return connection; } });
  const result = await repository.setStatus({ id: 'user-1', username: 'owner', role: 'merchant_admin', merchantId: 'merchant-1' }, 'license-1', 'disabled', Date.parse('2026-07-15T00:00:00.000Z'));
  assert.equal(result.status, 'disabled');
  assert.ok(calls.some((call) => call.sql === 'DELETE FROM client_sessions WHERE license_id = ?'));
  assert.ok(calls.some((call) => /INSERT INTO audit_logs/.test(call.sql)));
  assert.ok(calls.findIndex((call) => call.sql === 'SELECT status FROM merchants WHERE id = ? FOR UPDATE')
    < calls.findIndex((call) => call.sql === 'SELECT payload FROM licenses WHERE id = ? FOR UPDATE'));
});

test('MySQL license key reveal audits without storing plaintext and deletion clears dependent records', async () => {
  const calls = [];
  const license = { id: 'license-1', merchantId: 'merchant-1', appId: 'app-1', keyEncrypted: null };
  const order = { id: 'order-1', licenseId: license.id, licenseKeyEncrypted: 'legacy-order-ciphertext' };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql === 'SELECT payload FROM licenses WHERE id = ? FOR UPDATE') return [[{ payload: JSON.stringify(license) }]];
      if (sql === 'SELECT payload FROM orders WHERE license_id = ? FOR UPDATE') return [[{ payload: JSON.stringify(order) }]];
      if (sql === 'SELECT id FROM orders WHERE license_id = ? FOR UPDATE') return [[]];
      if (sql === 'DELETE FROM device_bindings WHERE license_id = ?') return [{ affectedRows: 2 }];
      return [[]];
    },
  };
  const repository = new MysqlLicenseRepository({ async getConnection() { return connection; } });
  const actor = { id: 'owner-1', username: 'owner', role: 'merchant_admin', merchantId: 'merchant-1' };
  const revealed = await repository.reveal(actor, license.id, (currentLicense, currentOrder) => {
    assert.equal(currentLicense.id, license.id);
    assert.equal(currentOrder.id, order.id);
    return 'KMXT-APP-SECRET-KEY';
  });
  assert.deepEqual(revealed, { licenseId: license.id, key: 'KMXT-APP-SECRET-KEY' });
  const deleted = await repository.delete(actor, license.id);
  assert.deepEqual(deleted, { licenseId: license.id, deletedBindings: 2 });
  assert.ok(calls.some((call) => call.sql === 'DELETE FROM client_sessions WHERE license_id = ?'));
  assert.ok(calls.some((call) => call.sql === 'DELETE FROM verification_logs WHERE license_id = ?'));
  assert.ok(calls.some((call) => call.sql === 'DELETE FROM device_bindings WHERE license_id = ?'));
  assert.ok(calls.some((call) => call.sql === 'DELETE FROM licenses WHERE id = ?'));
  const auditValues = calls.filter((call) => /INSERT INTO audit_logs/.test(call.sql)).map((call) => call.values[5]);
  assert.equal(auditValues.some((payload) => payload.includes('KMXT-APP-SECRET-KEY')), false);
  assert.equal(auditValues.some((payload) => payload.includes('license.key.reveal')), true);
  assert.equal(auditValues.some((payload) => payload.includes('license.delete')), true);
});

test('MySQL auth repository locks a user and revokes all admin sessions when it is disabled', async () => {
  const calls = [];
  const user = {
    id: 'user-1', merchantId: 'merchant-1', username: 'operator', usernameNormalized: 'operator', displayName: 'Operator',
    passwordHash: 'scrypt$invalid$invalid', role: 'operator', status: 'active', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z', lastLoginAt: null,
  };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT payload, merchant_id, status FROM users')) {
        return [[{ payload: JSON.stringify(user), merchant_id: 'merchant-1', status: 'active' }]];
      }
      if (sql.startsWith('DELETE FROM admin_sessions')) return [{ affectedRows: 2 }];
      return [[]];
    },
  };
  const repository = new MysqlAuthRepository({ async getConnection() { return connection; } });
  const result = await repository.setUserStatus(
    { id: 'owner-1', username: 'owner', role: 'merchant_admin', merchantId: 'merchant-1' },
    user.id,
    'disabled',
  );
  assert.equal(result.user.status, 'disabled');
  assert.equal(result.sessionsRevoked, 2);
  assert.ok(calls.some((call) => call.sql === 'SELECT payload, merchant_id, status FROM users WHERE id = ? FOR UPDATE'));
  assert.ok(calls.some((call) => call.sql === 'DELETE FROM admin_sessions WHERE user_id = ?'));
  assert.ok(calls.some((call) => /UPDATE users SET status = \?, payload = \? WHERE id = \?/.test(call.sql)));
});

// 花落 / MIT：角色变更必须同时改 role 列与 payload，并撤销该账号全部管理会话。
test('MySQL auth repository updates the role column and revokes sessions when the role changes', async () => {
  const calls = [];
  const user = {
    id: 'user-1', merchantId: 'merchant-1', username: 'operator', usernameNormalized: 'operator', displayName: 'Operator',
    passwordHash: 'scrypt$invalid$invalid', role: 'operator', status: 'active', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z', lastLoginAt: null,
  };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT payload, merchant_id, status FROM users')) {
        return [[{ payload: JSON.stringify(user), merchant_id: 'merchant-1', status: 'active' }]];
      }
      if (sql.startsWith('DELETE FROM admin_sessions')) return [{ affectedRows: 3 }];
      return [[]];
    },
  };
  const repository = new MysqlAuthRepository({ async getConnection() { return connection; } });
  const actor = { id: 'owner-1', username: 'owner', role: 'merchant_admin', merchantId: 'merchant-1' };
  const promoted = await repository.setUserRole(actor, user.id, 'merchant_admin');
  assert.equal(promoted.user.role, 'merchant_admin');
  assert.equal(promoted.roleChanged, true);
  assert.equal(promoted.sessionsRevoked, 3);
  assert.ok(calls.some((call) => call.sql === 'SELECT payload, merchant_id, status FROM users WHERE id = ? FOR UPDATE'));
  assert.ok(calls.some((call) => call.sql === 'UPDATE users SET role = ?, payload = ? WHERE id = ?'));
  assert.ok(calls.some((call) => call.sql === 'DELETE FROM admin_sessions WHERE user_id = ?'));
  const auditPayloads = calls.filter((call) => /INSERT INTO audit_logs/.test(call.sql)).map((call) => call.values[5]);
  assert.equal(auditPayloads.some((payload) => payload.includes('merchant_user.role.update')), true);
  assert.equal(auditPayloads.some((payload) => payload.includes('"from":"operator"')), true);

  await assert.rejects(
    () => repository.setUserRole({ id: 'owner-2', username: 'other', role: 'merchant_admin', merchantId: 'merchant-2' }, user.id, 'operator'),
    (error) => error.code === 'FORBIDDEN',
  );
  await assert.rejects(
    () => repository.setUserRole({ id: user.id, username: 'operator', role: 'merchant_admin', merchantId: 'merchant-1' }, user.id, 'operator'),
    (error) => error.code === 'SELF_ROLE_FORBIDDEN',
  );
  const writesBefore = calls.filter((call) => /^UPDATE users SET role/.test(call.sql)).length;
  const unchanged = await repository.setUserRole(actor, user.id, user.role);
  assert.equal(unchanged.roleChanged, false);
  assert.equal(unchanged.sessionsRevoked, 0);
  assert.equal(calls.filter((call) => /^UPDATE users SET role/.test(call.sql)).length, writesBefore);
});

test('MySQL login locks the merchant before the administrator account', async () => {
  const calls = [];
  const user = { id: 'user-1', merchantId: 'merchant-1', username: 'owner', usernameNormalized: 'owner', displayName: 'Owner', passwordHash: 'hash', role: 'merchant_admin', status: 'active', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z', lastLoginAt: null };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql === 'SELECT merchant_id, status FROM users WHERE id = ?') return [[{ merchant_id: 'merchant-1', status: 'active' }]];
      if (sql === 'SELECT status FROM merchants WHERE id = ? FOR UPDATE') return [[{ status: 'active' }]];
      if (sql === 'SELECT payload, merchant_id, status FROM users WHERE id = ? FOR UPDATE') return [[{ payload: JSON.stringify(user), merchant_id: 'merchant-1', status: 'active' }]];
      return [[]];
    },
  };
  const repository = new MysqlAuthRepository({ async getConnection() { return connection; } });
  const result = await repository.finalizeLogin(user.id, 'session-digest', '2026-07-15T01:00:00.000Z');
  assert.equal(result.id, user.id);
  assert.ok(calls.findIndex((call) => call.sql === 'SELECT status FROM merchants WHERE id = ? FOR UPDATE')
    < calls.findIndex((call) => call.sql === 'SELECT payload, merchant_id, status FROM users WHERE id = ? FOR UPDATE'));
});

test('AuthService uses the MySQL auth repository for login, session validation, and logout', async () => {
  const password = 'Repository-Password!';
  const user = {
    id: 'user-1', merchantId: null, username: 'platform', usernameNormalized: 'platform', displayName: 'Platform',
    passwordHash: await hashPassword(password), role: 'platform_admin', status: 'active', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z', lastLoginAt: null,
  };
  const calls = [];
  const repository = {
    async findByUsername(username) { calls.push(`find:${username}`); return user; },
    async finalizeLogin(userId, tokenDigest, expiresAt) {
      calls.push(`finalize:${userId}:${Boolean(tokenDigest)}:${Boolean(expiresAt)}`);
      return { ...user, lastLoginAt: '2026-07-15T01:00:00.000Z' };
    },
    async authenticate(tokenDigest) { calls.push(`authenticate:${Boolean(tokenDigest)}`); return user; },
    async logout(actor, tokenDigest) { calls.push(`logout:${actor.id}:${Boolean(tokenDigest)}`); },
  };
  const securityState = {
    async incrementRate() { calls.push('rate:increment'); return { count: 1, retryAfter: 0 }; },
    async clearRate() { calls.push('rate:clear'); },
  };
  const store = {
    repositories: { auth: repository },
    async read() { throw new Error('MySQL auth path must not load the StateStore'); },
    async transaction() { throw new Error('MySQL auth path must not write through the StateStore'); },
  };
  const service = new AuthService(store, Buffer.alloc(32, 9), { adminSessionTtlSeconds: 3600 }, securityState);
  const login = await service.login({ username: 'platform', password });
  assert.equal(login.user.id, user.id);
  assert.equal(login.user.passwordHash, undefined);
  const authenticated = await service.authenticate(login.token);
  assert.equal(authenticated.username, user.username);
  await service.logout(authenticated, login.token);
  assert.deepEqual(calls.map((call) => call.split(':').slice(0, 2).join(':')), [
    'rate:increment', 'find:platform', 'finalize:user-1', 'rate:clear', 'authenticate:true', 'logout:user-1',
  ]);
});

test('MySQL merchant disable locks the merchant and revokes management and client sessions', async () => {
  const calls = [];
  const merchant = { id: 'merchant-1', code: 'MERCHANT_1', name: 'Merchant', status: 'active', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z' };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql === 'SELECT payload, status FROM merchants WHERE id = ? FOR UPDATE') {
        return [[{ payload: JSON.stringify(merchant), status: 'active' }]];
      }
      return [[]];
    },
  };
  const repository = new MysqlMerchantRepository({ async getConnection() { return connection; } });
  const result = await repository.setStatus({ id: 'platform-1', username: 'platform', role: 'platform_admin', merchantId: null }, merchant.id, 'disabled');
  assert.equal(result.status, 'disabled');
  assert.ok(calls.some((call) => /DELETE sessions FROM admin_sessions/.test(call.sql)));
  assert.ok(calls.some((call) => call.sql === 'DELETE FROM client_sessions WHERE merchant_id = ?'));
  assert.ok(calls.some((call) => /UPDATE merchants SET status = \?, payload = \? WHERE id = \?/.test(call.sql)));
});

test('MySQL application disable locks the application and revokes its client sessions', async () => {
  const calls = [];
  const application = {
    id: 'app-1', merchantId: 'merchant-1', code: 'APP_1', name: 'App', description: null, status: 'active',
    settings: { defaultDurationDays: 30, defaultMaxDevices: 1, heartbeatSeconds: 300, offlineGraceSeconds: 900 },
    createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z',
  };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql === 'SELECT merchant_id FROM applications WHERE id = ?') return [[{ merchant_id: 'merchant-1' }]];
      if (sql === 'SELECT payload, merchant_id, status FROM applications WHERE id = ? FOR UPDATE') {
        return [[{ payload: JSON.stringify(application), merchant_id: 'merchant-1', status: 'active' }]];
      }
      if (sql === 'SELECT status FROM merchants WHERE id = ? FOR UPDATE') return [[{ status: 'active' }]];
      return [[]];
    },
  };
  const repository = new MysqlApplicationRepository({ async getConnection() { return connection; } });
  const result = await repository.setStatus({ id: 'owner-1', username: 'owner', role: 'merchant_admin', merchantId: 'merchant-1' }, application.id, 'disabled');
  assert.equal(result.status, 'disabled');
  assert.ok(calls.some((call) => call.sql === 'DELETE FROM client_sessions WHERE app_id = ?'));
  assert.ok(calls.some((call) => /UPDATE applications SET status = \?, payload = \? WHERE id = \?/.test(call.sql)));
  assert.ok(calls.findIndex((call) => call.sql === 'SELECT status FROM merchants WHERE id = ? FOR UPDATE')
    < calls.findIndex((call) => call.sql === 'SELECT payload, merchant_id, status FROM applications WHERE id = ? FOR UPDATE'));
});

test('MySQL storefront reads only the active merchant, applications, and products in display order', async () => {
  const merchant = { id: 'merchant-1', code: 'MERCHANT_1', name: 'Merchant', status: 'active' };
  const application = { id: 'app-1', code: 'APP_1', name: 'App', status: 'active' };
  const later = { id: 'product-2', appId: 'app-1', name: 'Later', status: 'active', sortOrder: 10, createdAt: '2026-07-15T01:00:00.000Z', currency: 'CNY', priceCents: 100, durationDays: 30, maxDevices: 1 };
  const earlier = { id: 'product-1', appId: 'app-1', name: 'Earlier', status: 'active', sortOrder: 10, createdAt: '2026-07-15T00:00:00.000Z', currency: 'CNY', priceCents: 100, durationDays: 30, maxDevices: 1 };
  const calls = [];
  const pool = {
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql === 'SELECT payload, status FROM merchants WHERE code = ?') return [[{ payload: JSON.stringify(merchant), status: 'active' }]];
      return [[
        { product_payload: JSON.stringify(later), application_payload: JSON.stringify(application) },
        { product_payload: JSON.stringify(earlier), application_payload: JSON.stringify(application) },
      ]];
    },
  };
  const repository = new MysqlProductRepository(pool);
  const result = await repository.getPublicStore('MERCHANT_1');
  assert.deepEqual(result.merchant, { code: 'MERCHANT_1', name: 'Merchant' });
  assert.deepEqual(result.products.map((product) => product.name), ['Earlier', 'Later']);
  assert.ok(calls.some((call) => /FROM products AS p/.test(call.sql) && /p.status = 'active'/.test(call.sql)));
});

test('MySQL license batch generation locks its application and persists only digests', async () => {
  const calls = [];
  const application = { id: 'app-1', merchantId: 'merchant-1', code: 'APP_1', status: 'active', settings: { defaultDurationDays: 30, defaultMaxDevices: 1 } };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql === 'SELECT merchant_id FROM applications WHERE id = ?') return [[{ merchant_id: 'merchant-1' }]];
      if (sql === 'SELECT payload, merchant_id, status FROM applications WHERE id = ? FOR UPDATE') {
        return [[{ payload: JSON.stringify(application), merchant_id: 'merchant-1', status: 'active' }]];
      }
      if (sql === 'SELECT status FROM merchants WHERE id = ? FOR UPDATE') return [[{ status: 'active' }]];
      return [[]];
    },
  };
  const repository = new MysqlLicenseRepository({ async getConnection() { return connection; } });
  const result = await repository.generate(
    { id: 'owner-1', username: 'owner', role: 'merchant_admin', merchantId: 'merchant-1' },
    application.id,
    () => ({
      batch: { id: 'batch-1', merchantId: 'merchant-1', appId: 'app-1', count: 1, durationDays: 30, fixedExpiresAt: null, maxDevices: 1, createdAt: '2026-07-15T00:00:00.000Z' },
      licenses: [{ id: 'license-1', merchantId: 'merchant-1', appId: 'app-1', batchId: 'batch-1', keyDigest: 'digest-only', keyPreview: 'KMXT-APP-****-****-ABCDE', status: 'pending', durationDays: 30, fixedExpiresAt: null, activatedAt: null, expiresAt: null, maxDevices: 1, createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z' }],
      generated: [{ key: 'KMXT-APP-SECRET' }],
    }),
  );
  assert.equal(result.licenses[0].keyDigest, 'digest-only');
  assert.ok(calls.some((call) => /INSERT INTO license_batches/.test(call.sql)));
  assert.ok(calls.some((call) => /INSERT INTO licenses/.test(call.sql) && call.values.includes('digest-only')));
  assert.equal(calls.some((call) => JSON.stringify(call.values).includes('KMXT-APP-SECRET')), false);
  assert.ok(calls.findIndex((call) => call.sql === 'SELECT status FROM merchants WHERE id = ? FOR UPDATE')
    < calls.findIndex((call) => call.sql === 'SELECT payload, merchant_id, status FROM applications WHERE id = ? FOR UPDATE'));
});

test('MySQL bulk unbind locks a license, revokes every active binding, and clears its sessions', async () => {
  const calls = [];
  const license = { id: 'license-1', merchantId: 'merchant-1', appId: 'app-1' };
  const bindings = [
    { id: 'binding-1', merchantId: 'merchant-1', appId: 'app-1', licenseId: 'license-1', status: 'active' },
    { id: 'binding-2', merchantId: 'merchant-1', appId: 'app-1', licenseId: 'license-1', status: 'active' },
  ];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql === 'SELECT payload FROM licenses WHERE id = ? FOR UPDATE') return [[{ payload: JSON.stringify(license) }]];
      if (sql === "SELECT payload FROM device_bindings WHERE license_id = ? AND status = 'active' FOR UPDATE") {
        return [bindings.map((binding) => ({ payload: JSON.stringify(binding) }))];
      }
      return [[]];
    },
  };
  const repository = new MysqlLicenseRepository({ async getConnection() { return connection; } });
  const result = await repository.unbindAll(
    { id: 'owner-1', username: 'owner', role: 'merchant_admin', merchantId: 'merchant-1' },
    license.id,
  );
  assert.deepEqual(result, { licenseId: license.id, unboundCount: 2 });
  assert.equal(calls.filter((call) => call.sql === 'UPDATE device_bindings SET status = ?, payload = ? WHERE id = ?').length, 2);
  assert.ok(calls.some((call) => call.sql === 'DELETE FROM client_sessions WHERE license_id = ?' && call.values[0] === license.id));
  const auditCall = calls.find((call) => /INSERT INTO audit_logs/.test(call.sql));
  assert.ok(auditCall);
  assert.match(auditCall.values[5], /license\.devices\.unbind_all/);
  assert.match(auditCall.values[5], /"unboundCount":2/);
});

test('LicenseService returns plaintext batch keys without exposing their digests', async () => {
  const application = { id: 'app-1', merchantId: 'merchant-1', code: 'APP_1', settings: { defaultDurationDays: 30, defaultMaxDevices: 1 } };
  const repository = {
    async generate(_actor, _appId, createArtifacts) { return createArtifacts(application); },
  };
  const store = {
    repositories: { licenses: repository },
    async read() { throw new Error('MySQL generation must not load the StateStore'); },
    async transaction() { throw new Error('MySQL generation must not write through the StateStore'); },
  };
  const service = new LicenseService(store, Buffer.alloc(32, 4), { maxLicenseBatch: 10 });
  const result = await service.generate(
    { id: 'owner-1', username: 'owner', role: 'merchant_admin', merchantId: 'merchant-1' },
    application.id,
    { count: 1, durationDays: 7 },
  );
  assert.equal(result.batch.count, 1);
  assert.match(result.licenses[0].key, /^KMXT-APP1-/);
  assert.equal(result.licenses[0].keyDigest, undefined);
});

test('LicenseService recovers a legacy order license from its delivery ciphertext', async () => {
  const rootSecret = Buffer.alloc(32, 8);
  const actor = { id: 'owner-1', username: 'owner', role: 'merchant_admin', merchantId: 'merchant-1' };
  const licenseKey = 'KMXT-APP-23456-789AB-CDEFG-HJKLM';
  const license = {
    id: 'license-1', merchantId: 'merchant-1', appId: 'app-1', keyDigest: digestSecret(rootSecret, 'license-key', licenseKey),
    keyEncrypted: null,
  };
  const order = {
    id: 'order-1', licenseId: license.id,
    licenseKeyEncrypted: encryptText(rootSecret, 'order-license:order-1', licenseKey),
  };
  const state = { licenses: [license], orders: [order], auditLogs: [] };
  const store = { async transaction(mutator) { return mutator(state); } };
  const service = new LicenseService(store, rootSecret, { maxLicenseBatch: 10 });
  const result = await service.revealKey(actor, license.id);
  assert.deepEqual(result, { licenseId: license.id, key: licenseKey });
  assert.equal(state.auditLogs.at(-1).action, 'license.key.reveal');
  assert.equal(JSON.stringify(state.auditLogs).includes(licenseKey), false);
});

test('MySQL public order creation locks the storefront resources and persists no plaintext contact', async () => {
  const calls = [];
  const merchant = { id: 'merchant-1', code: 'MERCHANT_1', name: 'Merchant', status: 'active' };
  const product = { id: 'product-1', merchantId: 'merchant-1', appId: 'app-1', name: 'Product', priceCents: 100, currency: 'CNY', durationDays: 30, maxDevices: 1, status: 'active' };
  const application = { id: 'app-1', merchantId: 'merchant-1', name: 'App', status: 'active' };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql === 'SELECT payload, status FROM merchants WHERE code = ? FOR UPDATE') return [[{ payload: JSON.stringify(merchant), status: 'active' }]];
      if (sql === 'SELECT payload, merchant_id, app_id, status FROM products WHERE id = ? FOR UPDATE') return [[{ payload: JSON.stringify(product), merchant_id: 'merchant-1', app_id: 'app-1', status: 'active' }]];
      if (sql === 'SELECT payload, merchant_id, status FROM applications WHERE id = ? FOR UPDATE') return [[{ payload: JSON.stringify(application), merchant_id: 'merchant-1', status: 'active' }]];
      return [[]];
    },
  };
  const repository = new MysqlOrderRepository({ async getConnection() { return connection; } });
  const order = await repository.createPublic('MERCHANT_1', product.id, ({ merchant: currentMerchant, product: currentProduct, application: currentApplication }) => ({
    id: 'order-1', orderNo: 'KMO-20260715-ABC', merchantId: currentMerchant.id, appId: currentApplication.id, productId: currentProduct.id,
    productSnapshot: { name: 'Product', applicationName: 'App', priceCents: 100, currency: 'CNY', durationDays: 30, maxDevices: 1 },
    customerName: 'Buyer', contactEncrypted: 'ciphertext-only', contactMasked: 'bu***@example.com', contactDigest: 'digest-only', queryDigest: 'query-digest',
    note: null, status: 'pending', licenseId: null, licenseKeyEncrypted: null, rejectReason: null,
    createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z', fulfilledAt: null, rejectedAt: null,
  }));
  assert.equal(order.id, 'order-1');
  assert.ok(calls.some((call) => /INSERT INTO orders/.test(call.sql)));
  assert.equal(calls.some((call) => JSON.stringify(call.values).includes('buyer@example.com')), false);
  assert.ok(calls.some((call) => /INSERT INTO audit_logs/.test(call.sql)));
});

test('OrderService delegates public order creation and rejection to the MySQL repository', async () => {
  const application = { id: 'app-1', name: 'App' };
  const product = { id: 'product-1', name: 'Product', priceCents: 100, currency: 'CNY', durationDays: 30, maxDevices: 1 };
  const merchant = { id: 'merchant-1' };
  const calls = [];
  const repository = {
    async createPublic(code, productId, createOrder) {
      calls.push(`create:${code}:${productId}`);
      return createOrder({ merchant, product, application });
    },
    async reject(actor, orderId, reason) {
      calls.push(`reject:${actor.id}:${orderId}:${reason}`);
      return { id: orderId, merchantId: 'merchant-1', orderNo: 'KMO-20260715-ABC', status: 'rejected', contactEncrypted: encryptText(Buffer.alloc(32, 6), `order-contact:${orderId}`, 'buyer@example.com'), licenseKeyEncrypted: null, rejectReason: reason, createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z', fulfilledAt: null, rejectedAt: '2026-07-15T00:00:00.000Z' };
    },
  };
  const store = {
    repositories: { orders: repository },
    async read() { throw new Error('MySQL order paths must not load the StateStore'); },
    async transaction() { throw new Error('MySQL order paths must not write through the StateStore'); },
  };
  const service = new OrderService(store, Buffer.alloc(32, 6));
  const created = await service.createPublic('merchant_1', { productId: '00000000-0000-0000-0000-000000000001', customerName: 'Buyer', contact: 'buyer@example.com' });
  assert.equal(created.status, 'pending');
  assert.equal(created.contact, 'bu***@example.com');
  const rejected = await service.reject({ id: 'owner-1', username: 'owner', role: 'merchant_admin', merchantId: 'merchant-1' }, 'order-1', { reason: 'Incomplete' });
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(calls.map((value) => value.split(':').slice(0, 2).join(':')), ['create:MERCHANT_1', 'reject:owner-1']);
});

test('MySQL audit repository applies tenant, event, and time filters directly in SQL', async () => {
  const calls = [];
  const pool = {
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql === 'SELECT id FROM merchants WHERE id = ?') return [[{ id: 'merchant-1' }]];
      if (/COUNT\(\*\) AS total FROM audit_logs/.test(sql)) return [[{ total: 1 }]];
      if (/SELECT payload FROM audit_logs/.test(sql)) return [[{ payload: JSON.stringify({ id: 'audit-1', merchantId: 'merchant-1', action: 'license.status.update' }) }]];
      return [[]];
    },
  };
  const repository = new MysqlAuditRepository(pool);
  const result = await repository.list(
    { id: 'owner-1', role: 'merchant_admin', merchantId: 'merchant-1' },
    'merchant-1',
    { page: 1, limit: 20, offset: 0 },
    { action: 'license.status.update', from: Date.parse('2026-07-14T00:00:00.000Z'), to: Date.parse('2026-07-16T00:00:00.000Z') },
  );
  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, 'audit-1');
  assert.ok(calls.some((call) => /merchant_id = \? AND action = \? AND created_at >= \? AND created_at <= \?/.test(call.sql)));
});

test('MySQL maintenance cleanup deletes expired rows and records an audit summary atomically', async () => {
  const calls = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql === 'DELETE FROM admin_sessions WHERE expires_at <= ?') return [{ affectedRows: 2 }];
      if (sql === 'DELETE FROM client_sessions WHERE expires_at <= ?') return [{ affectedRows: 3 }];
      return [[]];
    },
  };
  const repository = new MysqlMaintenanceRepository({ async getConnection() { return connection; } });
  const result = await repository.cleanupSessions(Date.parse('2026-07-15T00:00:00.000Z'));
  assert.deepEqual(result, { expiredAdminSessions: 2, expiredClientSessions: 3, expiredModelLeases: 0 });
  assert.ok(calls.some((call) => /INSERT INTO audit_logs/.test(call.sql) && JSON.stringify(call.values).includes('maintenance.sessions.cleanup')));
});

test('MaintenanceService delegates MySQL cleanup without loading the StateStore', async () => {
  const calls = [];
  const store = {
    repositories: {
      maintenance: {
        async cleanupVerificationLogs(days, cutoff) {
          calls.push({ days, cutoff });
          return { deletedVerificationLogs: 4, retentionDays: days, cutoff: new Date(cutoff).toISOString() };
        },
      },
    },
    async transaction() { throw new Error('MySQL maintenance must not write through the StateStore'); },
  };
  const service = new MaintenanceService(store);
  const now = Date.parse('2026-07-15T00:00:00.000Z');
  const result = await service.cleanupVerificationLogs(30, now);
  assert.equal(result.deletedVerificationLogs, 4);
  assert.equal(calls[0].cutoff, now - 30 * 86400000);
});

test('MySQL status summary uses metadata and count queries instead of loading state payloads', async () => {
  const calls = [];
  const totals = [2, 3, 4, 5, 6, 7];
  const store = Object.create(MysqlStore.prototype);
  store.pool = {
    async execute(sql) {
      calls.push(sql);
      if (sql.startsWith('SELECT schema_version')) return [[{ schema_version: 4, updated_at: new Date('2026-07-15T00:00:00.000Z') }]];
      return [[{ total: totals.shift() }]];
    },
  };
  const result = await store.statusSummary();
  assert.deepEqual(result, {
    schemaVersion: 4, merchants: 2, applications: 3, products: 4, orders: 5, licenses: 6, users: 7,
    updatedAt: '2026-07-15T00:00:00.000Z',
  });
  assert.equal(calls.some((sql) => /payload/.test(sql)), false);
});
