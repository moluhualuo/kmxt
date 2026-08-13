import { assertStateShape, createInitialState } from './schema.js';
import { mysqlConnectionOptions, runMigrations } from './migrate.js';
import { StateStore } from './store.js';
import { MysqlDashboardRepository } from './repositories/mysql-dashboard-repository.js';
import { MysqlOrderRepository } from './repositories/mysql-order-repository.js';
import { MysqlVerificationRepository } from './repositories/mysql-verification-repository.js';
import { MysqlLicenseRepository } from './repositories/mysql-license-repository.js';
import { MysqlAuthRepository } from './repositories/mysql-auth-repository.js';
import { MysqlMerchantRepository } from './repositories/mysql-merchant-repository.js';
import { MysqlApplicationRepository } from './repositories/mysql-application-repository.js';
import { MysqlProductRepository } from './repositories/mysql-product-repository.js';
import { MysqlAuditRepository } from './repositories/mysql-audit-repository.js';
import { MysqlMaintenanceRepository } from './repositories/mysql-maintenance-repository.js';
import { MysqlOnlineDeviceRepository } from './repositories/mysql-online-device-repository.js';
import { MysqlModelDeliveryRepository } from './repositories/mysql-model-delivery-repository.js';
import { StorageUnavailableError, toStorageUnavailableError } from './storage-error.js';

const TABLES = [
  ['merchants', 'merchants'],
  ['users', 'users'],
  ['adminSessions', 'admin_sessions'],
  ['applications', 'applications'],
  ['products', 'products'],
  ['licenseBatches', 'license_batches'],
  ['licenses', 'licenses'],
  ['orders', 'orders'],
  ['deviceBindings', 'device_bindings'],
  ['clientSessions', 'client_sessions'],
  ['auditLogs', 'audit_logs'],
  ['verificationLogs', 'verification_logs'],
  ['modelArtifacts', 'model_artifacts'],
  ['modelLeases', 'model_leases'],
  ['announcements', 'announcements'],
];

const COLUMN_VALUES = {
  merchants: (item) => ({ code: item.code, status: item.status, created_at: item.createdAt }),
  users: (item) => ({ merchant_id: item.merchantId, username_normalized: item.usernameNormalized, role: item.role, status: item.status, created_at: item.createdAt }),
  admin_sessions: (item) => ({ user_id: item.userId, token_digest: item.tokenDigest, expires_at: item.expiresAt }),
  applications: (item) => ({ merchant_id: item.merchantId, code: item.code, status: item.status, created_at: item.createdAt }),
  products: (item) => ({ merchant_id: item.merchantId, app_id: item.appId, status: item.status, created_at: item.createdAt }),
  license_batches: (item) => ({ merchant_id: item.merchantId, app_id: item.appId, source_id: item.sourceId ?? null, created_at: item.createdAt }),
  licenses: (item) => ({ merchant_id: item.merchantId, app_id: item.appId, batch_id: item.batchId, key_digest: item.keyDigest, status: item.status, expires_at: item.expiresAt, created_at: item.createdAt }),
  orders: (item) => ({ merchant_id: item.merchantId, app_id: item.appId, product_id: item.productId, license_id: item.licenseId, order_no: item.orderNo, query_digest: item.queryDigest, status: item.status, created_at: item.createdAt }),
  device_bindings: (item) => ({ merchant_id: item.merchantId, app_id: item.appId, license_id: item.licenseId, device_digest: item.deviceDigest, status: item.status, created_at: item.boundAt }),
  client_sessions: (item) => ({ merchant_id: item.merchantId, app_id: item.appId, license_id: item.licenseId, binding_id: item.bindingId, token_digest: item.tokenDigest, expires_at: item.expiresAt }),
  audit_logs: (item) => ({ merchant_id: item.merchantId, actor_id: item.actorUserId, action: item.action, created_at: item.createdAt }),
  verification_logs: (item) => ({ merchant_id: item.merchantId, app_id: item.appId, license_id: item.licenseId, binding_id: item.bindingId, event: item.event, result_code: item.resultCode, created_at: item.createdAt }),
  model_artifacts: (item) => ({
    merchant_id: item.merchantId,
    app_id: item.appId,
    name: item.name,
    version: item.version,
    format: item.format,
    status: item.status,
    cipher_sha256: item.cipherSha256,
    size: item.size,
    created_at: item.createdAt,
  }),
  model_leases: (item) => ({
    merchant_id: item.merchantId,
    app_id: item.appId,
    artifact_id: item.artifactId,
    license_id: item.licenseId,
    binding_id: item.bindingId,
    jti: item.jti,
    client_key_fingerprint: item.clientKeyFingerprint,
    status: item.status,
    expires_at: item.expiresAt,
    created_at: item.createdAt,
  }),
  announcements: (item) => ({
    merchant_id: item.merchantId,
    app_id: item.appId,
    status: item.status,
    severity: item.severity,
    sequence: item.sequence,
    starts_at: item.startsAt,
    ends_at: item.endsAt,
    created_at: item.createdAt,
  }),
};

function clone(value) { return structuredClone(value); }
function jsonPayload(item) { return JSON.stringify(item); }
function parsePayload(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function samePayload(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  const normalized = String(value).replace(' ', 'T');
  return normalized.endsWith('Z') ? normalized : `${normalized}Z`;
}

async function rollbackQuietly(connection, originalError) {
  try {
    await connection.rollback();
  } catch (rollbackError) {
    if (originalError && typeof originalError === 'object' && originalError.cause === undefined) {
      originalError.cause = rollbackError;
    }
  }
}

// Author: 花落. MySQL persistence is distributed under the MIT License.
// Legacy StateStore transactions use SERIALIZABLE row/range locks until every service has
// moved to its domain repository. There is intentionally no connection-scoped advisory lock.
export class MysqlStore extends StateStore {
  constructor(config) {
    super();
    this.config = config;
    this.pool = null;
    this.database = null;
    this.repositories = null;
    this.closed = false;
    this.closePromise = null;
  }

  async initialize() {
    if (this.config.mysql.autoMigrate) await runMigrations(this.config);
    const mysql = await import('mysql2/promise');
    this.pool = mysql.createPool({
      ...await mysqlConnectionOptions(this.config),
      connectionLimit: this.config.mysql.poolLimit,
      waitForConnections: true,
      queueLimit: this.config.mysql.poolQueueLimit,
      connectTimeout: this.config.mysql.operationTimeoutMs,
      enableKeepAlive: true,
    });
    this.database = this.#createRepositoryClient();
    this.closed = false;
    this.closePromise = null;
    await this.database.query('SELECT 1');
    const modelDelivery = new MysqlModelDeliveryRepository(this.database);
    this.repositories = {
      dashboard: new MysqlDashboardRepository(this.database),
      orders: new MysqlOrderRepository(this.database),
      verification: new MysqlVerificationRepository(this.database),
      licenses: new MysqlLicenseRepository(this.database),
      auth: new MysqlAuthRepository(this.database),
      merchants: new MysqlMerchantRepository(this.database),
      applications: new MysqlApplicationRepository(this.database),
      products: new MysqlProductRepository(this.database),
      audit: new MysqlAuditRepository(this.database),
      maintenance: new MysqlMaintenanceRepository(this.database, modelDelivery),
      onlineDevices: new MysqlOnlineDeviceRepository(this.database),
      modelDelivery,
    };
    const [metaRows] = await this.database.query('SELECT schema_version FROM kmxt_meta WHERE singleton_id = 1');
    if (!metaRows.length) throw new Error('MySQL schema is not initialized; run `node cli/kmxt.js migrate`');
    return this;
  }

  async read(selector = (state) => state) {
    this.#assertOpen();
    const connection = await this.getConnection();
    try {
      await connection.beginTransaction();
      const state = await this.#load(connection, false);
      const result = await selector(clone(state));
      await connection.commit();
      return clone(result);
    } catch (error) {
      await rollbackQuietly(connection, error);
      throw error;
    } finally {
      connection.release();
    }
  }

  async transaction(mutator) {
    this.#assertOpen();
    const connection = await this.getConnection();
    try {
      await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      await connection.beginTransaction();
      const original = await this.#load(connection, true);
      const draft = clone(original);
      const result = await mutator(draft);
      draft.meta.updatedAt = new Date().toISOString();
      assertStateShape(draft);
      await this.#persist(connection, original, draft);
      await connection.commit();
      return clone(result);
    } catch (error) {
      await rollbackQuietly(connection, error);
      throw error;
    } finally {
      connection.release();
    }
  }

  async #load(connection, forUpdate) {
    const suffix = forUpdate ? ' FOR UPDATE' : '';
    const [metaRows] = await connection.query(`SELECT schema_version, created_at, updated_at FROM kmxt_meta WHERE singleton_id = 1${suffix}`);
    if (!metaRows.length) throw new Error('MySQL schema is not initialized; run `node cli/kmxt.js migrate`');
    const meta = metaRows[0];
    const state = createInitialState(toIso(meta.created_at));
    state.schemaVersion = Number(meta.schema_version);
    state.meta.updatedAt = toIso(meta.updated_at);
    for (const [collection, table] of TABLES) {
      const [rows] = await connection.query(`SELECT id, payload FROM ${table}${suffix}`);
      state[collection] = rows.map((row) => parsePayload(row.payload));
    }
    assertStateShape(state);
    return state;
  }

  async #persist(connection, original, draft) {
    for (const [collection, table] of [...TABLES].reverse()) {
      const currentIds = new Set(draft[collection].map((item) => item.id));
      const removed = original[collection].filter((item) => !currentIds.has(item.id)).map((item) => item.id);
      if (removed.length) {
        const placeholders = removed.map(() => '?').join(',');
        await connection.execute(`DELETE FROM ${table} WHERE id IN (${placeholders})`, removed);
      }
    }
    for (const [collection, table] of TABLES) {
      const originalById = new Map(original[collection].map((item) => [item.id, item]));
      for (const item of draft[collection]) {
        if (!samePayload(item, originalById.get(item.id))) await this.#upsert(connection, table, item);
      }
    }
    await connection.execute(
      'UPDATE kmxt_meta SET schema_version = ?, updated_at = ? WHERE singleton_id = 1',
      [draft.schemaVersion, new Date(draft.meta.updatedAt)],
    );
  }

  async #upsert(connection, table, item) {
    const values = { id: item.id, ...COLUMN_VALUES[table](item), payload: jsonPayload(item) };
    const columns = Object.keys(values);
    const updateColumns = columns.filter((name) => name !== 'id');
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON DUPLICATE KEY UPDATE ${updateColumns.map((name) => `${name} = VALUES(${name})`).join(', ')}`;
    const parameters = Object.values(values).map((value) => {
      if (value === undefined) return null;
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value);
      return value;
    });
    await connection.execute(sql, parameters);
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    if (!this.pool) {
      this.closed = true;
      this.database = null;
      return;
    }
    this.closed = true;
    this.database = null;
    this.closePromise = Promise.resolve().then(() => this.pool.end());
    return this.closePromise;
  }


  async ping() {
    this.#assertOpen();
    try {
      await (this.database || this.#createRepositoryClient()).query('SELECT 1');
      return true;
    } catch (error) {
      throw toStorageUnavailableError(error);
    }
  }

  async statusSummary() {
    if (!this.pool || this.closed) {
      throw new StorageUnavailableError('MySQL connection pool is closed');
    }
    let results;
    const execute = this.database?.execute
      ? this.database.execute.bind(this.database)
      : this.pool.execute.bind(this.pool);
    try {
      results = await Promise.all([
        execute('SELECT schema_version, updated_at FROM kmxt_meta WHERE singleton_id = 1'),
        execute('SELECT COUNT(*) AS total FROM merchants'),
        execute('SELECT COUNT(*) AS total FROM applications'),
        execute('SELECT COUNT(*) AS total FROM products'),
        execute('SELECT COUNT(*) AS total FROM orders'),
        execute('SELECT COUNT(*) AS total FROM licenses'),
        execute('SELECT COUNT(*) AS total FROM users'),
      ]);
    } catch (error) {
      throw toStorageUnavailableError(error);
    }
    const [[meta], ...counts] = results;
    if (!meta[0]) throw new Error('MySQL schema is not initialized; run `node cli/kmxt.js migrate`');
    return {
      schemaVersion: Number(meta[0].schema_version),
      merchants: Number(counts[0][0][0]?.total ?? 0),
      applications: Number(counts[1][0][0]?.total ?? 0),
      products: Number(counts[2][0][0]?.total ?? 0),
      orders: Number(counts[3][0][0]?.total ?? 0),
      licenses: Number(counts[4][0][0]?.total ?? 0),
      users: Number(counts[5][0][0]?.total ?? 0),
      updatedAt: toIso(meta[0].updated_at),
    };
  }

  async dashboard(actor, filters) {
    this.#assertOpen();
    return this.repositories.dashboard.get(actor, filters);
  }

  async getConnection() {
    this.#assertOpen();
    let timedOut = false;
    let timer;
    const pending = Promise.resolve()
      .then(() => this.pool.getConnection())
      .then((connection) => {
        if (timedOut) {
          connection.release();
          throw new StorageUnavailableError('Timed out waiting for a MySQL connection');
        }
        return connection;
      });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const error = new Error('Timed out waiting for a MySQL connection');
        error.code = 'POOL_ACQUIRE_TIMEOUT';
        reject(error);
      }, this.config.mysql.operationTimeoutMs);
    });
    try {
      const connection = await Promise.race([pending, timeout]);
      clearTimeout(timer);
      this.#installConnectionOperationTimeouts(connection);
      return connection;
    } catch (error) {
      clearTimeout(timer);
      timedOut = true;
      pending.catch(() => undefined);
      throw toStorageUnavailableError(error);
    }
  }

  #assertOpen() {
    if (!this.pool || this.closed) {
      throw new StorageUnavailableError('MySQL connection pool is closed');
    }
  }

  #installConnectionOperationTimeouts(connection) {
    if (connection.__kmxtOperationTimeoutInstalled) return;
    const timeout = this.config.mysql.operationTimeoutMs;
    for (const methodName of ['query', 'execute']) {
      const original = connection[methodName].bind(connection);
      connection[methodName] = async (sql, values) => {
        try {
          if (typeof sql === 'string') {
            return await original({ sql, timeout }, values);
          }
          return await original({ ...sql, timeout: sql.timeout ?? timeout }, values);
        } catch (error) {
          if (error?.code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
            connection.destroy?.();
          }
          throw toStorageUnavailableError(error);
        }
      };
    }
    const transactionStatements = {
      beginTransaction: 'START TRANSACTION',
      commit: 'COMMIT',
      rollback: 'ROLLBACK',
    };
    for (const [methodName, sql] of Object.entries(transactionStatements)) {
      connection[methodName] = () => connection.query({ sql, timeout });
    }
    Object.defineProperty(connection, '__kmxtOperationTimeoutInstalled', { value: true });
  }

  #createRepositoryClient() {
    return {
      query: (...args) => this.#runConnectionOperation('query', args),
      execute: (...args) => this.#runConnectionOperation('execute', args),
      getConnection: () => this.getConnection(),
    };
  }

  async #runConnectionOperation(methodName, args) {
    const connection = await this.getConnection();
    try {
      const [sql, values] = args;
      return values === undefined
        ? await connection[methodName](sql)
        : await connection[methodName](sql, values);
    } catch (error) {
      if (error?.code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
        connection.destroy?.();
      }
      throw toStorageUnavailableError(error);
    } finally {
      connection.release();
    }
  }
}
