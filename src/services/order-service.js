import { randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../core/app-error.js';
import {
  optionalString,
  requireEnum,
  requireString,
} from '../core/validation.js';
import {
  createOpaqueToken,
  decryptText,
  digestSecret,
  encryptText,
  generateLicenseKey,
  normalizeLicenseKey,
  previewLicenseKey,
} from '../security/crypto.js';
import {
  assertMerchantAccess,
  findApplicationOrThrow,
  findMerchantOrThrow,
} from './access-control.js';
import { AuditService } from './audit-service.js';
import { presentOrder } from './presenters.js';

function createOrderNumber(now = new Date()) {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `KMO-${day}-${randomBytes(5).toString('hex').toUpperCase()}`;
}

function maskContact(value) {
  const emailParts = value.split('@');
  if (emailParts.length === 2 && emailParts[0] && emailParts[1]) {
    const visible = emailParts[0].slice(0, Math.min(2, emailParts[0].length));
    return `${visible}***@${emailParts[1]}`;
  }
  if (value.length <= 5) {
    return `${value.slice(0, 1)}***`;
  }
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function findOrderOrThrow(state, orderId) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) {
    throw new AppError('ORDER_NOT_FOUND', 'Order was not found', 404);
  }
  return order;
}

function presentPublicOrder(order, licenseKey = null) {
  return {
    orderNo: order.orderNo,
    product: order.productSnapshot,
    customerName: order.customerName,
    contact: order.contactMasked,
    note: order.note,
    status: order.status,
    licenseKey,
    rejectReason: order.rejectReason,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    fulfilledAt: order.fulfilledAt,
    rejectedAt: order.rejectedAt,
  };
}

export class OrderService {
  constructor(store, rootSecret) {
    this.store = store;
    this.rootSecret = rootSecret;
  }

  async createPublic(merchantCode, input) {
    const code = requireString(merchantCode, 'merchantCode', { min: 2, max: 32 }).toUpperCase();
    const productId = requireString(input.productId, 'productId', { min: 36, max: 36 });
    const customerName = optionalString(input.customerName, 'customerName', { min: 1, max: 80 });
    const contact = requireString(input.contact, 'contact', { min: 3, max: 120 });
    const note = optionalString(input.note, 'note', { min: 1, max: 500 });
    const queryCode = createOpaqueToken(24);
    const queryDigest = digestSecret(this.rootSecret, 'order-query', queryCode);
    const orderId = randomUUID();

    const order = await this.store.transaction((state) => {
      const merchant = state.merchants.find((item) => item.code === code);
      if (!merchant || merchant.status !== 'active') {
        throw new AppError('STOREFRONT_NOT_FOUND', 'Storefront was not found', 404);
      }
      const product = state.products.find((item) => item.id === productId);
      if (!product || product.merchantId !== merchant.id || product.status !== 'active') {
        throw new AppError('PRODUCT_UNAVAILABLE', 'Product is unavailable', 409);
      }
      const application = findApplicationOrThrow(state, product.appId, { requireActive: true });
      const now = new Date().toISOString();
      let orderNo = createOrderNumber();
      while (state.orders.some((item) => item.orderNo === orderNo)) {
        orderNo = createOrderNumber();
      }
      const created = {
        id: orderId,
        orderNo,
        merchantId: merchant.id,
        appId: application.id,
        productId: product.id,
        productSnapshot: {
          name: product.name,
          applicationName: application.name,
          priceCents: product.priceCents,
          currency: product.currency,
          durationDays: product.durationDays,
          maxDevices: product.maxDevices,
        },
        customerName,
        contactEncrypted: encryptText(this.rootSecret, `order-contact:${orderId}`, contact),
        contactMasked: maskContact(contact),
        contactDigest: digestSecret(this.rootSecret, `order-contact:${merchant.id}`, contact.toLowerCase()),
        note,
        queryDigest,
        status: 'pending',
        licenseId: null,
        licenseKeyEncrypted: null,
        rejectReason: null,
        createdAt: now,
        updatedAt: now,
        fulfilledAt: null,
        rejectedAt: null,
      };
      state.orders.push(created);
      AuditService.append(state, {
        merchantId: merchant.id,
        action: 'store_order.create',
        resourceType: 'order',
        resourceId: created.id,
        metadata: { orderNo, appId: application.id, productId: product.id },
      });
      return created;
    });
    return { ...presentPublicOrder(order), queryCode };
  }

  async queryPublic(input) {
    const orderNo = requireString(input.orderNo, 'orderNo', { min: 10, max: 40 }).toUpperCase();
    const queryCode = requireString(input.queryCode, 'queryCode', { min: 20, max: 128, normalize: false });
    const queryDigest = digestSecret(this.rootSecret, 'order-query', queryCode);
    return this.store.read((state) => {
      const order = state.orders.find((item) => item.orderNo === orderNo && item.queryDigest === queryDigest);
      if (!order) {
        throw new AppError('ORDER_QUERY_INVALID', 'Order number or query code is invalid', 401);
      }
      const licenseKey = order.status === 'fulfilled'
        ? decryptText(this.rootSecret, `order-license:${order.id}`, order.licenseKeyEncrypted)
        : null;
      return presentPublicOrder(order, licenseKey);
    });
  }

  async list(actor, merchantId, pagination, requestedStatus = null) {
    assertMerchantAccess(actor, merchantId);
    const status = requestedStatus
      ? requireEnum(requestedStatus, 'status', ['pending', 'fulfilled', 'rejected'])
      : null;
    return this.store.read((state) => {
      findMerchantOrThrow(state, merchantId);
      const all = state.orders
        .filter((order) => order.merchantId === merchantId && (!status || order.status === status))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return {
        items: all.slice(pagination.offset, pagination.offset + pagination.limit).map((order) => {
          const contact = decryptText(this.rootSecret, `order-contact:${order.id}`, order.contactEncrypted);
          const licenseKey = order.status === 'fulfilled'
            ? decryptText(this.rootSecret, `order-license:${order.id}`, order.licenseKeyEncrypted)
            : null;
          return presentOrder(order, { contact, licenseKey });
        }),
        page: pagination.page,
        limit: pagination.limit,
        total: all.length,
      };
    });
  }

  async fulfill(actor, orderId) {
    return this.store.transaction((state) => {
      const order = findOrderOrThrow(state, orderId);
      assertMerchantAccess(actor, order.merchantId);
      if (order.status === 'fulfilled') {
        return this.#presentAdminOrder(order);
      }
      if (order.status !== 'pending') {
        throw new AppError('ORDER_NOT_PENDING', 'Only pending orders can be fulfilled', 409);
      }
      const merchant = findMerchantOrThrow(state, order.merchantId, { requireActive: true });
      const application = findApplicationOrThrow(state, order.appId, { requireActive: true });
      const now = new Date().toISOString();
      let licenseKey;
      let keyDigest;
      do {
        licenseKey = generateLicenseKey(application.code);
        keyDigest = digestSecret(this.rootSecret, 'license-key', normalizeLicenseKey(licenseKey));
      } while (state.licenses.some((license) => license.keyDigest === keyDigest));

      const batch = {
        id: randomUUID(),
        merchantId: merchant.id,
        appId: application.id,
        name: `Order ${order.orderNo}`,
        count: 1,
        durationDays: order.productSnapshot.durationDays,
        fixedExpiresAt: null,
        maxDevices: order.productSnapshot.maxDevices,
        source: 'store_order',
        sourceId: order.id,
        createdBy: actor.id,
        createdAt: now,
      };
      const license = {
        id: randomUUID(),
        merchantId: merchant.id,
        appId: application.id,
        batchId: batch.id,
        keyDigest,
        keyPreview: previewLicenseKey(licenseKey),
        status: 'pending',
        durationDays: order.productSnapshot.durationDays,
        fixedExpiresAt: null,
        activatedAt: null,
        expiresAt: null,
        maxDevices: order.productSnapshot.maxDevices,
        createdAt: now,
        updatedAt: now,
      };
      state.licenseBatches.push(batch);
      state.licenses.push(license);
      order.status = 'fulfilled';
      order.licenseId = license.id;
      order.licenseKeyEncrypted = encryptText(this.rootSecret, `order-license:${order.id}`, licenseKey);
      order.fulfilledAt = now;
      order.updatedAt = now;
      AuditService.append(state, {
        actor,
        merchantId: order.merchantId,
        action: 'store_order.fulfill',
        resourceType: 'order',
        resourceId: order.id,
        metadata: { orderNo: order.orderNo, licenseId: license.id },
      });
      return this.#presentAdminOrder(order);
    });
  }

  async reject(actor, orderId, input) {
    const reason = requireString(input.reason, 'reason', { min: 2, max: 300 });
    return this.store.transaction((state) => {
      const order = findOrderOrThrow(state, orderId);
      assertMerchantAccess(actor, order.merchantId);
      if (order.status === 'rejected') {
        return this.#presentAdminOrder(order);
      }
      if (order.status !== 'pending') {
        throw new AppError('ORDER_NOT_PENDING', 'Only pending orders can be rejected', 409);
      }
      const now = new Date().toISOString();
      order.status = 'rejected';
      order.rejectReason = reason;
      order.rejectedAt = now;
      order.updatedAt = now;
      AuditService.append(state, {
        actor,
        merchantId: order.merchantId,
        action: 'store_order.reject',
        resourceType: 'order',
        resourceId: order.id,
        metadata: { orderNo: order.orderNo },
      });
      return this.#presentAdminOrder(order);
    });
  }

  #presentAdminOrder(order) {
    const contact = decryptText(this.rootSecret, `order-contact:${order.id}`, order.contactEncrypted);
    const licenseKey = order.status === 'fulfilled'
      ? decryptText(this.rootSecret, `order-license:${order.id}`, order.licenseKeyEncrypted)
      : null;
    return presentOrder(order, { contact, licenseKey });
  }
}
