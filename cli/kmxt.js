#!/usr/bin/env node
import { createRuntime } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/storage/migrate.js';
import { readFile } from 'node:fs/promises';

function parseArguments(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      result._.push(value);
      continue;
    }
    const key = value.slice(2);
    const nextValue = values[index + 1];
    if (!nextValue || nextValue.startsWith('--')) {
      result[key] = true;
    } else {
      result[key] = nextValue;
      index += 1;
    }
  }
  return result;
}

function usage() {
  console.log(`KMXT CLI

Usage:
  node cli/kmxt.js init
  node cli/kmxt.js migrate
  node cli/kmxt.js create-admin --username <name> --password <password> [--display-name <name>]
  node cli/kmxt.js serve [--host 127.0.0.1] [--port 8080]
  node cli/kmxt.js status
`);
}

const args = parseArguments(process.argv.slice(2));
const command = args._[0];

if (!command || command === 'help' || args.help) {
  usage();
  process.exit(0);
}

const overrides = {};
if (args.host) {
  overrides.host = args.host;
}
if (args.port) {
  const port = Number.parseInt(args.port, 10);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error('--port must be an integer between 0 and 65535');
  }
  overrides.port = port;
}

if (command === 'migrate') {
  const completed = await runMigrations(loadConfig(overrides));
  console.log(JSON.stringify({ migrated: true, applied: completed }, null, 2));
  process.exit(0);
}

const runtime = await createRuntime(overrides);

if (command === 'init') {
  console.log(JSON.stringify({ initialized: true, dataFile: runtime.config.dataFile }, null, 2));
  await runtime.close();
  process.exit(0);
}

if (command === 'create-admin') {
  const password = args['password-file']
    ? (await readFile(args['password-file'], 'utf8')).trim()
    : args.password;
  if (!args.username || !password) {
    throw new Error('--username and either --password or --password-file are required');
  }
  const user = await runtime.services.auth.bootstrapPlatformAdmin({
    username: args.username,
    password,
    displayName: args['display-name'],
  });
  console.log(JSON.stringify(user, null, 2));
  await runtime.close();
  process.exit(0);
}

if (command === 'status') {
  const summary = await runtime.store.read((state) => ({
    schemaVersion: state.schemaVersion,
    merchants: state.merchants.length,
    applications: state.applications.length,
    products: state.products.length,
    orders: state.orders.length,
    licenses: state.licenses.length,
    users: state.users.length,
    updatedAt: state.meta.updatedAt,
  }));
  console.log(JSON.stringify(summary, null, 2));
  await runtime.close();
  process.exit(0);
}

if (command === 'serve') {
  const address = await runtime.listen();
  const visibleHost = address.address === '::' ? 'localhost' : address.address;
  console.log(`KMXT server listening at http://${visibleHost}:${address.port}`);
  const close = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
} else {
  usage();
  process.exitCode = 1;
}
