// Author: 花落. Distributed under the MIT License.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState } from '../src/storage/schema.js';
import { MysqlStore } from '../src/storage/mysql-store.js';

const TABLE_COLLECTIONS = new Map([
  ['merchants', 'merchants'],
  ['users', 'users'],
  ['admin_sessions', 'adminSessions'],
  ['applications', 'applications'],
  ['products', 'products'],
  ['license_batches', 'licenseBatches'],
  ['licenses', 'licenses'],
  ['orders', 'orders'],
  ['device_bindings', 'deviceBindings'],
  ['client_sessions', 'clientSessions'],
  ['audit_logs', 'auditLogs'],
  ['verification_logs', 'verificationLogs'],
]);

function createFakeConnection(state) {
  const calls = {
    queries: [], executions: [], began: 0, committed: 0, rolledBack: 0, released: 0, destroyed: 0,
  };
  return {
    calls,
    async beginTransaction() { calls.began += 1; },
    async commit() { calls.committed += 1; },
    async rollback() { calls.rolledBack += 1; },
    release() { calls.released += 1; },
    destroy() { calls.destroyed += 1; },
    async query(query) {
      const sql = typeof query === 'string' ? query : query.sql;
      calls.queries.push(sql);
      if (sql.startsWith('SELECT schema_version')) {
        return [[{
          schema_version: state.schemaVersion,
          created_at: state.meta.createdAt,
          updated_at: state.meta.updatedAt,
        }]];
      }
      if (sql.includes('UNION ALL')) {
        const rows = [];
        for (const [table, collection] of TABLE_COLLECTIONS) {
          rows.push(...state[collection].map((item) => ({
            state_collection: collection,
            id: item.id,
            payload: JSON.stringify(item),
          })));
        }
        return [rows];
      }
      const table = sql.match(/FROM ([a-z_]+)/)?.[1];
      const collection = TABLE_COLLECTIONS.get(table);
      assert.ok(collection, `Unexpected query: ${sql}`);
      return [state[collection].map((item) => ({ id: item.id, payload: JSON.stringify(item) }))];
    },
    async execute(query, parameters) {
      const sql = typeof query === 'string' ? query : query.sql;
      calls.executions.push({ sql, parameters });
      return [{ affectedRows: 1 }];
    },
  };
}

test('MySQL transaction uses the metadata row lock and persists only changed records', async () => {
  const now = '2026-07-15T00:00:00.000Z';
  const state = createInitialState(now);
  state.users = [
    {
      id: 'user-1', merchantId: null, usernameNormalized: 'first', role: 'platform_admin',
      status: 'active', createdAt: now, updatedAt: now,
    },
    {
      id: 'user-2', merchantId: null, usernameNormalized: 'second', role: 'operator',
      status: 'active', createdAt: now, updatedAt: now,
    },
  ];

  const connection = createFakeConnection(state);
  const store = new MysqlStore({});
  store.pool = { getConnection: async () => connection };

  const result = await store.transaction((draft) => {
    draft.users[0].status = 'disabled';
    draft.adminSessions.push({
      id: 'session-1', userId: 'user-1', tokenDigest: 'digest',
      createdAt: now, expiresAt: '2026-07-16T00:00:00.000Z',
    });
    return 'updated';
  });

  assert.equal(result, 'updated');
  assert.equal(connection.calls.began, 1);
  assert.equal(connection.calls.committed, 1);
  assert.equal(connection.calls.rolledBack, 0);
  assert.equal(connection.calls.released, 1);
  assert.match(connection.calls.queries[0], /kmxt_meta.+FOR UPDATE/);
  assert.equal(connection.calls.queries.filter((sql) => sql.includes('UNION ALL')).length, 0);
  assert.equal(connection.calls.queries.filter((sql) => /^SELECT id, payload FROM /.test(sql)).length, TABLE_COLLECTIONS.size);
  assert.equal(connection.calls.queries.some((sql) => /GET_LOCK|RELEASE_LOCK/.test(sql)), false);

  const upsertTables = connection.calls.executions
    .map(({ sql }) => sql.match(/^INSERT INTO ([a-z_]+)/)?.[1])
    .filter(Boolean);
  assert.deepEqual(upsertTables, ['users', 'admin_sessions']);
});

test('MySQL transactions queue in-process before acquiring another database connection', async () => {
  const now = '2026-07-15T00:00:00.000Z';
  const state = createInitialState(now);
  const firstConnection = createFakeConnection(state);
  const secondConnection = createFakeConnection(state);
  const connections = [firstConnection, secondConnection];
  const store = new MysqlStore({});
  store.pool = { getConnection: async () => connections.shift() };

  let continueFirst;
  const firstCanFinish = new Promise((resolve) => { continueFirst = resolve; });
  let enteredFirst;
  const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
  const first = store.transaction(async () => {
    enteredFirst();
    await firstCanFinish;
  });
  await firstEntered;

  const second = store.transaction(() => undefined);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(secondConnection.calls.began, 0);

  continueFirst();
  await first;
  await second;
  assert.equal(secondConnection.calls.began, 1);
});

test('MySQL connection loss is discarded and becomes a retryable 503', async () => {
  const state = createInitialState('2026-07-15T00:00:00.000Z');
  const connection = createFakeConnection(state);
  const lost = Object.assign(new Error('connection lost'), {
    code: 'PROTOCOL_CONNECTION_LOST',
    fatal: true,
  });
  connection.query = async () => { throw lost; };

  const store = new MysqlStore({ mysql: { operationTimeoutMs: 50 } });
  store.pool = { getConnection: async () => connection };

  await assert.rejects(
    store.read(() => undefined),
    (error) => error.code === 'STORAGE_UNAVAILABLE' && error.status === 503,
  );
  assert.equal(connection.calls.destroyed, 1);
  assert.equal(connection.calls.released, 0);
});

test('MySQL operation timeout discards the stuck connection before a proxy timeout', async () => {
  const state = createInitialState('2026-07-15T00:00:00.000Z');
  const connection = createFakeConnection(state);
  connection.query = async () => new Promise(() => {});

  const store = new MysqlStore({ mysql: { operationTimeoutMs: 20 } });
  store.pool = { getConnection: async () => connection };

  await assert.rejects(
    store.read(() => undefined),
    (error) => error.code === 'STORAGE_UNAVAILABLE' && error.status === 503,
  );
  assert.equal(connection.calls.destroyed, 1);
  assert.equal(connection.calls.released, 0);
});
