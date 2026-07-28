import { assertMerchantAccess, findApplicationOrThrow, Roles } from './access-control.js';

export const DASHBOARD_VERIFICATION_EVENTS = Object.freeze(['activate', 'verify']);
export const DASHBOARD_VERIFICATION_SUCCESS_CODE = 'LICENSE_VALID';

// Author: 花落. Dashboard aggregation is provided under the MIT License.
export class DashboardService {
  constructor(store) { this.store = store; }

  async get(actor, filters = {}) {
    if (typeof this.store.dashboard === 'function') return this.store.dashboard(actor, filters);
    return this.store.read((state) => {
      const merchantId = filters.merchantId || (actor.role === Roles.PLATFORM_ADMIN ? null : actor.merchantId);
      if (merchantId) assertMerchantAccess(actor, merchantId);
      if (filters.appId) {
        const app = findApplicationOrThrow(state, filters.appId);
        assertMerchantAccess(actor, app.merchantId);
        if (merchantId && app.merchantId !== merchantId) return this.#empty();
      }
      const merchants = state.merchants.filter((item) => !merchantId || item.id === merchantId);
      const merchantIds = new Set(merchants.map((item) => item.id));
      const apps = state.applications.filter((item) => merchantIds.has(item.merchantId) && (!filters.appId || item.id === filters.appId));
      const appIds = new Set(apps.map((item) => item.id));
      const licenses = state.licenses.filter((item) => appIds.has(item.appId));
      const licenseIds = new Set(licenses.map((item) => item.id));
      const since = Date.now() - 86400000;
      const recent = state.verificationLogs.filter((item) => appIds.has(item.appId)
        && DASHBOARD_VERIFICATION_EVENTS.includes(item.event)
        && Date.parse(item.createdAt) >= since);
      const successful = recent.filter((item) => item.resultCode === DASHBOARD_VERIFICATION_SUCCESS_CODE).length;
      return {
        merchants: merchants.length,
        applications: apps.length,
        pendingOrders: state.orders.filter((item) => merchantIds.has(item.merchantId) && (!filters.appId || item.appId === filters.appId) && item.status === 'pending').length,
        licenses: licenses.length,
        activeBindings: state.deviceBindings.filter((item) => licenseIds.has(item.licenseId) && item.status === 'active').length,
        // Failed means a recorded activation/verification event without LICENSE_VALID.
        verification24h: { total: recent.length, successful, failed: recent.length - successful },
      };
    });
  }

  #empty() {
    return { merchants: 0, applications: 0, pendingOrders: 0, licenses: 0, activeBindings: 0, verification24h: { total: 0, successful: 0, failed: 0 } };
  }
}
