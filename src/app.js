import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { Router } from './http/router.js';
import { registerRoutes } from './http/routes.js';
import { StaticServer } from './http/static-server.js';
import { loadOrCreateRootSecret } from './security/crypto.js';
import { createSecurityState } from './security/security-state.js';
import { ApplicationService } from './services/application-service.js';
import { AuditService } from './services/audit-service.js';
import { AuthService } from './services/auth-service.js';
import { LicenseService } from './services/license-service.js';
import { MerchantService } from './services/merchant-service.js';
import { OrderService } from './services/order-service.js';
import { ProductService } from './services/product-service.js';
import { VerificationService } from './services/verification-service.js';
import { DashboardService } from './services/dashboard-service.js';
import { MaintenanceService } from './services/maintenance-service.js';
import { OnlineDeviceService } from './services/online-device-service.js';
import { ModelDeliveryService } from './services/model-delivery-service.js';
import { AnnouncementService } from './services/announcement-service.js';
import { createStore } from './storage/create-store.js';
import { isStorageUnavailableError } from './storage/storage-error.js';

// Author: 花落. This project is provided under the MIT License.
export async function createRuntime(configOverrides = {}) {
  const config = loadConfig(configOverrides);
  const rootSecret = await loadOrCreateRootSecret(config.secretFile);
  const store = await createStore(config);
  let securityState;
  try {
    securityState = await createSecurityState(config);
  } catch (error) {
    await store.close();
    throw error;
  }
  let lifecycle = 'running';
  let activeRequests = 0;
  let idleResolvers = [];
  let closePromise = null;

  const beginRequest = () => {
    if (lifecycle !== 'running') return false;
    activeRequests += 1;
    return true;
  };

  const endRequest = () => {
    activeRequests = Math.max(0, activeRequests - 1);
    if (activeRequests === 0 && idleResolvers.length) {
      const resolvers = idleResolvers;
      idleResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  };

  const waitForRequestsToDrain = (timeoutMs) => {
    if (activeRequests === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (drained) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const index = idleResolvers.indexOf(onIdle);
        if (index >= 0) idleResolvers.splice(index, 1);
        resolve(drained);
      };
      const onIdle = () => finish(true);
      idleResolvers.push(onIdle);
      timer = setTimeout(() => finish(false), timeoutMs);
    });
  };

  const waitForServerClose = (promise, timeoutMs) => new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    promise.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });

  // 花落 / MIT：公告服务先于其他服务创建，供 VerificationService 在签名载荷里携带公告。
  const announcements = new AnnouncementService(store, rootSecret, config);
  const services = {
    auth: new AuthService(store, rootSecret, config, securityState),
    merchants: new MerchantService(store),
    applications: new ApplicationService(store, rootSecret, config),
    licenses: new LicenseService(store, rootSecret, config),
    products: new ProductService(store),
    orders: new OrderService(store, rootSecret),
    audit: new AuditService(store),
    verification: new VerificationService(store, rootSecret, config, securityState, announcements),
    dashboard: new DashboardService(store),
    onlineDevices: new OnlineDeviceService(store, config),
    maintenance: new MaintenanceService(store),
    announcements,
    modelDelivery: null,
    readiness: {
      async check() {
        const [storage, security] = await Promise.all([store.ping(), securityState.ping()]);
        return { storage, security, rootKey: rootSecret.length > 0 };
      },
    },
  };
  services.modelDelivery = new ModelDeliveryService(store, rootSecret, config, services.verification);
  const router = new Router({
    authService: services.auth,
    config,
    securityState,
    requestGate: () => lifecycle === 'running',
  });
  registerRoutes(router, services);
  const staticServer = new StaticServer(config.publicDirectory);
  const server = createServer(async (request, responseStream) => {
    if (!beginRequest()) {
      responseStream.setHeader('Content-Type', 'application/json; charset=utf-8');
      responseStream.setHeader('Connection', 'close');
      responseStream.setHeader('Retry-After', '5');
      responseStream.writeHead(503);
      responseStream.end(JSON.stringify({
        success: false,
        error: { code: 'SERVER_SHUTTING_DOWN', message: 'Server is shutting down' },
      }));
      return;
    }
    try {
      if (await staticServer.handle(request, responseStream)) {
        return;
      }
      await router.handle(request, responseStream);
    } catch (error) {
      console.error('Unhandled HTTP server error', error);
      const storageUnavailable = isStorageUnavailableError(error);
      if (!responseStream.headersSent) {
        responseStream.writeHead(storageUnavailable ? 503 : 500, {
          'Content-Type': 'application/json; charset=utf-8',
          ...(storageUnavailable ? { 'Retry-After': '5' } : {}),
        });
      }
      responseStream.end(JSON.stringify({
        success: false,
        error: {
          code: storageUnavailable ? 'STORAGE_UNAVAILABLE' : 'INTERNAL_ERROR',
        },
      }));
    } finally {
      endRequest();
    }
  });

  return {
    config,
    store,
    services,
    server,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    isAcceptingRequests() {
      return lifecycle === 'running';
    },
    async close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        lifecycle = 'closing';
        let forceClosed = false;
        const serverClosed = server.listening
          ? new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          })
          : Promise.resolve();

        // Stop new connections immediately and let active handlers finish first.
        if (activeRequests === 0) server.closeIdleConnections?.();
        const drained = await waitForRequestsToDrain(config.shutdownTimeoutMs);
        if (!drained) {
          console.warn(`Graceful shutdown timed out with ${activeRequests} active request(s).`);
          server.closeAllConnections?.();
          forceClosed = true;
        }
        server.closeIdleConnections?.();

        const resourceResults = await Promise.allSettled([
          store.close(),
          securityState.close(),
        ]);
        const serverResult = await Promise.allSettled([
          forceClosed
            ? waitForServerClose(serverClosed, config.shutdownTimeoutMs)
            : serverClosed,
        ]);
        lifecycle = 'closed';
        const failure = [...serverResult, ...resourceResults]
          .find((result) => result.status === 'rejected');
        if (failure) throw failure.reason;
      })();
      return closePromise;
    },
  };
}
