import { randomUUID } from 'node:crypto';
import { AppError } from '../../core/app-error.js';
import { Roles } from '../../services/access-control.js';

function parsePayload(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function sqlDate(value) { return value ? new Date(value) : null; }
function pageLimit(pagination) { return Math.max(1, Math.trunc(Number(pagination.limit) || 20)); }
function pageOffset(pagination) { return Math.max(0, Math.trunc(Number(pagination.offset) || 0)); }

function assertMerchantAccess(actor, merchantId) {
  if (actor.role !== Roles.PLATFORM_ADMIN && actor.merchantId !== merchantId) {
    throw new AppError('FORBIDDEN', 'Cross-merchant access is not allowed', 403);
  }
}

// Author: 花落. MySQL order queries and fulfillment are provided under the MIT License.
export class MysqlOrderRepository {
  constructor(pool) { this.pool = pool; }

  async createPublic(merchantCode, productId, createOrder) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.#createPublicOnce(merchantCode, productId, createOrder);
      } catch (error) {
        lastError = error;
        if (error?.code !== 'ER_DUP_ENTRY' || !/uq_orders_order_no/i.test(error.message || '')) throw error;
      }
    }
    throw new AppError('ORDER_COLLISION', 'Unable to allocate an order number; retry the request', 409, { cause: lastError?.code });
  }

  async queryPublic(orderNo, queryDigest) {
    const [rows] = await this.pool.execute(
      'SELECT payload FROM orders WHERE order_no = ? AND query_digest = ? LIMIT 1',
      [orderNo, queryDigest],
    );
    return rows[0] ? parsePayload(rows[0].payload) : null;
  }

  async list(merchantId, pagination, filters) {
    await this.#requireMerchant(merchantId);
    const { where, values } = this.#listWhere(merchantId, filters);
    const limit = pageLimit(pagination);
    const offset = pageOffset(pagination);
    const [[countRows], [rows]] = await Promise.all([
      this.pool.execute(`SELECT COUNT(*) AS total FROM orders${where}`, values),
      this.pool.execute(
        `SELECT payload FROM orders${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
        values,
      ),
    ]);
    return { items: rows.map((row) => parsePayload(row.payload)), page: pagination.page, limit: pagination.limit, total: Number(countRows[0]?.total ?? 0) };
  }

  async fulfill(actor, orderId, createArtifacts) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.#fulfillOnce(actor, orderId, createArtifacts);
      } catch (error) {
        lastError = error;
        const licenseCollision = error?.code === 'ER_DUP_ENTRY' && /uq_licenses_key_digest/i.test(error.message || '');
        const deadlock = ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error?.code);
        if (!licenseCollision && !deadlock) throw error;
      }
    }
    throw lastError;
  }

  async reject(actor, orderId, reason) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [orderRows] = await connection.execute('SELECT payload FROM orders WHERE id = ? FOR UPDATE', [orderId]);
      if (!orderRows[0]) throw new AppError('ORDER_NOT_FOUND', 'Order was not found', 404);
      const order = parsePayload(orderRows[0].payload);
      assertMerchantAccess(actor, order.merchantId);
      if (order.status === 'rejected') {
        await connection.commit();
        return order;
      }
      if (order.status !== 'pending') throw new AppError('ORDER_NOT_PENDING', 'Only pending orders can be rejected', 409);
      const now = new Date().toISOString();
      order.status = 'rejected';
      order.rejectReason = reason;
      order.rejectedAt = now;
      order.updatedAt = now;
      await connection.execute('UPDATE orders SET status = ?, payload = ? WHERE id = ?', [order.status, JSON.stringify(order), order.id]);
      await this.#audit(connection, actor, order.merchantId, 'store_order.reject', 'order', order.id, { orderNo: order.orderNo }, now);
      await connection.commit();
      return order;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async #createPublicOnce(merchantCode, productId, createOrder) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [merchantRows] = await connection.execute('SELECT payload, status FROM merchants WHERE code = ? FOR UPDATE', [merchantCode]);
      if (!merchantRows[0] || merchantRows[0].status !== 'active') {
        throw new AppError('STOREFRONT_NOT_FOUND', 'Storefront was not found', 404);
      }
      const merchant = parsePayload(merchantRows[0].payload);
      merchant.status = merchantRows[0].status;
      const [productRows] = await connection.execute('SELECT payload, merchant_id, app_id, status FROM products WHERE id = ? FOR UPDATE', [productId]);
      if (!productRows[0] || productRows[0].merchant_id !== merchant.id || productRows[0].status !== 'active') {
        throw new AppError('PRODUCT_UNAVAILABLE', 'Product is unavailable', 409);
      }
      const product = parsePayload(productRows[0].payload);
      product.merchantId = productRows[0].merchant_id;
      product.appId = productRows[0].app_id;
      product.status = productRows[0].status;
      const [appRows] = await connection.execute('SELECT payload, merchant_id, status FROM applications WHERE id = ? FOR UPDATE', [product.appId]);
      if (!appRows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
      if (appRows[0].status !== 'active') throw new AppError('APPLICATION_DISABLED', 'Application is disabled', 403);
      if (appRows[0].merchant_id !== merchant.id) throw new AppError('PRODUCT_UNAVAILABLE', 'Product is unavailable', 409);
      const application = parsePayload(appRows[0].payload);
      application.merchantId = appRows[0].merchant_id;
      application.status = appRows[0].status;
      const order = await createOrder({ merchant, product, application });
      await connection.execute(
        'INSERT INTO orders (id, merchant_id, app_id, product_id, license_id, order_no, query_digest, status, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [order.id, order.merchantId, order.appId, order.productId, order.licenseId, order.orderNo, order.queryDigest, order.status, sqlDate(order.createdAt), JSON.stringify(order)],
      );
      await this.#audit(connection, null, merchant.id, 'store_order.create', 'order', order.id, {
        orderNo: order.orderNo,
        appId: application.id,
        productId: product.id,
      }, order.createdAt);
      await connection.commit();
      return order;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async #fulfillOnce(actor, orderId, createArtifacts) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [orderRows] = await connection.execute('SELECT payload FROM orders WHERE id = ? FOR UPDATE', [orderId]);
      if (!orderRows[0]) throw new AppError('ORDER_NOT_FOUND', 'Order was not found', 404);
      const order = parsePayload(orderRows[0].payload);
      assertMerchantAccess(actor, order.merchantId);
      if (order.status === 'fulfilled') {
        await connection.commit();
        return order;
      }
      if (order.status !== 'pending') throw new AppError('ORDER_NOT_PENDING', 'Only pending orders can be fulfilled', 409);

      const [merchantRows] = await connection.execute('SELECT payload, status FROM merchants WHERE id = ? FOR UPDATE', [order.merchantId]);
      if (!merchantRows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
      if (merchantRows[0].status !== 'active') throw new AppError('MERCHANT_DISABLED', 'Merchant is disabled', 403);
      const merchant = parsePayload(merchantRows[0].payload);
      const [appRows] = await connection.execute('SELECT payload, status FROM applications WHERE id = ? FOR UPDATE', [order.appId]);
      if (!appRows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
      if (appRows[0].status !== 'active') throw new AppError('APPLICATION_DISABLED', 'Application is disabled', 403);
      const application = parsePayload(appRows[0].payload);
      const artifacts = await createArtifacts({ order, merchant, application });

      await connection.execute(
        'INSERT INTO license_batches (id, merchant_id, app_id, source_id, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
        [artifacts.batch.id, artifacts.batch.merchantId, artifacts.batch.appId, artifacts.batch.sourceId, sqlDate(artifacts.batch.createdAt), JSON.stringify(artifacts.batch)],
      );
      await connection.execute(
        'INSERT INTO licenses (id, merchant_id, app_id, batch_id, key_digest, status, expires_at, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [artifacts.license.id, artifacts.license.merchantId, artifacts.license.appId, artifacts.license.batchId, artifacts.license.keyDigest, artifacts.license.status, sqlDate(artifacts.license.expiresAt), sqlDate(artifacts.license.createdAt), JSON.stringify(artifacts.license)],
      );
      Object.assign(order, {
        status: 'fulfilled',
        licenseId: artifacts.license.id,
        licenseKeyEncrypted: artifacts.licenseKeyEncrypted,
        fulfilledAt: artifacts.now,
        updatedAt: artifacts.now,
      });
      await connection.execute(
        'UPDATE orders SET license_id = ?, status = ?, payload = ? WHERE id = ?',
        [order.licenseId, order.status, JSON.stringify(order), order.id],
      );
      const audit = {
        id: randomUUID(), merchantId: order.merchantId, actorUserId: actor.id, actorUsername: actor.username ?? 'system',
        action: 'store_order.fulfill', resourceType: 'order', resourceId: order.id,
        metadata: { orderNo: order.orderNo, licenseId: artifacts.license.id }, createdAt: artifacts.now,
      };
      await connection.execute(
        'INSERT INTO audit_logs (id, merchant_id, actor_id, action, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
        [audit.id, audit.merchantId, audit.actorUserId, audit.action, sqlDate(audit.createdAt), JSON.stringify(audit)],
      );
      await connection.commit();
      return order;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  #listWhere(merchantId, filters) {
    const conditions = ['merchant_id = ?'];
    const values = [merchantId];
    if (filters.status) { conditions.push('status = ?'); values.push(filters.status); }
    if (filters.orderNo) { conditions.push('order_no LIKE ?'); values.push(`%${filters.orderNo}%`); }
    if (filters.from) { conditions.push('created_at >= ?'); values.push(new Date(filters.from)); }
    if (filters.to) { conditions.push('created_at <= ?'); values.push(new Date(filters.to)); }
    return { where: ` WHERE ${conditions.join(' AND ')}`, values };
  }

  async #requireMerchant(merchantId) {
    const [rows] = await this.pool.execute('SELECT id FROM merchants WHERE id = ?', [merchantId]);
    if (!rows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
  }

  async #audit(connection, actor, merchantId, action, resourceType, resourceId, metadata, createdAt) {
    const audit = {
      id: randomUUID(), merchantId, actorUserId: actor?.id ?? null, actorUsername: actor?.username ?? 'system',
      action, resourceType, resourceId, metadata, createdAt,
    };
    await connection.execute(
      'INSERT INTO audit_logs (id, merchant_id, actor_id, action, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
      [audit.id, audit.merchantId, audit.actorUserId, audit.action, sqlDate(audit.createdAt), JSON.stringify(audit)],
    );
  }
}
