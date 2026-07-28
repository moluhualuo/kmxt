import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../src/app.js';

test('0.6.0 management services update resources, list batches, and revoke disabled user sessions', async (context) => {
  const runtimeRoot = path.join(process.cwd(), '.runtime');
  await mkdir(runtimeRoot, { recursive: true });
  const directory = await mkdtemp(path.join(runtimeRoot, 'productization-'));
  const runtime = await createRuntime({ dataFile: path.join(directory, 'state.json'), secretFile: path.join(directory, 'secret.key') });
  context.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });

  const platform = await runtime.services.auth.bootstrapPlatformAdmin({ username: 'platform.060', password: 'Platform-Password-060!', displayName: 'Platform' });
  const merchant = await runtime.services.merchants.create(platform, { code: 'PRODUCT_060', name: 'Before Name' });
  const renamed = await runtime.services.merchants.update(platform, merchant.id, { name: 'After Name' });
  assert.equal(renamed.name, 'After Name');

  const app = await runtime.services.applications.create(platform, merchant.id, { code: 'APP_060', name: 'Before App' });
  const updatedApp = await runtime.services.applications.update(platform, app.id, { name: 'After App', settings: { defaultMaxDevices: 0 } });
  assert.equal(updatedApp.name, 'After App');
  assert.equal(updatedApp.settings.defaultMaxDevices, 0);

  await runtime.services.licenses.generate(platform, app.id, { count: 2, batchName: 'Batch 060' });
  const batches = await runtime.services.licenses.listBatches(platform, app.id, { page: 1, limit: 20, offset: 0 });
  assert.equal(batches.total, 1);
  assert.equal(batches.items[0].count, 2);

  const dashboard = await runtime.services.dashboard.get(platform, { merchantId: merchant.id, appId: app.id });
  assert.equal(dashboard.merchants, 1);
  assert.equal(dashboard.applications, 1);
  assert.equal(dashboard.licenses, 2);
  assert.deepEqual(await runtime.services.readiness.check(), { storage: true, security: true, rootKey: true });

  const user = await runtime.services.auth.createMerchantUser(platform, merchant.id, { username: 'operator.060', password: 'Operator-Password-060!', displayName: 'Operator', role: 'operator' });
  await runtime.services.auth.login({ username: user.username, password: 'Operator-Password-060!' });
  const disabled = await runtime.services.auth.setUserStatus(platform, user.id, 'disabled');
  assert.equal(disabled.user.status, 'disabled');
  assert.equal(disabled.sessionsRevoked, 1);

  await runtime.store.transaction((state) => {
    state.adminSessions.push({ id: 'expired-admin', userId: platform.id, tokenDigest: 'x', createdAt: new Date(0).toISOString(), expiresAt: new Date(0).toISOString() });
    state.clientSessions.push({ id: 'expired-client', merchantId: merchant.id, appId: app.id, licenseId: 'license', bindingId: 'binding', tokenDigest: 'y', createdAt: new Date(0).toISOString(), expiresAt: new Date(0).toISOString() });
    state.verificationLogs.push({ id: 'old-log', merchantId: merchant.id, appId: app.id, licenseId: 'license', bindingId: 'binding', event: 'verify', resultCode: 'OK', createdAt: new Date(0).toISOString() });
    state.modelLeases.push(
      { id: 'expired-model-lease', licenseId: 'license', status: 'active', expiresAt: new Date(0).toISOString() },
      { id: 'retained-revoked-model-lease', licenseId: 'license', status: 'revoked', expiresAt: new Date(Date.now() + 60000).toISOString() },
    );
  });
  assert.deepEqual(await runtime.services.maintenance.cleanupSessions(), {
    expiredAdminSessions: 1,
    expiredClientSessions: 1,
    expiredModelLeases: 1,
  });
  assert.deepEqual(
    await runtime.store.read((state) => state.modelLeases.map((lease) => lease.id)),
    ['retained-revoked-model-lease'],
  );
  const logCleanup = await runtime.services.maintenance.cleanupVerificationLogs(30);
  assert.equal(logCleanup.deletedVerificationLogs, 1);
  const auditActions = await runtime.store.read((state) => state.auditLogs.map((item) => item.action));
  assert.ok(auditActions.includes('maintenance.sessions.cleanup'));
  assert.ok(auditActions.includes('maintenance.verification_logs.cleanup'));
});
