import { randomUUID } from 'node:crypto';
import { AppError } from '../core/app-error.js';
import { requireEnum, requireString } from '../core/validation.js';
import {
  assertMerchantAccess,
  assertRole,
  findMerchantOrThrow,
  Roles,
} from './access-control.js';
import { AuditService } from './audit-service.js';
import { presentMerchant } from './presenters.js';

const MERCHANT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

export class MerchantService {
  constructor(store) {
    this.store = store;
  }

  async create(actor, input) {
    assertRole(actor, [Roles.PLATFORM_ADMIN]);
    const code = requireString(input.code, 'code', {
      min: 2,
      max: 32,
      pattern: MERCHANT_CODE_PATTERN,
    }).toUpperCase();
    const name = requireString(input.name, 'name', { min: 2, max: 100 });

    return this.store.transaction((state) => {
      if (state.merchants.some((merchant) => merchant.code === code)) {
        throw new AppError('MERCHANT_CODE_EXISTS', 'Merchant code already exists', 409);
      }
      const now = new Date().toISOString();
      const merchant = {
        id: randomUUID(),
        code,
        name,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      state.merchants.push(merchant);
      AuditService.append(state, {
        actor,
        merchantId: merchant.id,
        action: 'merchant.create',
        resourceType: 'merchant',
        resourceId: merchant.id,
        metadata: { code },
      });
      return presentMerchant(merchant);
    });
  }

  async list(actor) {
    assertRole(actor, [Roles.PLATFORM_ADMIN]);
    return this.store.read((state) => state.merchants.map(presentMerchant));
  }

  async get(actor, merchantId) {
    assertMerchantAccess(actor, merchantId);
    return this.store.read((state) => presentMerchant(findMerchantOrThrow(state, merchantId)));
  }

  async setStatus(actor, merchantId, status) {
    assertRole(actor, [Roles.PLATFORM_ADMIN]);
    const nextStatus = requireEnum(status, 'status', ['active', 'disabled']);
    return this.store.transaction((state) => {
      const merchant = findMerchantOrThrow(state, merchantId);
      merchant.status = nextStatus;
      merchant.updatedAt = new Date().toISOString();
      if (nextStatus === 'disabled') {
        const userIds = new Set(state.users.filter((user) => user.merchantId === merchantId).map((user) => user.id));
        state.adminSessions = state.adminSessions.filter((session) => !userIds.has(session.userId));
        state.clientSessions = state.clientSessions.filter((session) => session.merchantId !== merchantId);
      }
      AuditService.append(state, {
        actor,
        merchantId,
        action: 'merchant.status.update',
        resourceType: 'merchant',
        resourceId: merchantId,
        metadata: { status: nextStatus },
      });
      return presentMerchant(merchant);
    });
  }
}
