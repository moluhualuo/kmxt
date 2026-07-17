import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(sourceDirectory, '..');

function readInteger(name, fallback, minimum = 1) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === '') {
    return fallback;
  }

  const value = Number.parseInt(rawValue, 10);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function resolveFromRoot(value, fallback) {
  return path.resolve(projectRoot, value || fallback);
}

function optionalPath(value) {
  return value ? path.resolve(projectRoot, value) : '';
}

function readBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (['1', 'true', 'yes'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no'].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

function readEnum(name, fallback, values) {
  const value = process.env[name] || fallback;
  if (!values.includes(value)) {
    throw new Error(`${name} must be one of: ${values.join(', ')}`);
  }
  return value;
}

export function loadConfig(overrides = {}) {
  const config = {
    host: process.env.KMXT_HOST || '127.0.0.1',
    port: readInteger('KMXT_PORT', 8080, 0),
    storageDriver: process.env.KMXT_STORAGE_DRIVER || 'json',
    dataFile: resolveFromRoot(process.env.KMXT_DATA_FILE, './data/kmxt.json'),
    secretFile: resolveFromRoot(process.env.KMXT_SECRET_FILE, './data/secret.key'),
    publicDirectory: resolveFromRoot(process.env.KMXT_PUBLIC_DIRECTORY, './public'),
    corsOrigin: process.env.KMXT_CORS_ORIGIN || '',
    maxBodyBytes: readInteger('KMXT_MAX_BODY_BYTES', 1024 * 1024),
    adminSessionTtlSeconds: readInteger('KMXT_ADMIN_SESSION_TTL_SECONDS', 8 * 60 * 60),
    clientSessionTtlSeconds: readInteger('KMXT_CLIENT_SESSION_TTL_SECONDS', 30 * 60),
    heartbeatSeconds: readInteger('KMXT_HEARTBEAT_SECONDS', 5 * 60),
    clockSkewSeconds: readInteger('KMXT_CLOCK_SKEW_SECONDS', 5 * 60),
    maxLicenseBatch: readInteger('KMXT_MAX_LICENSE_BATCH', 1000),
    publicBaseUrl: (process.env.KMXT_PUBLIC_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, ''),
    protocolVersion: readInteger('KMXT_PROTOCOL_VERSION', 1),
    trustedProxyCidrs: (process.env.KMXT_TRUSTED_PROXY_CIDRS || '')
      .split(',').map((value) => value.trim()).filter(Boolean),
    mysql: {
      host: process.env.KMXT_MYSQL_HOST || '127.0.0.1',
      port: readInteger('KMXT_MYSQL_PORT', 3306),
      user: process.env.KMXT_MYSQL_USER || 'kmxt',
      database: process.env.KMXT_MYSQL_DATABASE || 'kamxt1',
      passwordFile: optionalPath(process.env.KMXT_MYSQL_PASSWORD_FILE),
      tlsCaFile: optionalPath(process.env.KMXT_MYSQL_TLS_CA_FILE),
      tlsMode: readEnum('KMXT_MYSQL_TLS_MODE', 'verify_identity', ['verify_identity', 'disabled']),
      poolLimit: readInteger('KMXT_MYSQL_POOL_LIMIT', 10),
      autoMigrate: readBoolean('KMXT_MYSQL_AUTO_MIGRATE', false),
    },
    redis: {
      url: process.env.KMXT_REDIS_URL || '',
      passwordFile: optionalPath(process.env.KMXT_REDIS_PASSWORD_FILE),
      keyPrefix: process.env.KMXT_REDIS_KEY_PREFIX || 'kmxt:',
    },
    ...overrides,
  };

  if (!['json', 'mysql'].includes(config.storageDriver)) {
    throw new Error('KMXT_STORAGE_DRIVER must be json or mysql');
  }

  return Object.freeze(config);
}

export { projectRoot };
