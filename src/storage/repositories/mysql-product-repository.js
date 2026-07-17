import { randomUUID } from 'node:crypto';
import { AppError } from '../../core/app-error.js';
import { Roles } from '../../services/access-control.js';

function parsePayload(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function sqlDate(value) { return value ? new Date(value) : null; }

function parseProductRow(row) {
  const product = parsePayload(row.payload);
  if (Object.hasOwn(row, 'merchant_id')) product.merchantId = row.merchant_id;
  if (Object.hasOwn(row, 'app_id')) product.appId = row.app_id;
  if (Object.hasOwn(row, 'status')) product.status = row.status;
  return product;
}

function assertMerchantAccess(actor, merchantId) {
  if (actor.role !== Roles.PLATFORM_ADMIN && actor.merchantId !== merchantId) {
    throw new AppError('FORBIDDEN', 'Cross-merchant access is not allowed', 403);
  }
}

// Author: 花落. MySQL product and storefront access are modular MIT licensed components.
export class MysqlProductRepository {
  constructor(pool) { this.pool = pool; }

  async create(actor, appId, values) {
    return this.#transaction(async (connection) => {
      const application = await this.#lockActiveApplication(connection, appId);
      assertMerchantAccess(actor, application.merchantId);
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
      await connection.execute(
        'INSERT INTO products (id, merchant_id, app_id, status, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
        [product.id, product.merchantId, product.appId, product.status, sqlDate(product.createdAt), JSON.stringify(product)],
      );
      await this.#audit(connection, actor, product.merchantId, 'product.create', 'product', product.id, {
        appId: product.appId,
        durationDays: product.durationDays,
        maxDevices: product.maxDevices,
      }, now);
      return product;
    });
  }

  async list(actor, appId) {
    const application = await this.#findApplication(appId);
    assertMerchantAccess(actor, application.merchantId);
    const [rows] = await this.pool.execute(
      'SELECT payload, merchant_id, app_id, status FROM products WHERE app_id = ?',
      [appId],
    );
    return rows.map(parseProductRow).sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt));
  }

  async update(actor, productId, mutate) {
    return this.#transaction(async (connection) => {
      const product = await this.#lockProduct(connection, productId);
      assertMerchantAccess(actor, product.merchantId);
      mutate(product);
      product.updatedAt = new Date().toISOString();
      await connection.execute('UPDATE products SET payload = ? WHERE id = ?', [JSON.stringify(product), product.id]);
      await this.#audit(connection, actor, product.merchantId, 'product.update', 'product', product.id, {}, product.updatedAt);
      return product;
    });
  }

  async setStatus(actor, productId, status) {
    return this.#transaction(async (connection) => {
      const product = await this.#lockProduct(connection, productId);
      assertMerchantAccess(actor, product.merchantId);
      const now = new Date().toISOString();
      product.status = status;
      product.updatedAt = now;
      await connection.execute('UPDATE products SET status = ?, payload = ? WHERE id = ?', [product.status, JSON.stringify(product), product.id]);
      await this.#audit(connection, actor, product.merchantId, 'product.status.update', 'product', product.id, { status }, now);
      return product;
    });
  }

  async getPublicStore(merchantCode) {
    const [merchantRows] = await this.pool.execute('SELECT payload, status FROM merchants WHERE code = ?', [merchantCode]);
    if (!merchantRows[0] || merchantRows[0].status !== 'active') {
      throw new AppError('STOREFRONT_NOT_FOUND', 'Storefront was not found', 404);
    }
    const merchant = parsePayload(merchantRows[0].payload);
    const [rows] = await this.pool.execute(
      `SELECT p.payload AS product_payload, a.payload AS application_payload
       FROM products AS p
       INNER JOIN applications AS a ON a.id = p.app_id
       WHERE p.merchant_id = ? AND p.status = 'active' AND a.status = 'active'`,
      [merchant.id],
    );
    const products = rows.map((row) => ({
      product: parsePayload(row.product_payload),
      application: parsePayload(row.application_payload),
    })).sort((left, right) => left.product.sortOrder - right.product.sortOrder
      || left.product.createdAt.localeCompare(right.product.createdAt))
      .map(({ product, application }) => ({
        id: product.id,
        appId: product.appId,
        name: product.name,
        description: product.description,
        priceCents: product.priceCents,
        currency: product.currency,
        durationDays: product.durationDays,
        maxDevices: product.maxDevices,
        sortOrder: product.sortOrder,
        application: { id: application.id, code: application.code, name: application.name },
      }));
    return { merchant: { code: merchant.code, name: merchant.name }, products, fulfillment: 'manual' };
  }

  async #findApplication(appId) {
    const [rows] = await this.pool.execute('SELECT payload, merchant_id, status FROM applications WHERE id = ?', [appId]);
    if (!rows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    const application = parsePayload(rows[0].payload);
    application.merchantId = rows[0].merchant_id;
    application.status = rows[0].status;
    return application;
  }

  async #lockActiveApplication(connection, appId) {
    const [identityRows] = await connection.execute('SELECT merchant_id FROM applications WHERE id = ?', [appId]);
    if (!identityRows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    await this.#requireActiveMerchant(connection, identityRows[0].merchant_id);
    const [rows] = await connection.execute('SELECT payload, merchant_id, status FROM applications WHERE id = ? FOR UPDATE', [appId]);
    if (!rows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    if (rows[0].status !== 'active') throw new AppError('APPLICATION_DISABLED', 'Application is disabled', 403);
    const application = parsePayload(rows[0].payload);
    application.merchantId = rows[0].merchant_id;
    application.status = rows[0].status;
    return application;
  }

  async #lockProduct(connection, productId) {
    const [rows] = await connection.execute('SELECT payload, merchant_id, app_id, status FROM products WHERE id = ? FOR UPDATE', [productId]);
    if (!rows[0]) throw new AppError('PRODUCT_NOT_FOUND', 'Product was not found', 404);
    return parseProductRow(rows[0]);
  }

  async #requireActiveMerchant(connection, merchantId) {
    const [rows] = await connection.execute('SELECT status FROM merchants WHERE id = ? FOR UPDATE', [merchantId]);
    if (!rows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
    if (rows[0].status !== 'active') throw new AppError('MERCHANT_DISABLED', 'Merchant is disabled', 403);
  }

  async #transaction(operation) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async #audit(connection, actor, merchantId, action, resourceType, resourceId, metadata, createdAt) {
    const entry = { id: randomUUID(), merchantId, actorUserId: actor.id, actorUsername: actor.username ?? 'system', action, resourceType, resourceId, metadata, createdAt };
    await connection.execute(
      'INSERT INTO audit_logs (id, merchant_id, actor_id, action, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
      [entry.id, entry.merchantId, entry.actorUserId, entry.action, sqlDate(entry.createdAt), JSON.stringify(entry)],
    );
  }
}
