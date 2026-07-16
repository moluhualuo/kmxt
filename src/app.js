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
import { createStore } from './storage/create-store.js';

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
  const services = {
    auth: new AuthService(store, rootSecret, config),
    merchants: new MerchantService(store),
    applications: new ApplicationService(store, rootSecret, config),
    licenses: new LicenseService(store, rootSecret, config),
    products: new ProductService(store),
    orders: new OrderService(store, rootSecret),
    audit: new AuditService(store),
    verification: new VerificationService(store, rootSecret, config, securityState),
  };
  const router = new Router({ authService: services.auth, config, securityState });
  registerRoutes(router, services);
  const staticServer = new StaticServer(config.publicDirectory);
  const server = createServer(async (request, responseStream) => {
    try {
      if (await staticServer.handle(request, responseStream)) {
        return;
      }
      await router.handle(request, responseStream);
    } catch (error) {
      console.error('Unhandled HTTP server error', error);
      if (!responseStream.headersSent) {
        responseStream.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      responseStream.end(JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR' } }));
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
    async close() {
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await Promise.all([store.close(), securityState.close()]);
    },
  };
}
