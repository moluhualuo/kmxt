#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.js';
import { MysqlStore } from '../src/storage/mysql-store.js';
import { runMigrations } from '../src/storage/migrate.js';
import { assertStateShape } from '../src/storage/schema.js';

const decompress = promisify(gunzip);
const COLLECTIONS = [
  'merchants',
  'users',
  'adminSessions',
  'applications',
  'products',
  'licenseBatches',
  'licenses',
  'orders',
  'deviceBindings',
  'clientSessions',
  'auditLogs',
  'verificationLogs',
];

// Author: 花落. MIT License. This tool only imports a validated snapshot into an empty MySQL state.
async function readState(sourcePath) {
  const input = await readFile(sourcePath);
  const json = sourcePath.toLowerCase().endsWith('.gz') ? await decompress(input) : input;
  const document = JSON.parse(json.toString('utf8'));
  const state = document?.state && typeof document.state === 'object'
    ? {
        schemaVersion: document.schemaVersion,
        meta: document.meta,
        ...document.state,
      }
    : document;
  assertStateShape(state);
  return state;
}

function counts(state) {
  return Object.fromEntries(COLLECTIONS.map((collection) => [collection, state[collection].length]));
}

async function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath || process.argv.length !== 3) {
    throw new Error('Usage: node cli/import-state-json.js <state.json|state.json.gz>');
  }

  const config = loadConfig();
  if (config.storageDriver !== 'mysql') {
    throw new Error('KMXT_STORAGE_DRIVER must be mysql for this import');
  }

  const importedState = await readState(sourcePath);
  await runMigrations(config);
  const store = new MysqlStore(config);
  try {
    await store.initialize();
    const destinationCounts = await store.read((state) => counts(state));
    if (Object.values(destinationCounts).some((count) => count !== 0)) {
      throw new Error('Refusing to import because the destination contains state records');
    }

    await store.transaction((draft) => {
      for (const collection of COLLECTIONS) {
        draft[collection] = structuredClone(importedState[collection]);
      }
    });

    const persistedCounts = await store.read((state) => counts(state));
    const expectedCounts = counts(importedState);
    if (JSON.stringify(persistedCounts) !== JSON.stringify(expectedCounts)) {
      throw new Error('Imported row counts do not match the source snapshot');
    }
    console.log(JSON.stringify({ imported: true, counts: persistedCounts }, null, 2));
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(`Import failed: ${error.message}`);
  process.exitCode = 1;
});
