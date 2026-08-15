import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../src/app.js';
import { verifySignedEnvelope } from '../src/security/crypto.js';

async function request(baseUrl, method, route, options = {}) {
  const headers = {};
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json();
  return { status: response.status, payload, headers: response.headers };
}

function nonce(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test('multi-tenant license activation and verification workflow', async (context) => {
  const runtimeRoot = path.join(process.cwd(), '.runtime');
  await mkdir(runtimeRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(runtimeRoot, 'test-'));
  const runtime = await createRuntime({
    dataFile: path.join(temporaryDirectory, 'kmxt.json'),
    secretFile: path.join(temporaryDirectory, 'secret.key'),
    port: 0,
    clockSkewSeconds: 30,
    clientSessionTtlSeconds: 300,
  });
  context.after(async () => {
    await runtime.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  await runtime.services.auth.bootstrapPlatformAdmin({
    username: 'platform.admin',
    password: 'Platform-Password-2026!',
    displayName: 'Platform Admin',
  });
  const address = await runtime.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await request(baseUrl, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.payload.data.status, 'ok');

  const ready = await request(baseUrl, 'GET', '/ready');
  assert.equal(ready.status, 200);
  assert.equal(ready.payload.data.status, 'ready');
  assert.deepEqual(ready.payload.data.checks, { storage: true, security: true, rootKey: true });
  assert.equal(ready.headers.get('x-request-id'), ready.payload.requestId);

  const rootResponse = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.equal(rootResponse.status, 302);
  assert.equal(rootResponse.headers.get('location'), '/admin/');
  const adminPage = await fetch(`${baseUrl}/admin/`);
  assert.equal(adminPage.status, 200);
  assert.match(adminPage.headers.get('content-type'), /^text\/html/);
  assert.match(await adminPage.text(), /KMXT 授权管理/);
  const adminScript = await fetch(`${baseUrl}/admin/js/app.js`);
  assert.equal(adminScript.status, 200);
  assert.match(adminScript.headers.get('content-type'), /^text\/javascript/);

  const platformLogin = await request(baseUrl, 'POST', '/api/v1/auth/login', {
    body: { username: 'platform.admin', password: 'Platform-Password-2026!' },
  });
  assert.equal(platformLogin.status, 200);
  const platformToken = platformLogin.payload.data.token;

  const merchantAResponse = await request(baseUrl, 'POST', '/api/v1/platform/merchants', {
    token: platformToken,
    body: { code: 'MERCHANT_A', name: 'Merchant A' },
  });
  const merchantBResponse = await request(baseUrl, 'POST', '/api/v1/platform/merchants', {
    token: platformToken,
    body: { code: 'MERCHANT_B', name: 'Merchant B' },
  });
  assert.equal(merchantAResponse.status, 201);
  assert.equal(merchantBResponse.status, 201);
  const merchantA = merchantAResponse.payload.data;
  const merchantB = merchantBResponse.payload.data;

  const renamedMerchant = await request(baseUrl, 'PATCH', `/api/v1/platform/merchants/${merchantA.id}`, {
    token: platformToken,
    body: { name: 'Merchant A Updated' },
  });
  assert.equal(renamedMerchant.status, 200);
  assert.equal(renamedMerchant.payload.data.name, 'Merchant A Updated');
  assert.equal(renamedMerchant.payload.data.code, merchantA.code);

  const createAdminA = await request(baseUrl, 'POST', `/api/v1/merchants/${merchantA.id}/users`, {
    token: platformToken,
    body: {
      username: 'merchant.a.admin',
      password: 'Merchant-A-Password!',
      displayName: 'Merchant A Admin',
      role: 'merchant_admin',
    },
  });
  const createAdminB = await request(baseUrl, 'POST', `/api/v1/merchants/${merchantB.id}/users`, {
    token: platformToken,
    body: {
      username: 'merchant.b.admin',
      password: 'Merchant-B-Password!',
      displayName: 'Merchant B Admin',
      role: 'merchant_admin',
    },
  });
  assert.equal(createAdminA.status, 201);
  assert.equal(createAdminB.status, 201);

  const merchantLogin = await request(baseUrl, 'POST', '/api/v1/auth/login', {
    body: { username: 'merchant.a.admin', password: 'Merchant-A-Password!' },
  });
  const merchantToken = merchantLogin.payload.data.token;
  const merchantRenameDenied = await request(baseUrl, 'PATCH', `/api/v1/platform/merchants/${merchantA.id}`, {
    token: merchantToken,
    body: { name: 'Not Allowed' },
  });
  assert.equal(merchantRenameDenied.status, 403);
  const ownMerchant = await request(baseUrl, 'GET', `/api/v1/merchants/${merchantA.id}`, {
    token: merchantToken,
  });
  assert.equal(ownMerchant.status, 200);
  assert.equal(ownMerchant.payload.data.id, merchantA.id);
  const otherMerchant = await request(baseUrl, 'GET', `/api/v1/merchants/${merchantB.id}`, {
    token: merchantToken,
  });
  assert.equal(otherMerchant.status, 403);
  const crossTenant = await request(baseUrl, 'GET', `/api/v1/merchants/${merchantB.id}/apps`, {
    token: merchantToken,
  });
  assert.equal(crossTenant.status, 403);
  assert.equal(crossTenant.payload.error.code, 'FORBIDDEN');
  const crossTenantPasswordReset = await request(
    baseUrl,
    'POST',
    `/api/v1/users/${createAdminB.payload.data.id}/password/reset`,
    {
      token: merchantToken,
      body: { newPassword: 'Cross-Tenant-Password!' },
    },
  );
  assert.equal(crossTenantPasswordReset.status, 403);
  assert.equal(crossTenantPasswordReset.payload.error.code, 'FORBIDDEN');

  const createOperator = await request(baseUrl, 'POST', `/api/v1/merchants/${merchantA.id}/users`, {
    token: merchantToken,
    body: {
      username: 'merchant.a.operator',
      password: 'Merchant-A-Operator-Password!',
      displayName: 'Merchant A Operator',
      role: 'operator',
    },
  });
  assert.equal(createOperator.status, 201);
  const operatorLogin = await request(baseUrl, 'POST', '/api/v1/auth/login', {
    body: { username: 'merchant.a.operator', password: 'Merchant-A-Operator-Password!' },
  });
  assert.equal(operatorLogin.status, 200);

  // 花落 / MIT：商户管理员可在 operator 与 merchant_admin 之间调整角色，调整后旧会话立即失效。
  const promoteOperator = await request(baseUrl, 'PATCH', `/api/v1/users/${createOperator.payload.data.id}/role`, {
    token: merchantToken,
    body: { role: 'merchant_admin' },
  });
  assert.equal(promoteOperator.status, 200);
  assert.equal(promoteOperator.payload.data.user.role, 'merchant_admin');
  assert.equal(promoteOperator.payload.data.roleChanged, true);
  assert.equal(promoteOperator.payload.data.sessionsRevoked, 1);
  const promotedStaleSession = await request(baseUrl, 'GET', '/api/v1/auth/me', {
    token: operatorLogin.payload.data.token,
  });
  assert.equal(promotedStaleSession.status, 401);
  // 角色接口不能造出 platform_admin。
  const escalationDenied = await request(baseUrl, 'PATCH', `/api/v1/users/${createOperator.payload.data.id}/role`, {
    token: platformToken,
    body: { role: 'platform_admin' },
  });
  assert.equal(escalationDenied.status, 400);
  assert.equal(escalationDenied.payload.error.code, 'INVALID_INPUT');
  // 不能改自己的角色，避免最后一个商户管理员自降权后无人可写。
  const selfRoleDenied = await request(baseUrl, 'PATCH', `/api/v1/users/${createAdminA.payload.data.id}/role`, {
    token: merchantToken,
    body: { role: 'operator' },
  });
  assert.equal(selfRoleDenied.status, 409);
  assert.equal(selfRoleDenied.payload.error.code, 'SELF_ROLE_FORBIDDEN');
  const crossTenantRole = await request(baseUrl, 'PATCH', `/api/v1/users/${createAdminB.payload.data.id}/role`, {
    token: merchantToken,
    body: { role: 'operator' },
  });
  assert.equal(crossTenantRole.status, 403);
  assert.equal(crossTenantRole.payload.error.code, 'FORBIDDEN');
  const demoteOperator = await request(baseUrl, 'PATCH', `/api/v1/users/${createOperator.payload.data.id}/role`, {
    token: merchantToken,
    body: { role: 'operator' },
  });
  assert.equal(demoteOperator.status, 200);
  assert.equal(demoteOperator.payload.data.user.role, 'operator');
  const repeatDemote = await request(baseUrl, 'PATCH', `/api/v1/users/${createOperator.payload.data.id}/role`, {
    token: merchantToken,
    body: { role: 'operator' },
  });
  assert.equal(repeatDemote.status, 200);
  assert.equal(repeatDemote.payload.data.roleChanged, false);
  assert.equal(repeatDemote.payload.data.sessionsRevoked, 0);
  const operatorSecondLogin = await request(baseUrl, 'POST', '/api/v1/auth/login', {
    body: { username: 'merchant.a.operator', password: 'Merchant-A-Operator-Password!' },
  });
  assert.equal(operatorSecondLogin.status, 200);
  assert.equal(operatorSecondLogin.payload.data.user.role, 'operator');

  const disableOperator = await request(baseUrl, 'PATCH', `/api/v1/users/${createOperator.payload.data.id}/status`, {
    token: merchantToken,
    body: { status: 'disabled' },
  });
  assert.equal(disableOperator.status, 200);
  assert.equal(disableOperator.payload.data.user.status, 'disabled');
  assert.equal(disableOperator.payload.data.sessionsRevoked, 1);
  const disabledOperatorSession = await request(baseUrl, 'GET', '/api/v1/auth/me', {
    token: operatorSecondLogin.payload.data.token,
  });
  assert.equal(disabledOperatorSession.status, 401);

  const appResponse = await request(baseUrl, 'POST', `/api/v1/merchants/${merchantA.id}/apps`, {
    token: merchantToken,
    body: {
      code: 'DESKTOP_PRO',
      name: 'Desktop Pro',
      settings: {
        defaultDurationDays: 30,
        defaultMaxDevices: 1,
        heartbeatSeconds: 60,
        offlineGraceSeconds: 300,
      },
    },
  });
  assert.equal(appResponse.status, 201);
  const application = appResponse.payload.data;
  assert.equal(application.signing.algorithm, 'Ed25519');

  const updatedApplication = await request(baseUrl, 'PATCH', `/api/v1/apps/${application.id}`, {
    token: merchantToken,
    body: {
      name: 'Desktop Pro Updated',
      description: 'Updated without key rotation',
      settings: {
        defaultDurationDays: 31,
        defaultMaxDevices: 1,
        heartbeatSeconds: 90,
        offlineGraceSeconds: 360,
      },
    },
  });
  assert.equal(updatedApplication.status, 200);
  assert.equal(updatedApplication.payload.data.name, 'Desktop Pro Updated');
  assert.equal(updatedApplication.payload.data.settings.heartbeatSeconds, 90);
  assert.equal(updatedApplication.payload.data.signing.keyId, application.signing.keyId);
  assert.equal(updatedApplication.payload.data.signing.publicKey, application.signing.publicKey);

  const productResponse = await request(baseUrl, 'POST', `/api/v1/apps/${application.id}/products`, {
    token: merchantToken,
    body: {
      name: 'Seven Day License',
      description: 'Manual fulfillment test product',
      priceCents: 990,
      durationDays: 7,
      maxDevices: 1,
      sortOrder: 10,
    },
  });
  assert.equal(productResponse.status, 201);
  const product = productResponse.payload.data;

  const dashboard = await request(baseUrl, 'GET', '/api/v1/dashboard', { token: merchantToken });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.payload.data.merchants, 1);
  assert.equal(dashboard.payload.data.applications, 1);
  assert.equal(dashboard.payload.data.licenses, 0);
  const crossTenantDashboard = await request(baseUrl, 'GET', `/api/v1/dashboard?merchantId=${merchantB.id}`, {
    token: merchantToken,
  });
  assert.equal(crossTenantDashboard.status, 403);

  const storefrontPage = await fetch(`${baseUrl}/store/MERCHANT_A`);
  assert.equal(storefrontPage.status, 200);
  assert.match(await storefrontPage.text(), /选择套餐/);
  const publicStore = await request(baseUrl, 'GET', '/api/v1/store/MERCHANT_A');
  assert.equal(publicStore.status, 200);
  assert.equal(publicStore.payload.data.products.length, 1);
  assert.equal(publicStore.payload.data.products[0].id, product.id);

  const publicOrder = await request(baseUrl, 'POST', '/api/v1/store/MERCHANT_A/orders', {
    body: {
      productId: product.id,
      customerName: '花',
      contact: 'buyer@example.com',
      note: 'E2E order',
    },
  });
  assert.equal(publicOrder.status, 201);
  assert.equal(publicOrder.payload.data.status, 'pending');
  assert.equal(publicOrder.payload.data.customerName, '花');
  const order = publicOrder.payload.data;
  assert.ok(order.queryCode.length >= 20);
  assert.equal(order.id, undefined);
  assert.equal(order.merchantId, undefined);
  assert.equal(order.appId, undefined);

  const pendingOrder = await request(baseUrl, 'POST', '/api/v1/store/orders/query', {
    body: { orderNo: order.orderNo, queryCode: order.queryCode },
  });
  assert.equal(pendingOrder.status, 200);
  assert.equal(pendingOrder.payload.data.status, 'pending');
  assert.equal(pendingOrder.payload.data.licenseKey, null);
  assert.equal(pendingOrder.payload.data.id, undefined);

  const adminOrders = await request(baseUrl, 'GET', `/api/v1/merchants/${merchantA.id}/orders`, {
    token: merchantToken,
  });
  assert.equal(adminOrders.status, 200);
  assert.equal(adminOrders.payload.data.total, 1);
  const adminOrder = adminOrders.payload.data.items[0];
  assert.equal(adminOrder.orderNo, order.orderNo);

  const merchantBLogin = await request(baseUrl, 'POST', '/api/v1/auth/login', {
    body: { username: 'merchant.b.admin', password: 'Merchant-B-Password!' },
  });
  const crossTenantFulfill = await request(baseUrl, 'POST', `/api/v1/orders/${adminOrder.id}/fulfill`, {
    token: merchantBLogin.payload.data.token,
    body: {},
  });
  assert.equal(crossTenantFulfill.status, 403);

  const [fulfilledOrder, repeatedFulfillment] = await Promise.all([
    request(baseUrl, 'POST', `/api/v1/orders/${adminOrder.id}/fulfill`, {
      token: merchantToken,
      body: {},
    }),
    request(baseUrl, 'POST', `/api/v1/orders/${adminOrder.id}/fulfill`, {
      token: merchantToken,
      body: {},
    }),
  ]);
  assert.equal(fulfilledOrder.status, 200);
  assert.equal(fulfilledOrder.payload.data.status, 'fulfilled');
  const orderedLicenseKey = fulfilledOrder.payload.data.licenseKey;
  assert.match(orderedLicenseKey, /^KMXT-/);

  assert.equal(repeatedFulfillment.status, 200);
  assert.equal(repeatedFulfillment.payload.data.licenseId, fulfilledOrder.payload.data.licenseId);
  assert.equal(repeatedFulfillment.payload.data.licenseKey, orderedLicenseKey);

  const deliveredOrder = await request(baseUrl, 'POST', '/api/v1/store/orders/query', {
    body: { orderNo: order.orderNo, queryCode: order.queryCode },
  });
  assert.equal(deliveredOrder.status, 200);
  assert.equal(deliveredOrder.payload.data.licenseKey, orderedLicenseKey);
  const orderDataFile = await readFile(path.join(temporaryDirectory, 'kmxt.json'), 'utf8');
  assert.equal(orderDataFile.includes('buyer@example.com'), false);
  assert.equal(orderDataFile.includes(orderedLicenseKey), false);
  const revealOrderedLicense = await request(baseUrl, 'POST', `/api/v1/licenses/${fulfilledOrder.payload.data.licenseId}/reveal-key`, {
    token: merchantToken,
    body: {},
  });
  assert.equal(revealOrderedLicense.status, 200);
  assert.equal(revealOrderedLicense.payload.data.key, orderedLicenseKey);
  const deleteOrderedLicense = await request(baseUrl, 'DELETE', `/api/v1/licenses/${fulfilledOrder.payload.data.licenseId}`, {
    token: merchantToken,
  });
  assert.equal(deleteOrderedLicense.status, 409);
  assert.equal(deleteOrderedLicense.payload.error.code, 'LICENSE_HAS_ORDER');

  const mixedDeleteBatch = await request(baseUrl, 'POST', `/api/v1/apps/${application.id}/license-batches`, {
    token: merchantToken,
    body: { count: 1, durationDays: 7, maxDevices: 1, batchName: 'Mixed Bulk Delete' },
  });
  assert.equal(mixedDeleteBatch.status, 201);
  const mixedBulkDelete = await request(baseUrl, 'POST', `/api/v1/apps/${application.id}/licenses/bulk-delete`, {
    token: merchantToken,
    body: { licenseIds: [fulfilledOrder.payload.data.licenseId, mixedDeleteBatch.payload.data.licenses[0].id] },
  });
  assert.equal(mixedBulkDelete.status, 200);
  assert.equal(mixedBulkDelete.payload.data.deletedCount, 1);
  assert.equal(mixedBulkDelete.payload.data.failed.length, 1);
  assert.equal(mixedBulkDelete.payload.data.failed[0].code, 'LICENSE_HAS_ORDER');

  const batchResponse = await request(baseUrl, 'POST', `/api/v1/apps/${application.id}/license-batches`, {
    token: merchantToken,
    body: { count: 2, durationDays: 7, maxDevices: 1, batchName: 'E2E Batch' },
  });
  assert.equal(batchResponse.status, 201);
  assert.equal(batchResponse.payload.data.licenses.length, 2);
  const plaintextLicense = batchResponse.payload.data.licenses[0].key;
  const licenseId = batchResponse.payload.data.licenses[0].id;
  const deletableLicense = batchResponse.payload.data.licenses[1];
  const revealLicense = await request(baseUrl, 'POST', `/api/v1/licenses/${licenseId}/reveal-key`, {
    token: merchantToken,
    body: {},
  });
  assert.equal(revealLicense.status, 200);
  assert.equal(revealLicense.payload.data.key, plaintextLicense);
  const listedBatches = await request(baseUrl, 'GET', `/api/v1/apps/${application.id}/license-batches?page=1&limit=1`, {
    token: merchantToken,
  });
  assert.equal(listedBatches.status, 200);
  assert.equal(listedBatches.payload.data.total, 3);
  assert.equal(listedBatches.payload.data.items.some((batch) => batch.id === batchResponse.payload.data.batch.id), true);
  assert.equal(Object.hasOwn(listedBatches.payload.data.items[0], 'key'), false);
  const persistedData = await readFile(path.join(temporaryDirectory, 'kmxt.json'), 'utf8');
  assert.equal(persistedData.includes(plaintextLicense), false);
  assert.equal(persistedData.includes(deletableLicense.key), false);

  // Author: 花落. Bulk delete and custom pagination coverage is provided under the MIT License.
  const bulkBatch = await request(baseUrl, 'POST', `/api/v1/apps/${application.id}/license-batches`, {
    token: merchantToken,
    body: { count: 2, durationDays: 7, maxDevices: 1, batchName: 'Bulk Delete removes selected standalone licenses' },
  });
  assert.equal(bulkBatch.status, 201);
  const bulkLicenseIds = bulkBatch.payload.data.licenses.map((license) => license.id);
  const listWithMaxLimit = await request(baseUrl, 'GET', `/api/v1/apps/${application.id}/licenses?page=1&limit=100`, {
    token: merchantToken,
  });
  assert.equal(listWithMaxLimit.status, 200);
  assert.equal(listWithMaxLimit.payload.data.limit, 100);
  const listOverMaxLimit = await request(baseUrl, 'GET', `/api/v1/apps/${application.id}/licenses?page=1&limit=101`, {
    token: merchantToken,
  });
  assert.equal(listOverMaxLimit.status, 400);
  assert.equal(listOverMaxLimit.payload.error.code, 'INVALID_PAGINATION');
  const bulkDelete = await request(baseUrl, 'POST', `/api/v1/apps/${application.id}/licenses/bulk-delete`, {
    token: merchantToken,
    body: { licenseIds: bulkLicenseIds },
  });
  assert.equal(bulkDelete.status, 200);
  assert.equal(bulkDelete.payload.data.requestedCount, 2);
  assert.equal(bulkDelete.payload.data.deletedCount, 2);
  assert.deepEqual(bulkDelete.payload.data.failed, []);
  const deletedBulkActivation = await request(baseUrl, 'POST', '/api/v1/client/activate', {
    body: {
      appId: application.id,
      licenseKey: bulkBatch.payload.data.licenses[0].key,
      deviceId: 'bulk-deleted-device-001',
      timestamp: Date.now(),
      nonce: nonce('bulk-deleted-license'),
    },
  });
  assert.equal(deletedBulkActivation.status, 401);
  assert.equal(deletedBulkActivation.payload.error.code, 'LICENSE_INVALID');

  const configResponse = await request(baseUrl, 'GET', `/api/v1/client/apps/${application.id}/config`);
  assert.equal(configResponse.status, 200);
  assert.equal(configResponse.payload.data.signing.keyId, application.signing.keyId);

  const androidConfig = await request(baseUrl, 'GET', `/api/v1/apps/${application.id}/client-config`, {
    token: merchantToken,
  });
  assert.equal(androidConfig.status, 200);
  assert.equal(androidConfig.payload.data.config.appId, application.id);
  assert.equal(androidConfig.payload.data.config.protocolVersion, 1);
  assert.match(androidConfig.payload.data.cppHeader, /namespace kmxt::config/);
  assert.equal(androidConfig.payload.data.cppHeader.includes('PRIVATE KEY'), false);

  const activationTimestamp = Date.now();
  const activationNonce = nonce('activate');
  const activation = await request(baseUrl, 'POST', '/api/v1/client/activate', {
    body: {
      appId: application.id,
      licenseKey: plaintextLicense,
      deviceId: 'device-primary-001',
      deviceLabel: 'Primary PC',
      clientVersion: '1.0.0',
      timestamp: activationTimestamp,
      nonce: activationNonce,
    },
  });
  assert.equal(activation.status, 200);
  assert.equal(activation.payload.data.payload.licensed, true);
  assert.equal(activation.payload.data.payload.requestNonce, activationNonce);
  assert.equal(
    verifySignedEnvelope(activation.payload.data, application.signing.publicKey),
    true,
  );
  const sessionToken = activation.payload.data.payload.sessionToken;

  const replay = await request(baseUrl, 'POST', '/api/v1/client/activate', {
    body: {
      appId: application.id,
      licenseKey: plaintextLicense,
      deviceId: 'device-primary-001',
      timestamp: activationTimestamp,
      nonce: activationNonce,
    },
  });
  assert.equal(replay.status, 409);
  assert.equal(replay.payload.error.code, 'REPLAY_DETECTED');

  const verificationNonce = nonce('verify');
  const verification = await request(baseUrl, 'POST', '/api/v1/client/verify', {
    body: {
      appId: application.id,
      sessionToken,
      deviceId: 'device-primary-001',
      clientVersion: '1.0.0',
      timestamp: Date.now(),
      nonce: verificationNonce,
    },
  });
  assert.equal(verification.status, 200);
  assert.equal(verification.payload.data.payload.requestNonce, verificationNonce);
  assert.equal(verifySignedEnvelope(verification.payload.data, application.signing.publicKey), true);
  const dataAfterActivation = await readFile(path.join(temporaryDirectory, 'kmxt.json'), 'utf8');
  assert.equal(dataAfterActivation.includes('device-primary-001'), false);

  // Author: 花落. Online-device presence and forced disconnect coverage is provided under the MIT License.
  const onlineDevices = await request(baseUrl, 'GET', `/api/v1/apps/${application.id}/online-devices?status=online&search=Primary&page=1&limit=20`, {
    token: merchantToken,
  });
  assert.equal(onlineDevices.status, 200);
  assert.equal(onlineDevices.payload.data.summary.online, 1);
  assert.equal(onlineDevices.payload.data.items[0].deviceLabel, 'Primary PC');
  assert.equal(onlineDevices.payload.data.items[0].clientVersion, '1.0.0');
  assert.equal(typeof onlineDevices.payload.data.items[0].ipAddress, 'string');
  const crossTenantOnlineDevices = await request(baseUrl, 'GET', `/api/v1/apps/${application.id}/online-devices`, {
    token: merchantBLogin.payload.data.token,
  });
  assert.equal(crossTenantOnlineDevices.status, 403);

  const wrongDevice = await request(baseUrl, 'POST', '/api/v1/client/verify', {
    body: {
      appId: application.id,
      sessionToken,
      deviceId: 'device-secondary-002',
      timestamp: Date.now(),
      nonce: nonce('wrong-device'),
    },
  });
  assert.equal(wrongDevice.status, 401);
  assert.equal(wrongDevice.payload.error.code, 'DEVICE_MISMATCH');

  const deviceLimit = await request(baseUrl, 'POST', '/api/v1/client/activate', {
    body: {
      appId: application.id,
      licenseKey: plaintextLicense,
      deviceId: 'device-secondary-002',
      timestamp: Date.now(),
      nonce: nonce('second-device'),
    },
  });
  assert.equal(deviceLimit.status, 409);
  assert.equal(deviceLimit.payload.error.code, 'DEVICE_LIMIT_REACHED');

  const disconnectPrimary = await request(baseUrl, 'POST', `/api/v1/device-bindings/${activation.payload.data.payload.bindingId}/disconnect`, {
    token: merchantToken,
    body: {},
  });
  assert.equal(disconnectPrimary.status, 200);
  assert.equal(disconnectPrimary.payload.data.disconnectedSessions, 1);
  const verificationAfterDisconnect = await request(baseUrl, 'POST', '/api/v1/client/verify', {
    body: {
      appId: application.id,
      sessionToken,
      deviceId: 'device-primary-001',
      timestamp: Date.now(),
      nonce: nonce('verify-after-disconnect'),
    },
  });
  assert.equal(verificationAfterDisconnect.status, 401);
  assert.equal(verificationAfterDisconnect.payload.error.code, 'SESSION_EXPIRED');
  const offlineDevices = await request(baseUrl, 'GET', `/api/v1/apps/${application.id}/online-devices?status=offline`, {
    token: merchantToken,
  });
  assert.equal(offlineDevices.status, 200);
  assert.equal(offlineDevices.payload.data.items.some((item) => item.bindingId === activation.payload.data.payload.bindingId), true);
  const primaryReactivation = await request(baseUrl, 'POST', '/api/v1/client/activate', {
    body: {
      appId: application.id,
      licenseKey: plaintextLicense,
      deviceId: 'device-primary-001',
      deviceLabel: 'Primary PC',
      clientVersion: '1.0.1',
      timestamp: Date.now(),
      nonce: nonce('reactivate-after-disconnect'),
    },
  });
  assert.equal(primaryReactivation.status, 200);
  assert.equal(primaryReactivation.payload.data.payload.bindingId, activation.payload.data.payload.bindingId);

  const selfUnbindWrongDevice = await request(baseUrl, 'POST', '/api/v1/client/unbind', {
    body: {
      appId: application.id,
      sessionToken: primaryReactivation.payload.data.payload.sessionToken,
      deviceId: 'device-secondary-002',
      timestamp: Date.now(),
      nonce: nonce('self-unbind-wrong-device'),
    },
  });
  assert.equal(selfUnbindWrongDevice.status, 401);
  assert.equal(selfUnbindWrongDevice.payload.error.code, 'DEVICE_MISMATCH');
  const selfUnbindNonce = nonce('self-unbind');
  const selfUnbind = await request(baseUrl, 'POST', '/api/v1/client/unbind', {
    body: {
      appId: application.id,
      sessionToken: primaryReactivation.payload.data.payload.sessionToken,
      deviceId: 'device-primary-001',
      clientVersion: '1.0.1',
      timestamp: Date.now(),
      nonce: selfUnbindNonce,
    },
  });
  assert.equal(selfUnbind.status, 200);
  assert.equal(selfUnbind.payload.data.payload.unbound, true);
  assert.equal(selfUnbind.payload.data.payload.code, 'DEVICE_UNBOUND');
  assert.equal(selfUnbind.payload.data.payload.bindingId, activation.payload.data.payload.bindingId);
  assert.equal(selfUnbind.payload.data.payload.requestNonce, selfUnbindNonce);
  assert.equal(verifySignedEnvelope(selfUnbind.payload.data, application.signing.publicKey), true);
  const verifyAfterSelfUnbind = await request(baseUrl, 'POST', '/api/v1/client/verify', {
    body: {
      appId: application.id,
      sessionToken: primaryReactivation.payload.data.payload.sessionToken,
      deviceId: 'device-primary-001',
      timestamp: Date.now(),
      nonce: nonce('verify-after-self-unbind'),
    },
  });
  assert.equal(verifyAfterSelfUnbind.status, 401);
  assert.equal(verifyAfterSelfUnbind.payload.error.code, 'SESSION_EXPIRED');

  const unbindPrimary = await request(baseUrl, 'POST', `/api/v1/device-bindings/${activation.payload.data.payload.bindingId}/unbind`, {
    token: merchantToken,
    body: {},
  });
  assert.equal(unbindPrimary.status, 200);
  assert.equal(unbindPrimary.payload.data.status, 'revoked');
  const reboundAfterUnbind = await request(baseUrl, 'POST', '/api/v1/client/activate', {
    body: {
      appId: application.id,
      licenseKey: plaintextLicense,
      deviceId: 'device-secondary-002',
      timestamp: Date.now(),
      nonce: nonce('rebind-after-unbind'),
    },
  });
  assert.equal(reboundAfterUnbind.status, 200);
  assert.notEqual(reboundAfterUnbind.payload.data.payload.bindingId, activation.payload.data.payload.bindingId);

  // Author: 花落. Bulk device revocation coverage is provided under the MIT License.
  const crossTenantKeyReveal = await request(baseUrl, 'POST', `/api/v1/licenses/${licenseId}/reveal-key`, {
    token: merchantBLogin.payload.data.token,
    body: {},
  });
  assert.equal(crossTenantKeyReveal.status, 403);
  assert.equal(crossTenantKeyReveal.payload.error.code, 'FORBIDDEN');
  const deletableActivation = await request(baseUrl, 'POST', '/api/v1/client/activate', {
    body: {
      appId: application.id,
      licenseKey: deletableLicense.key,
      deviceId: 'deletable-device-001',
      timestamp: Date.now(),
      nonce: nonce('deletable-license'),
    },
  });
  assert.equal(deletableActivation.status, 200);
  const crossTenantDelete = await request(baseUrl, 'DELETE', `/api/v1/licenses/${deletableLicense.id}`, {
    token: merchantBLogin.payload.data.token,
  });
  assert.equal(crossTenantDelete.status, 403);
  assert.equal(crossTenantDelete.payload.error.code, 'FORBIDDEN');
  const deleteLicense = await request(baseUrl, 'DELETE', `/api/v1/licenses/${deletableLicense.id}`, {
    token: merchantToken,
  });
  assert.equal(deleteLicense.status, 200);
  assert.deepEqual(deleteLicense.payload.data, { licenseId: deletableLicense.id, deletedBindings: 1 });
  const verificationAfterDelete = await request(baseUrl, 'POST', '/api/v1/client/verify', {
    body: {
      appId: application.id,
      sessionToken: deletableActivation.payload.data.payload.sessionToken,
      deviceId: 'deletable-device-001',
      timestamp: Date.now(),
      nonce: nonce('deleted-license-session'),
    },
  });
  assert.equal(verificationAfterDelete.status, 401);
  assert.equal(verificationAfterDelete.payload.error.code, 'SESSION_EXPIRED');
  const deletedLicenseActivation = await request(baseUrl, 'POST', '/api/v1/client/activate', {
    body: {
      appId: application.id,
      licenseKey: deletableLicense.key,
      deviceId: 'deletable-device-002',
      timestamp: Date.now(),
      nonce: nonce('deleted-license-activation'),
    },
  });
  assert.equal(deletedLicenseActivation.status, 401);
  assert.equal(deletedLicenseActivation.payload.error.code, 'LICENSE_INVALID');
  const crossTenantBulkUnbind = await request(baseUrl, 'POST', `/api/v1/licenses/${licenseId}/unbind-all`, {
    token: merchantBLogin.payload.data.token,
    body: {},
  });
  assert.equal(crossTenantBulkUnbind.status, 403);
  assert.equal(crossTenantBulkUnbind.payload.error.code, 'FORBIDDEN');
  const unbindAll = await request(baseUrl, 'POST', `/api/v1/licenses/${licenseId}/unbind-all`, {
    token: merchantToken,
    body: {},
  });
  assert.equal(unbindAll.status, 200);
  assert.deepEqual(unbindAll.payload.data, { licenseId, unboundCount: 1 });
  const devicesAfterBulkUnbind = await request(baseUrl, 'GET', `/api/v1/licenses/${licenseId}/devices`, {
    token: merchantToken,
  });
  assert.equal(devicesAfterBulkUnbind.status, 200);
  assert.equal(devicesAfterBulkUnbind.payload.data.every((binding) => binding.status === 'revoked'), true);
  const verificationAfterBulkUnbind = await request(baseUrl, 'POST', '/api/v1/client/verify', {
    body: {
      appId: application.id,
      sessionToken: reboundAfterUnbind.payload.data.payload.sessionToken,
      deviceId: 'device-secondary-002',
      timestamp: Date.now(),
      nonce: nonce('bulk-unbind'),
    },
  });
  assert.equal(verificationAfterBulkUnbind.status, 401);
  assert.equal(verificationAfterBulkUnbind.payload.error.code, 'SESSION_EXPIRED');
  const repeatedBulkUnbind = await request(baseUrl, 'POST', `/api/v1/licenses/${licenseId}/unbind-all`, {
    token: merchantToken,
    body: {},
  });
  assert.equal(repeatedBulkUnbind.status, 200);
  assert.deepEqual(repeatedBulkUnbind.payload.data, { licenseId, unboundCount: 0 });

  const unlimitedBatch = await request(baseUrl, 'POST', `/api/v1/apps/${application.id}/license-batches`, {
    token: merchantToken,
    body: { count: 1, durationDays: 7, maxDevices: 0, batchName: 'Unlimited Devices' },
  });
  assert.equal(unlimitedBatch.status, 201);
  assert.equal(unlimitedBatch.payload.data.licenses[0].maxDevices, 0);
  const unlimitedLicense = unlimitedBatch.payload.data.licenses[0].key;
  const unlimitedPrimary = await request(baseUrl, 'POST', '/api/v1/client/activate', {
    body: {
      appId: application.id,
      licenseKey: unlimitedLicense,
      deviceId: 'unlimited-device-001',
      timestamp: Date.now(),
      nonce: nonce('unlimited-device-1'),
    },
  });
  assert.equal(unlimitedPrimary.status, 200);
  const unlimitedSecondary = await request(baseUrl, 'POST', '/api/v1/client/activate', {
    body: {
      appId: application.id,
      licenseKey: unlimitedLicense,
      deviceId: 'unlimited-device-002',
      timestamp: Date.now(),
      nonce: nonce('unlimited-device-2'),
    },
  });
  assert.equal(unlimitedSecondary.status, 200);

  const disableLicense = await request(baseUrl, 'PATCH', `/api/v1/licenses/${licenseId}/status`, {
    token: merchantToken,
    body: { status: 'disabled' },
  });
  assert.equal(disableLicense.status, 200);
  assert.equal(disableLicense.payload.data.status, 'disabled');

  const verificationAfterDisable = await request(baseUrl, 'POST', '/api/v1/client/verify', {
    body: {
      appId: application.id,
      sessionToken,
      deviceId: 'device-primary-001',
      timestamp: Date.now(),
      nonce: nonce('disabled'),
    },
  });
  assert.equal(verificationAfterDisable.status, 401);
  assert.equal(verificationAfterDisable.payload.error.code, 'SESSION_EXPIRED');

  const logs = await request(baseUrl, 'GET', `/api/v1/apps/${application.id}/verification-logs`, {
    token: merchantToken,
  });
  assert.equal(logs.status, 200);
  assert.equal(logs.payload.data.total, 7);
  const validationLogs = logs.payload.data.items.filter((item) => ['activate', 'verify'].includes(item.event));
  assert.equal(validationLogs.length, 6);
  assert.equal(validationLogs.every((item) => item.resultCode === 'LICENSE_VALID'), true);
  assert.equal(logs.payload.data.items.some((item) => item.event === 'unbind' && item.resultCode === 'DEVICE_UNBOUND'), true);
  // Rejected requests are not persisted, and a successful unbind is not a verification failure.
  const verificationDashboard = await request(baseUrl, 'GET', `/api/v1/dashboard?appId=${application.id}`, {
    token: merchantToken,
  });
  assert.equal(verificationDashboard.status, 200);
  assert.deepEqual(verificationDashboard.payload.data.verification24h, { total: 6, successful: 6, failed: 0 });

  const resetMerchantBPassword = await request(
    baseUrl,
    'POST',
    `/api/v1/users/${createAdminB.payload.data.id}/password/reset`,
    {
      token: platformToken,
      body: { newPassword: 'Merchant-B-New-Password!' },
    },
  );
  assert.equal(resetMerchantBPassword.status, 200);
  assert.equal(resetMerchantBPassword.payload.data.user.id, createAdminB.payload.data.id);
  const revokedMerchantBSession = await request(baseUrl, 'GET', '/api/v1/auth/me', {
    token: merchantBLogin.payload.data.token,
  });
  assert.equal(revokedMerchantBSession.status, 401);
  const oldMerchantBLogin = await request(baseUrl, 'POST', '/api/v1/auth/login', {
    body: { username: 'merchant.b.admin', password: 'Merchant-B-Password!' },
  });
  assert.equal(oldMerchantBLogin.status, 401);
  const newMerchantBLogin = await request(baseUrl, 'POST', '/api/v1/auth/login', {
    body: { username: 'merchant.b.admin', password: 'Merchant-B-New-Password!' },
  });
  assert.equal(newMerchantBLogin.status, 200);

  const wrongCurrentPassword = await request(baseUrl, 'POST', '/api/v1/auth/password', {
    token: merchantToken,
    body: {
      currentPassword: 'Wrong-Current-Password!',
      newPassword: 'Merchant-A-New-Password!',
    },
  });
  assert.equal(wrongCurrentPassword.status, 400);
  assert.equal(wrongCurrentPassword.payload.error.code, 'CURRENT_PASSWORD_INVALID');
  const sessionAfterWrongPassword = await request(baseUrl, 'GET', '/api/v1/auth/me', {
    token: merchantToken,
  });
  assert.equal(sessionAfterWrongPassword.status, 200);
  const changeOwnPassword = await request(baseUrl, 'POST', '/api/v1/auth/password', {
    token: merchantToken,
    body: {
      currentPassword: 'Merchant-A-Password!',
      newPassword: 'Merchant-A-New-Password!',
    },
  });
  assert.equal(changeOwnPassword.status, 200);
  assert.equal(changeOwnPassword.payload.data.passwordChanged, true);
  const revokedOwnSession = await request(baseUrl, 'GET', '/api/v1/auth/me', {
    token: merchantToken,
  });
  assert.equal(revokedOwnSession.status, 401);
  const oldMerchantALogin = await request(baseUrl, 'POST', '/api/v1/auth/login', {
    body: { username: 'merchant.a.admin', password: 'Merchant-A-Password!' },
  });
  assert.equal(oldMerchantALogin.status, 401);
  const newMerchantALogin = await request(baseUrl, 'POST', '/api/v1/auth/login', {
    body: { username: 'merchant.a.admin', password: 'Merchant-A-New-Password!' },
  });
  assert.equal(newMerchantALogin.status, 200);
});
