import { randomUUID } from 'node:crypto';
import { assertMerchantAccess, findApplicationOrThrow } from './access-control.js';

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

  async list(user, merchantId, pagination) {
    assertMerchantAccess(user, merchantId);
    return this.store.read((state) => {
      const all = state.auditLogs
        .filter((entry) => entry.merchantId === merchantId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return {
        items: all.slice(pagination.offset, pagination.offset + pagination.limit),
        page: pagination.page,
        limit: pagination.limit,
        total: all.length,
      };
    });
  }

  async listVerification(user, appId, pagination) {
    return this.store.read((state) => {
      const application = findApplicationOrThrow(state, appId);
      assertMerchantAccess(user, application.merchantId);
      const all = state.verificationLogs
        .filter((entry) => entry.appId === appId)
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
