import { randomUUID } from 'node:crypto';
import { AppError } from '../core/app-error.js';
import { assertMerchantAccess, findApplicationOrThrow } from './access-control.js';

function validateFilters(filters) {
  const from = filters.from ? Date.parse(filters.from) : null;
  const to = filters.to ? Date.parse(filters.to) : null;
  if ((filters.from && !Number.isFinite(from)) || (filters.to && !Number.isFinite(to)) || (from && to && from > to)) {
    throw new AppError('INVALID_TIME_RANGE', 'from and to must be a valid ascending ISO-8601 range', 400);
  }
  return { ...filters, from, to };
}

export class AuditService {
  constructor(store) {
    this.store = store;
  }

  static append(state, entry) {
    const now = new Date().toISOString();
    state.auditLogs.push({
      id: randomUUID(),
      merchantId: entry.merchantId ?? null,
      actorUserId: entry.actor?.id ?? null,
      actorUsername: entry.actor?.username ?? 'system',
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      metadata: entry.metadata ?? {},
      createdAt: now,
    });
  }

  async list(user, merchantId, pagination, filters = {}) {
    assertMerchantAccess(user, merchantId);
    const normalized = validateFilters(filters);
    if (this.store.repositories?.audit) {
      return this.store.repositories.audit.list(user, merchantId, pagination, normalized);
    }
    return this.store.read((state) => {
      const all = state.auditLogs
        .filter((entry) => entry.merchantId === merchantId
          && (!normalized.action || entry.action === normalized.action)
          && (!normalized.from || Date.parse(entry.createdAt) >= normalized.from)
          && (!normalized.to || Date.parse(entry.createdAt) <= normalized.to))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return {
        items: all.slice(pagination.offset, pagination.offset + pagination.limit),
        page: pagination.page,
        limit: pagination.limit,
        total: all.length,
      };
    });
  }

  async listVerification(user, appId, pagination, filters = {}) {
    const normalized = validateFilters(filters);
    if (this.store.repositories?.audit) {
      return this.store.repositories.audit.listVerification(user, appId, pagination, normalized);
    }
    return this.store.read((state) => {
      const application = findApplicationOrThrow(state, appId);
      assertMerchantAccess(user, application.merchantId);
      const all = state.verificationLogs
        .filter((entry) => entry.appId === appId
          && (!normalized.event || entry.event === normalized.event)
          && (!normalized.resultCode || entry.resultCode === normalized.resultCode)
          && (!normalized.from || Date.parse(entry.createdAt) >= normalized.from)
          && (!normalized.to || Date.parse(entry.createdAt) <= normalized.to))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return {
        items: all.slice(pagination.offset, pagination.offset + pagination.limit),
        page: pagination.page,
        limit: pagination.limit,
        total: all.length,
      };
    });
  }
}
