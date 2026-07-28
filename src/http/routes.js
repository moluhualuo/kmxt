import { requireObject, parsePagination } from '../core/validation.js';
import { Roles } from '../services/access-control.js';
import { response } from './router.js';

const ADMIN_ROLES = [Roles.PLATFORM_ADMIN, Roles.MERCHANT_ADMIN, Roles.OPERATOR];
const OWNER_ROLES = [Roles.PLATFORM_ADMIN, Roles.MERCHANT_ADMIN];
const LOGIN_LIMIT = { limit: 10, windowSeconds: 60 };
const ADMIN_LIMIT = { limit: 180, windowSeconds: 60 };
const CLIENT_LIMIT = { limit: 300, windowSeconds: 60 };
const MODEL_LEASE_LIMIT = { limit: 30, windowSeconds: 60 };
const STORE_READ_LIMIT = { limit: 120, windowSeconds: 60 };
const STORE_ORDER_LIMIT = { limit: 10, windowSeconds: 60 };
const STORE_QUERY_LIMIT = { limit: 30, windowSeconds: 60 };

export function registerRoutes(router, services) {
  router.add('GET', '/health', { rateLimit: ADMIN_LIMIT }, async () => ({
    status: 'ok',
    service: 'kmxt-license-server',
    version: '0.7.0',
    time: new Date().toISOString(),
  }));
  router.add('GET', '/ready', { rateLimit: ADMIN_LIMIT }, async () => ({ status: 'ready', checks: await services.readiness.check() }));
  router.add('GET', '/api/v1/dashboard', { auth: true, roles: ADMIN_ROLES, rateLimit: ADMIN_LIMIT }, async ({ user, query }) => services.dashboard.get(user, { merchantId: query.get('merchantId'), appId: query.get('appId') }));

  router.add('POST', '/api/v1/auth/login', { rateLimit: LOGIN_LIMIT }, async ({ body }) => {
    return services.auth.login(requireObject(body));
  });
  router.add('GET', '/api/v1/auth/me', { auth: true, roles: ADMIN_ROLES, rateLimit: ADMIN_LIMIT }, async ({ user }) => user);
  router.add('POST', '/api/v1/auth/logout', { auth: true, roles: ADMIN_ROLES, rateLimit: ADMIN_LIMIT }, async ({ user, token }) => {
    await services.auth.logout(user, token);
    return { loggedOut: true };
  });
  router.add('POST', '/api/v1/auth/password', { auth: true, roles: ADMIN_ROLES, rateLimit: LOGIN_LIMIT }, async ({ user, body }) => {
    return services.auth.changePassword(user, requireObject(body));
  });

  router.add('GET', '/api/v1/platform/merchants', {
    auth: true,
    roles: [Roles.PLATFORM_ADMIN],
    rateLimit: ADMIN_LIMIT,
  }, async ({ user }) => services.merchants.list(user));
  router.add('POST', '/api/v1/platform/merchants', {
    auth: true,
    roles: [Roles.PLATFORM_ADMIN],
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, body }) => response(201, await services.merchants.create(user, requireObject(body))));
  router.add('GET', '/api/v1/merchants/:merchantId', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params }) => services.merchants.get(user, params.merchantId));
  router.add('PATCH', '/api/v1/platform/merchants/:merchantId/status', {
    auth: true,
    roles: [Roles.PLATFORM_ADMIN],
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, body }) => services.merchants.setStatus(
    user,
    params.merchantId,
    requireObject(body).status,
  ));
  router.add('PATCH', '/api/v1/platform/merchants/:merchantId', { auth: true, roles: [Roles.PLATFORM_ADMIN], rateLimit: ADMIN_LIMIT }, async ({ user, params, body }) => services.merchants.update(user, params.merchantId, requireObject(body)));

  router.add('GET', '/api/v1/merchants/:merchantId/users', {
    auth: true,
    roles: OWNER_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params }) => services.auth.listMerchantUsers(user, params.merchantId));
  router.add('POST', '/api/v1/merchants/:merchantId/users', {
    auth: true,
    roles: OWNER_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, body }) => response(201, await services.auth.createMerchantUser(
    user,
    params.merchantId,
    requireObject(body),
  )));
  router.add('POST', '/api/v1/users/:userId/password/reset', {
    auth: true,
    roles: OWNER_ROLES,
    rateLimit: LOGIN_LIMIT,
  }, async ({ user, params, body }) => services.auth.resetMerchantUserPassword(
    user,
    params.userId,
    requireObject(body),
  ));
  router.add('PATCH', '/api/v1/users/:userId/status', { auth: true, roles: OWNER_ROLES, rateLimit: ADMIN_LIMIT }, async ({ user, params, body }) => services.auth.setUserStatus(user, params.userId, requireObject(body).status));

  router.add('GET', '/api/v1/merchants/:merchantId/apps', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params }) => services.applications.list(user, params.merchantId));
  router.add('POST', '/api/v1/merchants/:merchantId/apps', {
    auth: true,
    roles: OWNER_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, body }) => response(201, await services.applications.create(
    user,
    params.merchantId,
    requireObject(body),
  )));
  router.add('GET', '/api/v1/apps/:appId', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params }) => services.applications.get(user, params.appId));
  router.add('GET', '/api/v1/apps/:appId/client-config', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params }) => services.applications.getClientConfig(user, params.appId));
  router.add('PATCH', '/api/v1/apps/:appId/status', {
    auth: true,
    roles: OWNER_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, body }) => services.applications.setStatus(
    user,
    params.appId,
    requireObject(body).status,
  ));
  router.add('PATCH', '/api/v1/apps/:appId', { auth: true, roles: OWNER_ROLES, rateLimit: ADMIN_LIMIT }, async ({ user, params, body }) => services.applications.update(user, params.appId, requireObject(body)));

  router.add('POST', '/api/v1/apps/:appId/artifacts', {
    auth: true,
    roles: OWNER_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, body }) => response(201, await services.modelDelivery.register(
    user,
    params.appId,
    requireObject(body),
  )));
  router.add('GET', '/api/v1/apps/:appId/artifacts', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params }) => services.modelDelivery.list(user, params.appId));
  router.add('PATCH', '/api/v1/artifacts/:artifactId/status', {
    auth: true,
    roles: OWNER_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, body }) => services.modelDelivery.setStatus(
    user,
    params.artifactId,
    requireObject(body).status,
  ));
  router.add('DELETE', '/api/v1/artifacts/:artifactId', {
    auth: true,
    roles: OWNER_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params }) => services.modelDelivery.delete(user, params.artifactId));

  router.add('GET', '/api/v1/apps/:appId/products', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params }) => services.products.list(user, params.appId));
  router.add('POST', '/api/v1/apps/:appId/products', {
    auth: true,
    roles: OWNER_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, body }) => response(201, await services.products.create(
    user,
    params.appId,
    requireObject(body),
  )));
  router.add('PATCH', '/api/v1/products/:productId', {
    auth: true,
    roles: OWNER_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, body }) => services.products.update(
    user,
    params.productId,
    requireObject(body),
  ));
  router.add('PATCH', '/api/v1/products/:productId/status', {
    auth: true,
    roles: OWNER_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, body }) => services.products.setStatus(
    user,
    params.productId,
    requireObject(body).status,
  ));

  router.add('POST', '/api/v1/apps/:appId/license-batches', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, body }) => response(201, await services.licenses.generate(
    user,
    params.appId,
    requireObject(body),
  )));
  router.add('GET', '/api/v1/apps/:appId/license-batches', { auth: true, roles: ADMIN_ROLES, rateLimit: ADMIN_LIMIT }, async ({ user, params, query }) => services.licenses.listBatches(user, params.appId, parsePagination(query)));
  router.add('GET', '/api/v1/apps/:appId/licenses', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, query }) => services.licenses.list(
    user,
    params.appId,
    parsePagination(query),
    { status: query.get('status'), key: query.get('key') },
  ));
  router.add('POST', '/api/v1/apps/:appId/licenses/bulk-delete', {
    auth: true,
    roles: OWNER_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, body }) => services.licenses.bulkDelete(user, params.appId, requireObject(body)));
  router.add('PATCH', '/api/v1/licenses/:licenseId/status', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, body }) => services.licenses.setStatus(
    user,
    params.licenseId,
    requireObject(body).status,
  ));
  // Author: 花落. Owner-only key disclosure and removal routes are provided under the MIT License.
  router.add('POST', '/api/v1/licenses/:licenseId/reveal-key', {
    auth: true,
    roles: OWNER_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params }) => services.licenses.revealKey(user, params.licenseId));
  router.add('DELETE', '/api/v1/licenses/:licenseId', {
    auth: true,
    roles: OWNER_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params }) => services.licenses.delete(user, params.licenseId));
  router.add('GET', '/api/v1/licenses/:licenseId/devices', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params }) => services.licenses.listDevices(user, params.licenseId));
  router.add('POST', '/api/v1/licenses/:licenseId/unbind-all', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params }) => services.licenses.unbindAllDevices(user, params.licenseId));
  router.add('POST', '/api/v1/device-bindings/:bindingId/unbind', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params }) => services.licenses.unbindDevice(user, params.bindingId));
  router.add('GET', '/api/v1/apps/:appId/online-devices', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, query }) => services.onlineDevices.list(
    user,
    params.appId,
    parsePagination(query),
    { status: query.get('status'), search: query.get('search') },
  ));
  router.add('POST', '/api/v1/device-bindings/:bindingId/disconnect', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params }) => services.onlineDevices.disconnect(user, params.bindingId));

  router.add('GET', '/api/v1/merchants/:merchantId/audit-logs', {
    auth: true,
    roles: OWNER_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, query }) => services.audit.list(
    user,
    params.merchantId,
    parsePagination(query),
    { action: query.get('action'), from: query.get('from'), to: query.get('to') },
  ));
  router.add('GET', '/api/v1/apps/:appId/verification-logs', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, query }) => services.audit.listVerification(
    user,
    params.appId,
    parsePagination(query),
    { event: query.get('event'), resultCode: query.get('resultCode'), from: query.get('from'), to: query.get('to') },
  ));

  router.add('GET', '/api/v1/merchants/:merchantId/orders', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, query }) => services.orders.list(
    user,
    params.merchantId,
    parsePagination(query),
    { status: query.get('status'), orderNo: query.get('orderNo'), from: query.get('from'), to: query.get('to') },
  ));
  router.add('POST', '/api/v1/orders/:orderId/fulfill', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params }) => services.orders.fulfill(user, params.orderId));
  router.add('POST', '/api/v1/orders/:orderId/reject', {
    auth: true,
    roles: ADMIN_ROLES,
    rateLimit: ADMIN_LIMIT,
  }, async ({ user, params, body }) => services.orders.reject(
    user,
    params.orderId,
    requireObject(body),
  ));

  router.add('GET', '/api/v1/store/:merchantCode', { rateLimit: STORE_READ_LIMIT }, async ({ params }) => {
    return services.products.getPublicStore(params.merchantCode);
  });
  router.add('POST', '/api/v1/store/:merchantCode/orders', { rateLimit: STORE_ORDER_LIMIT }, async ({ params, body }) => {
    return response(201, await services.orders.createPublic(params.merchantCode, requireObject(body)));
  });
  router.add('POST', '/api/v1/store/orders/query', { rateLimit: STORE_QUERY_LIMIT }, async ({ body }) => {
    return services.orders.queryPublic(requireObject(body));
  });

  router.add('GET', '/api/v1/client/apps/:appId/config', { rateLimit: CLIENT_LIMIT }, async ({ params }) => {
    return services.applications.getPublicConfig(params.appId);
  });
  router.add('POST', '/api/v1/client/activate', { rateLimit: CLIENT_LIMIT }, async ({ body, clientIp }) => {
    return services.verification.activate({ ...requireObject(body), clientIp });
  });
  router.add('POST', '/api/v1/client/verify', { rateLimit: CLIENT_LIMIT }, async ({ body, clientIp }) => {
    return services.verification.verify({ ...requireObject(body), clientIp });
  });
  router.add('POST', '/api/v1/client/unbind', { rateLimit: CLIENT_LIMIT }, async ({ body, clientIp }) => {
    return services.verification.unbind({ ...requireObject(body), clientIp });
  });
  router.add('POST', '/api/v1/client/artifacts/:artifactId/lease', {
    rateLimit: MODEL_LEASE_LIMIT,
  }, async ({ params, body, clientIp }) => services.modelDelivery.issueLease({
    ...requireObject(body),
    artifactId: params.artifactId,
    clientIp,
  }));

  // Admin API: 付费模型加密上传（WS7）。加密后 .vmp 密文直接回传下载，服务端只存 DEK+元数据。
  // 列表/吊销复用现有的 GET /api/v1/apps/:appId/artifacts 与 PATCH /api/v1/artifacts/:id/status。
  router.add('POST', '/api/v1/admin/artifacts/upload', {
    auth: true,
    roles: OWNER_ROLES,
    rateLimit: ADMIN_LIMIT,
    rawBody: true,
  }, async ({ user, request }) => {
    const adminArtifacts = await import('../routes/admin-artifacts.js');
    return adminArtifacts.handleUpload(user, request, services);
  });
}
