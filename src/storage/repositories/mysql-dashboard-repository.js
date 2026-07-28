import { AppError } from '../../core/app-error.js';
import { Roles } from '../../services/access-control.js';
import { DASHBOARD_VERIFICATION_EVENTS, DASHBOARD_VERIFICATION_SUCCESS_CODE } from '../../services/dashboard-service.js';

function countOf(rows) { return Number(rows[0]?.total ?? 0); }

const verificationEventPlaceholders = DASHBOARD_VERIFICATION_EVENTS.map(() => '?').join(', ');

// Author: 花落. Direct MySQL dashboard queries are provided under the MIT License.
export class MysqlDashboardRepository {
  constructor(pool) { this.pool = pool; }

  async get(actor, filters = {}) {
    let merchantId = filters.merchantId || (actor.role === Roles.PLATFORM_ADMIN ? null : actor.merchantId);
    if (merchantId && actor.role !== Roles.PLATFORM_ADMIN && actor.merchantId !== merchantId) {
      throw new AppError('FORBIDDEN', 'You do not have access to this merchant', 403);
    }
    if (merchantId) await this.#requireMerchant(merchantId);

    let appId = filters.appId || null;
    if (appId) {
      const [rows] = await this.pool.execute('SELECT id, merchant_id FROM applications WHERE id = ?', [appId]);
      const app = rows[0];
      if (!app) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
      if (actor.role !== Roles.PLATFORM_ADMIN && app.merchant_id !== actor.merchantId) {
        throw new AppError('FORBIDDEN', 'You do not have access to this merchant', 403);
      }
      if (merchantId && app.merchant_id !== merchantId) return this.#empty();
      merchantId = app.merchant_id;
    }

    const scope = this.#scope(merchantId, appId);
    const since = new Date(Date.now() - 86400000);
    const verificationWhere = scope.appWhere || ' WHERE 1 = 1';
    const [merchants, applications, pendingOrders, licenses, activeBindings, verification] = await Promise.all([
      this.pool.execute(`SELECT COUNT(*) AS total FROM merchants${merchantId ? ' WHERE id = ?' : ''}`, merchantId ? [merchantId] : []),
      this.pool.execute(`SELECT COUNT(*) AS total FROM applications${scope.applicationWhere}`, scope.applicationValues),
      this.pool.execute(`SELECT COUNT(*) AS total FROM orders${scope.orderWhere} AND status = 'pending'`, scope.orderValues),
      this.pool.execute(`SELECT COUNT(*) AS total FROM licenses${scope.appWhere}`, scope.appValues),
      this.pool.execute(`SELECT COUNT(*) AS total FROM device_bindings${scope.appWhere} AND status = 'active'`, scope.appValues),
      this.pool.execute(
        `SELECT COUNT(*) AS total, COALESCE(SUM(result_code = ?), 0) AS successful FROM verification_logs${verificationWhere} AND event IN (${verificationEventPlaceholders}) AND created_at >= ?`,
        [DASHBOARD_VERIFICATION_SUCCESS_CODE, ...scope.appValues, ...DASHBOARD_VERIFICATION_EVENTS, since],
      ),
    ]);
    const total = countOf(verification[0]);
    const successful = Number(verification[0][0]?.successful ?? 0);
    return {
      merchants: countOf(merchants[0]),
      applications: countOf(applications[0]),
      pendingOrders: countOf(pendingOrders[0]),
      licenses: countOf(licenses[0]),
      activeBindings: countOf(activeBindings[0]),
      verification24h: { total, successful, failed: total - successful },
    };
  }

  #scope(merchantId, appId) {
    if (appId) {
      return { applicationWhere: ' WHERE id = ?', applicationValues: [appId], appWhere: ' WHERE app_id = ?', appValues: [appId], orderWhere: ' WHERE app_id = ?', orderValues: [appId] };
    }
    if (merchantId) {
      return { applicationWhere: ' WHERE merchant_id = ?', applicationValues: [merchantId], appWhere: ' WHERE merchant_id = ?', appValues: [merchantId], orderWhere: ' WHERE merchant_id = ?', orderValues: [merchantId] };
    }
    return { applicationWhere: '', applicationValues: [], appWhere: '', appValues: [], orderWhere: ' WHERE 1 = 1', orderValues: [] };
  }

  async #requireMerchant(merchantId) {
    const [rows] = await this.pool.execute('SELECT id FROM merchants WHERE id = ?', [merchantId]);
    if (!rows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
  }

  #empty() {
    return { merchants: 0, applications: 0, pendingOrders: 0, licenses: 0, activeBindings: 0, verification24h: { total: 0, successful: 0, failed: 0 } };
  }
}
