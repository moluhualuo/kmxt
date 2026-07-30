import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertStateShape,
  createInitialState,
  SCHEMA_VERSION,
  upgradeState,
} from '../src/storage/schema.js';

test('schema version 1 upgrades to the current schema without losing collections', () => {
  const current = createInitialState();
  const legacy = structuredClone(current);
  legacy.schemaVersion = 1;
  delete legacy.products;
  delete legacy.orders;
  legacy.users.push({ id: 'preserved-user' });

  const upgraded = upgradeState(legacy);
  assert.equal(upgraded.changed, true);
  assert.equal(upgraded.state.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(upgraded.state.modelArtifacts, []);
  assert.deepEqual(upgraded.state.modelLeases, []);
  assert.deepEqual(upgraded.state.announcements, []);
  assert.deepEqual(upgraded.state.products, []);
  assert.deepEqual(upgraded.state.orders, []);
  assert.equal(upgraded.state.users[0].id, 'preserved-user');
  assert.doesNotThrow(() => assertStateShape(upgraded.state));
});

// 花落 / MIT：现有部署实际走的升级路径是 v5 -> v6，只新增 announcements 集合，
// 已有卡密、绑定和制品记录必须原样保留。
test('schema version 5 upgrades to version 6 by adding announcements only', () => {
  const legacy = createInitialState();
  legacy.schemaVersion = 5;
  delete legacy.announcements;
  legacy.licenses.push({ id: 'preserved-license' });
  legacy.modelArtifacts.push({ id: 'preserved-artifact' });

  const upgraded = upgradeState(legacy);
  assert.equal(upgraded.changed, true);
  assert.equal(upgraded.state.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(upgraded.state.announcements, []);
  assert.equal(upgraded.state.licenses[0].id, 'preserved-license');
  assert.equal(upgraded.state.modelArtifacts[0].id, 'preserved-artifact');
  assert.doesNotThrow(() => assertStateShape(upgraded.state));
});

test('current schema state is rejected when the announcements collection is missing', () => {
  const state = createInitialState();
  delete state.announcements;
  assert.throws(() => assertStateShape(state), /announcements must be an array/);
});

test('MySQL legacy state adapter does not use a global advisory lock or rewrite unchanged rows', async () => {
  const source = await readFile(new URL('../src/storage/mysql-store.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /GET_LOCK|RELEASE_LOCK/);
  assert.match(source, /SET TRANSACTION ISOLATION LEVEL SERIALIZABLE/);
  assert.match(source, /samePayload\(item, originalById\.get\(item\.id\)\)/);
});
