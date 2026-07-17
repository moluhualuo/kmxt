import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { RedisSecurityState } from '../src/security/security-state.js';
import { runMigrations } from '../src/storage/migrate.js';
import { MysqlStore } from '../src/storage/mysql-store.js';

const runMysql = process.env.KMXT_RUN_MYSQL_INTEGRATION === '1';
const runRedis = process.env.KMXT_RUN_REDIS_INTEGRATION === '1';

test('MySQL migrations are repeatable and transaction rollback preserves state', { skip: !runMysql }, async () => {
  const config = loadConfig({ storageDriver: 'mysql' });
  if (!config.mysql.database.endsWith('_test')) throw new Error('MySQL integration requires a database ending in _test');
  await runMigrations(config);
  assert.deepEqual(await runMigrations(config), []);
  const store = await new MysqlStore(config).initialize();
  const id = randomUUID();
  await assert.rejects(() => store.transaction((state) => {
    state.merchants.push({ id, code: `TEST_${id.slice(0, 8)}`, name: 'rollback', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    throw new Error('rollback-vector');
  }), /rollback-vector/);
  assert.equal(await store.read((state) => state.merchants.some((item) => item.id === id)), false);
  await store.close();
});

test('Redis adapter keeps nonce and limit state outside the process', { skip: !runRedis }, async () => {
  const config = loadConfig();
  if (!/(^|[_:-])test(?:[_:-]|$)/i.test(config.redis.keyPrefix)) {
    throw new Error('Redis integration requires a Redis key prefix containing a test segment');
  }
  const state = await new RedisSecurityState(config).initialize();
  const key = `integration:${randomUUID()}`;
  assert.equal(await state.consumeNonce(key, 60_000), true);
  assert.equal(await state.consumeNonce(key, 60_000), false);
  assert.deepEqual(await state.incrementRate(key, 60), { count: 1, retryAfter: 60 });
  assert.equal((await state.incrementRate(key, 60)).count, 2);
  await state.close();
});
