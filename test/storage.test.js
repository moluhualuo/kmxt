import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertStateShape, createInitialState, upgradeState } from '../src/storage/schema.js';

test('schema version 1 upgrades to the current schema without losing collections', () => {
  const current = createInitialState();
  const legacy = structuredClone(current);
  legacy.schemaVersion = 1;
  delete legacy.products;
  delete legacy.orders;
  legacy.users.push({ id: 'preserved-user' });

  const upgraded = upgradeState(legacy);
  assert.equal(upgraded.changed, true);
  assert.equal(upgraded.state.schemaVersion, 4);
  assert.deepEqual(upgraded.state.products, []);
  assert.deepEqual(upgraded.state.orders, []);
  assert.equal(upgraded.state.users[0].id, 'preserved-user');
  assert.doesNotThrow(() => assertStateShape(upgraded.state));
});

test('MySQL legacy state adapter does not use a global advisory lock or rewrite unchanged rows', async () => {
  const source = await readFile(new URL('../src/storage/mysql-store.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /GET_LOCK|RELEASE_LOCK/);
  assert.match(source, /SET TRANSACTION ISOLATION LEVEL SERIALIZABLE/);
  assert.match(source, /samePayload\(item, originalById\.get\(item\.id\)\)/);
});
