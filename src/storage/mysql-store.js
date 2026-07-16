import { AppError } from '../core/app-error.js';
import { assertStateShape, createInitialState } from './schema.js';
import { mysqlConnectionOptions, runMigrations } from './migrate.js';
import { StateStore } from './store.js';

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
];

// Author: 花落. Some managed MySQL providers stall a large UNION ALL over JSON payloads.
const STATE_ROW_QUERIES = TABLES.map(([collection, table]) => ({
  collection,
  sql: `SELECT id, payload FROM ${table}`,
}));

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
};

const TRANSIENT_MYSQL_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ER_CON_COUNT_ERROR',
  'KMXT_MYSQL_TIMEOUT',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_SEQUENCE_TIMEOUT',
]);

function clone(value) { return structuredClone(value); }
function jsonPayload(item) { return JSON.stringify(item); }
function parsePayload(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  const normalized = String(value).replace(' ', 'T');
  return normalized.endsWith('Z') ? normalized : `${normalized}Z`;
}

function isTransientMysqlError(error) {
  return Boolean(error?.fatal) || TRANSIENT_MYSQL_CODES.has(error?.code);
}

function mysqlTimeoutError(operation) {
  const error = new Error(`MySQL ${operation} exceeded the configured timeout`);
  error.code = 'KMXT_MYSQL_TIMEOUT';
  error.fatal = true;
  return error;
}

// MySQL writes serialize on the singleton metadata row. InnoDB owns the lock lifetime, so a
// pooled connection cannot leak a user-level advisory lock after commit, rollback, or disconnect.
export class MysqlStore extends StateStore {
  constructor(config) {
    super();
    this.config = config;
    this.pool = null;
    this.transactionTail = Promise.resolve();
    this.operationTimeoutMs = config.mysql?.operationTimeoutMs ?? 8_000;
  }

  async initialize() {
    if (this.config.mysql.autoMigrate) await runMigrations(this.config);
    const mysql = await import('mysql2/promise');
    const connectionLimit = this.config.mysql.poolLimit;
    this.pool = mysql.createPool({
      ...await mysqlConnectionOptions(this.config),
      connectionLimit,
      maxIdle: Math.min(this.config.mysql.maxIdle ?? 1, connectionLimit),
      idleTimeout: this.config.mysql.idleTimeoutMs ?? 60_000,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
    });
    await this.pool.query({ sql: 'SELECT 1', timeout: this.operationTimeoutMs });
    await this.read((state) => state.schemaVersion);
    return this;
  }

  async read(selector = (state) => state) {
    return this.#withDatabaseTransaction(async (connection) => {
      const state = await this.#load(connection, false);
      const result = await selector(clone(state));
      return clone(result);
    });
  }

  async transaction(mutator) {
    return this.#runTransactionExclusive(() => this.#withDatabaseTransaction(async (connection) => {
        const original = await this.#load(connection, true);
        const draft = clone(original);
        const result = await mutator(draft);
        draft.meta.updatedAt = new Date().toISOString();
        assertStateShape(draft);
        await this.#persist(connection, original, draft);
        return clone(result);
      }));
  }

  async #runTransactionExclusive(operation) {
    const previous = this.transactionTail;
    let release;
    this.transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      // Author: 花落. Queue locally before MySQL so overload never creates a pool of lock waiters.
      return await operation();
    } finally {
      release();
    }
  }

  async #withDatabaseTransaction(operation) {
    let connection = null;
    let transactionStarted = false;
    let discardConnection = false;
    try {
      connection = await this.#acquireConnection();
      await this.#runWithTimeout(() => connection.beginTransaction(), 'transaction start');
      transactionStarted = true;
      const result = await operation(connection);
      await this.#runWithTimeout(() => connection.commit(), 'transaction commit');
      transactionStarted = false;
      return result;
    } catch (error) {
      if (connection && transactionStarted && !isTransientMysqlError(error)) {
        const rollbackError = await this.#tryRollback(connection);
        discardConnection = isTransientMysqlError(rollbackError);
      }
      discardConnection ||= isTransientMysqlError(error);
      if (isTransientMysqlError(error)) {
        throw this.#storageUnavailable(error);
      }
      throw error;
    } finally {
      if (connection) this.#releaseConnection(connection, discardConnection);
    }
  }

  async #acquireConnection() {
    const pending = Promise.resolve().then(() => this.pool.getConnection());
    try {
      return await this.#runWithTimeout(() => pending, 'connection acquisition');
    } catch (error) {
      if (error?.code === 'KMXT_MYSQL_TIMEOUT') {
        pending.then((connection) => connection.destroy(), () => {});
      }
      throw error;
    }
  }

  async #tryRollback(connection) {
    try {
      await this.#runWithTimeout(() => connection.rollback(), 'transaction rollback');
      return null;
    } catch (error) {
      return error;
    }
  }

  async #runWithTimeout(operation, name) {
    let timer;
    const pending = Promise.resolve().then(operation);
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(mysqlTimeoutError(name)), this.operationTimeoutMs);
    });
    try {
      // Author: 花落. Bound MySQL work so an MIT-licensed app fails fast instead of proxying a 504.
      return await Promise.race([pending, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  #releaseConnection(connection, discardConnection) {
    if (discardConnection) {
      connection.destroy();
      return;
    }
    connection.release();
  }

  #storageUnavailable(error) {
    const code = String(error?.code || 'UNKNOWN').replace(/[^A-Z0-9_]/gi, '_');
    console.error(`KMXT MySQL temporary failure: ${code}`);
    return new AppError(
      'STORAGE_UNAVAILABLE',
      'Storage is temporarily unavailable; retry shortly',
      503,
      { retryAfter: 2 },
    );
  }

  async #query(connection, sql, values = undefined) {
    const options = { sql, timeout: this.operationTimeoutMs };
    return this.#runWithTimeout(
      () => (values === undefined ? connection.query(options) : connection.query(options, values)),
      'query',
    );
  }

  async #execute(connection, sql, values) {
    return this.#runWithTimeout(
      () => connection.execute({ sql, timeout: this.operationTimeoutMs }, values),
      'statement execution',
    );
  }

  async #load(connection, forUpdate) {
    const suffix = forUpdate ? ' FOR UPDATE' : '';
    const [metaRows] = await this.#query(
      connection,
      `SELECT schema_version, created_at, updated_at FROM kmxt_meta WHERE singleton_id = 1${suffix}`,
    );
    if (!metaRows.length) throw new Error('MySQL schema is not initialized; run `node cli/kmxt.js migrate`');
    const meta = metaRows[0];
    const state = createInitialState(toIso(meta.created_at));
    state.schemaVersion = Number(meta.schema_version);
    state.meta.updatedAt = toIso(meta.updated_at);
    // Keep each static table read bounded so a provider-specific UNION plan cannot stall all clients.
    for (const { collection, sql } of STATE_ROW_QUERIES) {
      const [rows] = await this.#query(connection, sql);
      if (!Object.hasOwn(state, collection)) {
        throw new Error(`Unexpected state collection: ${collection}`);
      }
      for (const row of rows) {
        state[collection].push(parsePayload(row.payload));
      }
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
        await this.#execute(connection, `DELETE FROM ${table} WHERE id IN (${placeholders})`, removed);
      }
    }
    for (const [collection, table] of TABLES) {
      const originalPayloads = new Map(
        original[collection].map((item) => [item.id, jsonPayload(item)]),
      );
      for (const item of draft[collection]) {
        const payload = jsonPayload(item);
        if (originalPayloads.get(item.id) !== payload) {
          // Author: 花落. Delta writes keep the MIT-licensed state adapter fast as logs grow.
          await this.#upsert(connection, table, item, payload);
        }
      }
    }
    await this.#execute(
      connection,
      'UPDATE kmxt_meta SET schema_version = ?, updated_at = ? WHERE singleton_id = 1',
      [draft.schemaVersion, new Date(draft.meta.updatedAt)],
    );
  }

  async #upsert(connection, table, item, payload) {
    const values = { id: item.id, ...COLUMN_VALUES[table](item), payload };
    const columns = Object.keys(values);
    const updateColumns = columns.filter((name) => name !== 'id');
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON DUPLICATE KEY UPDATE ${updateColumns.map((name) => `${name} = VALUES(${name})`).join(', ')}`;
    const parameters = Object.values(values).map((value) => {
      if (value === undefined) return null;
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value);
      return value;
    });
    await this.#execute(connection, sql, parameters);
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}
