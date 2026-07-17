import { AppError } from '../../core/app-error.js';
import { Roles } from '../../services/access-control.js';

function parsePayload(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function pageLimit(pagination) { return Math.max(1, Math.trunc(Number(pagination.limit) || 20)); }
function pageOffset(pagination) { return Math.max(0, Math.trunc(Number(pagination.offset) || 0)); }

function assertMerchantAccess(actor, merchantId) {
  if (actor.role !== Roles.PLATFORM_ADMIN && actor.merchantId !== merchantId) {
    throw new AppError('FORBIDDEN', 'Cross-merchant access is not allowed', 403);
  }
}

function dateValue(value) { return value ? new Date(value) : null; }

// Author: 花落. Scoped MySQL audit and verification log reads are MIT licensed.
export class MysqlAuditRepository {
  constructor(pool) { this.pool = pool; }

  async list(actor, merchantId, pagination, filters) {
    assertMerchantAccess(actor, merchantId);
    const [merchantRows] = await this.pool.execute('SELECT id FROM merchants WHERE id = ?', [merchantId]);
    if (!merchantRows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
    const { where, values } = this.#auditWhere(merchantId, filters);
    const limit = pageLimit(pagination);
    const offset = pageOffset(pagination);
    const [[countRows], [rows]] = await Promise.all([
      this.pool.execute(`SELECT COUNT(*) AS total FROM audit_logs${where}`, values),
      this.pool.execute(`SELECT payload FROM audit_logs${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, values),
    ]);
    return { items: rows.map((row) => parsePayload(row.payload)), page: pagination.page, limit: pagination.limit, total: Number(countRows[0]?.total ?? 0) };
  }

  async listVerification(actor, appId, pagination, filters) {
    const [applicationRows] = await this.pool.execute('SELECT merchant_id FROM applications WHERE id = ?', [appId]);
    if (!applicationRows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    assertMerchantAccess(actor, applicationRows[0].merchant_id);
    const { where, values } = this.#verificationWhere(appId, filters);
    const limit = pageLimit(pagination);
    const offset = pageOffset(pagination);
    const [[countRows], [rows]] = await Promise.all([
      this.pool.execute(`SELECT COUNT(*) AS total FROM verification_logs${where}`, values),
      this.pool.execute(`SELECT payload FROM verification_logs${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, values),
    ]);
    return { items: rows.map((row) => parsePayload(row.payload)), page: pagination.page, limit: pagination.limit, total: Number(countRows[0]?.total ?? 0) };
  }

  #auditWhere(merchantId, filters) {
    const conditions = ['merchant_id = ?'];
    const values = [merchantId];
    if (filters.action) { conditions.push('action = ?'); values.push(filters.action); }
    if (filters.from) { conditions.push('created_at >= ?'); values.push(dateValue(filters.from)); }
    if (filters.to) { conditions.push('created_at <= ?'); values.push(dateValue(filters.to)); }
    return { where: ` WHERE ${conditions.join(' AND ')}`, values };
  }

  #verificationWhere(appId, filters) {
    const conditions = ['app_id = ?'];
    const values = [appId];
    if (filters.event) { conditions.push('event = ?'); values.push(filters.event); }
    if (filters.resultCode) { conditions.push('result_code = ?'); values.push(filters.resultCode); }
    if (filters.from) { conditions.push('created_at >= ?'); values.push(dateValue(filters.from)); }
    if (filters.to) { conditions.push('created_at <= ?'); values.push(dateValue(filters.to)); }
    return { where: ` WHERE ${conditions.join(' AND ')}`, values };
  }
}
