import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolveClientIp } from '../src/http/client-ip.js';
import { RateLimiter } from '../src/http/rate-limiter.js';
import { ReplayGuard } from '../src/security/replay-guard.js';
import { MemorySecurityState } from '../src/security/security-state.js';

test('shared security-state contract rejects replay and counts rate windows atomically', async () => {
  const state = new MemorySecurityState();
  const guard = new ReplayGuard(300, state);
  const timestamp = Date.now();
  await guard.assertFresh('activate:app', timestamp, 'nonce_123456789');
  await assert.rejects(
    () => guard.assertFresh('activate:app', timestamp, 'nonce_123456789'),
    (error) => error.code === 'REPLAY_DETECTED',
  );

  const limiter = new RateLimiter(state);
  await limiter.assertAllowed('client:route', { limit: 2, windowSeconds: 60 });
  await limiter.assertAllowed('client:route', { limit: 2, windowSeconds: 60 });
  await assert.rejects(
    () => limiter.assertAllowed('client:route', { limit: 2, windowSeconds: 60 }),
    (error) => error.code === 'RATE_LIMITED' && error.details.retryAfter > 0,
  );
});

test('forwarded client address is trusted only from the configured proxy CIDR', () => {
  const request = (remoteAddress, forwarded) => ({
    socket: { remoteAddress },
    headers: { 'x-forwarded-for': forwarded },
  });
  assert.equal(resolveClientIp(request('203.0.113.8', '198.51.100.2'), ['172.28.52.1/32']), '203.0.113.8');
  assert.equal(resolveClientIp(request('::ffff:172.28.52.1', '198.51.100.2'), ['172.28.52.1/32']), '198.51.100.2');
  assert.equal(resolveClientIp(request('172.28.52.1', 'not-an-ip'), ['172.28.52.1/32']), '172.28.52.1');
});

test('initial migration declares all production entities and UTC millisecond columns', async () => {
  const sql = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
  for (const table of [
    'users', 'admin_sessions', 'merchants', 'applications', 'products', 'orders',
    'license_batches', 'licenses', 'device_bindings', 'client_sessions',
    'audit_logs', 'verification_logs',
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(sql, /CHAR\(36\) PRIMARY KEY/);
  assert.match(sql, /DATETIME\(3\)/);
  assert.match(sql, /UNIQUE KEY uq_orders_license \(license_id\)/);
});

test('productization migration adds targeted query indexes and advances the persisted schema version', async () => {
  const sql = await readFile(new URL('../migrations/002_productization_indexes.sql', import.meta.url), 'utf8');
  for (const index of [
    'ix_users_merchant_status', 'ix_applications_merchant_status', 'ix_license_batches_app_created',
    'ix_licenses_app_created', 'ix_orders_merchant_created', 'ix_orders_app_status_created',
    'ix_device_bindings_app_status', 'ix_client_sessions_user_scope', 'ix_audit_logs_action_created',
    'ix_verification_logs_event_created',
  ]) assert.match(sql, new RegExp(index));
  assert.match(sql, /schema_version = 3/);
});

test('license key recovery migration advances metadata without rewriting payload tables', async () => {
  const sql = await readFile(new URL('../migrations/003_license_key_recovery.sql', import.meta.url), 'utf8');
  assert.match(sql, /schema_version = 4/);
  assert.match(sql, /JSON payload/i);
});

test('model delivery migration stores metadata and advances schema without model bytes', async () => {
  const sql = await readFile(new URL('../migrations/004_model_delivery.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS model_artifacts/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS model_leases/);
  assert.match(sql, /cipher_sha256 CHAR\(64\)/);
  assert.match(sql, /client_key_fingerprint CHAR\(64\)/);
  assert.match(sql, /schema_version = 5/);
  assert.doesNotMatch(sql, /BLOB|LONGBLOB/i);
});

test('deployment templates keep credentials in read-only secret files and recovery is guarded', async () => {
  const [compose, productionEnv, backup, restore] = await Promise.all([
    readFile(new URL('../deploy/compose.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/production.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/scripts/backup.sh', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/scripts/restore.sh', import.meta.url), 'utf8'),
  ]);
  assert.match(compose, /mysql_local_password:\s*\n\s*file: \.\/secrets\/mysql_local_password/);
  assert.match(compose, /kmxt_redis_password:\s*\n\s*file: \.\/secrets\/redis_password/);
  assert.match(productionEnv, /^KMXT_MYSQL_PASSWORD_FILE=\/run\/secrets\/kmxt_mysql_password$/m);
  assert.match(productionEnv, /^KMXT_REDIS_PASSWORD_FILE=\/run\/secrets\/kmxt_redis_password$/m);
  assert.doesNotMatch(productionEnv, /^KMXT_(?:MYSQL|REDIS)_PASSWORD=/m);
  assert.match(backup, /--single-transaction/);
  assert.match(backup, /--ssl-mode=VERIFY_IDENTITY/);
  assert.match(restore, /--confirm-restore/);
  assert.match(restore, /sha256sum -c SHA256SUMS/);
  assert.match(restore, /TABLE_COUNT=/);
  assert.doesNotMatch(restore, /DROP\s+DATABASE/i);
});
