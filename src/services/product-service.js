import { randomUUID } from 'node:crypto';
import { AppError } from '../core/app-error.js';
import {
  optionalString,
  requireEnum,
  requireInteger,
  requireString,
} from '../core/validation.js';
import {
  assertMerchantAccess,
  assertRole,
  findApplicationOrThrow,
  findMerchantOrThrow,
  Roles,
} from './access-control.js';
import { AuditService } from './audit-service.js';
import { presentProduct } from './presenters.js';

function findProductOrThrow(state, productId) {
  const product = state.products.find((item) => item.id === productId);
  if (!product) {
    throw new AppError('PRODUCT_NOT_FOUND', 'Product was not found', 404);
  }
  return product;
}

function readProductInput(input, defaults = {}) {
  return {
    name: requireString(input.name ?? defaults.name, 'name', { min: 2, max: 100 }),
    description: optionalString(input.description ?? defaults.description, 'description', { min: 1, max: 500 }),
    priceCents: requireInteger(input.priceCents ?? defaults.priceCents ?? 0, 'priceCents', {
      min: 0,
      max: 99_999_999,
    }),
    durationDays: requireInteger(input.durationDays ?? defaults.durationDays ?? 30, 'durationDays', {
      min: 1,
      max: 3650,
    }),
    maxDevices: requireInteger(input.maxDevices ?? defaults.maxDevices ?? 1, 'maxDevices', {
      min: 0,
      max: 20,
    }),
    sortOrder: requireInteger(input.sortOrder ?? defaults.sortOrder ?? 0, 'sortOrder', {
      min: 0,
      max: 10000,
    }),
  };
}

export class ProductService {
  constructor(store) {
    this.store = store;
  }

  async create(actor, appId, input) {
    assertRole(actor, [Roles.PLATFORM_ADMIN, Roles.MERCHANT_ADMIN]);
    const values = readProductInput(input);
    return this.store.transaction((state) => {
      const application = findApplicationOrThrow(state, appId, { requireActive: true });
      assertMerchantAccess(actor, application.merchantId);
      findMerchantOrThrow(state, application.merchantId, { requireActive: true });
      const now = new Date().toISOString();
      const product = {
        id: randomUUID(),
        merchantId: application.merchantId,
        appId,
        ...values,
        currency: 'CNY',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      state.products.push(product);
      AuditService.append(state, {
        actor,
        merchantId: product.merchantId,
        action: 'product.create',
        resourceType: 'product',
        resourceId: product.id,
        metadata: { appId, durationDays: product.durationDays, maxDevices: product.maxDevices },
      });
      return presentProduct(product);
    });
  }

  async list(actor, appId) {
    return this.store.read((state) => {
      const application = findApplicationOrThrow(state, appId);
      assertMerchantAccess(actor, application.merchantId);
      return state.products
        .filter((product) => product.appId === appId)
        .sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt))
        .map(presentProduct);
    });
  }

  async update(actor, productId, input) {
    assertRole(actor, [Roles.PLATFORM_ADMIN, Roles.MERCHANT_ADMIN]);
    return this.store.transaction((state) => {
      const product = findProductOrThrow(state, productId);
      assertMerchantAccess(actor, product.merchantId);
      const values = readProductInput(input, product);
      Object.assign(product, values, { updatedAt: new Date().toISOString() });
      AuditService.append(state, {
        actor,
        merchantId: product.merchantId,
        action: 'product.update',
        resourceType: 'product',
        resourceId: product.id,
      });
      return presentProduct(product);
    });
  }

  async setStatus(actor, productId, requestedStatus) {
    assertRole(actor, [Roles.PLATFORM_ADMIN, Roles.MERCHANT_ADMIN]);
    const status = requireEnum(requestedStatus, 'status', ['active', 'disabled']);
    return this.store.transaction((state) => {
      const product = findProductOrThrow(state, productId);
      assertMerchantAccess(actor, product.merchantId);
      product.status = status;
      product.updatedAt = new Date().toISOString();
      AuditService.append(state, {
        actor,
        merchantId: product.merchantId,
        action: 'product.status.update',
        resourceType: 'product',
        resourceId: product.id,
        metadata: { status },
      });
      return presentProduct(product);
    });
  }

  async getPublicStore(merchantCode) {
    const code = requireString(merchantCode, 'merchantCode', { min: 2, max: 32 }).toUpperCase();
    return this.store.read((state) => {
      const merchant = state.merchants.find((item) => item.code === code);
      if (!merchant || merchant.status !== 'active') {
        throw new AppError('STOREFRONT_NOT_FOUND', 'Storefront was not found', 404);
      }
      const activeApps = new Map(
        state.applications
          .filter((app) => app.merchantId === merchant.id && app.status === 'active')
          .map((app) => [app.id, app]),
      );
      const products = state.products
        .filter((product) => product.merchantId === merchant.id
          && product.status === 'active'
          && activeApps.has(product.appId))
        .sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt))
        .map((product) => ({
          id: product.id,
          appId: product.appId,
          name: product.name,
          description: product.description,
          priceCents: product.priceCents,
          currency: product.currency,
          durationDays: product.durationDays,
          maxDevices: product.maxDevices,
          sortOrder: product.sortOrder,
          application: {
            id: product.appId,
            code: activeApps.get(product.appId).code,
            name: activeApps.get(product.appId).name,
          },
        }));
      return {
        merchant: { code: merchant.code, name: merchant.name },
        products,
        fulfillment: 'manual',
      };
    });
  }
}

export { findProductOrThrow };
