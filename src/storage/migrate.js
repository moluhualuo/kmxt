import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequiredSecretFile, readRequiredTextFile } from './secret-file.js';

const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

export async function mysqlConnectionOptions(config, { multipleStatements = false } = {}) {
  const password = await readRequiredSecretFile(config.mysql.passwordFile, 'MySQL password');
  const tlsMode = config.mysql.tlsMode ?? 'verify_identity';
  const ssl = tlsMode === 'verify_identity'
    ? {
        ca: await readRequiredTextFile(config.mysql.tlsCaFile, 'MySQL TLS CA'),
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
      }
    : undefined;
  return {
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password,
    database: config.mysql.database,
    ...(ssl ? { ssl } : {}),
    charset: 'utf8mb4',
    timezone: 'Z',
    connectTimeout: config.mysql.operationTimeoutMs ?? 8_000,
    multipleStatements,
  };
}

export async function runMigrations(config) {
  const mysql = await import('mysql2/promise');
  const connection = await mysql.createConnection(await mysqlConnectionOptions(config, {
    multipleStatements: true,
  }));
  try {
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(100) PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    const files = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    const [rows] = await connection.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.version));
    const completed = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(migrationsDirectory, file), 'utf8');
      await connection.beginTransaction();
      try {
        await connection.query(sql);
        await connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
        await connection.commit();
        completed.push(file);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }
    return completed;
  } finally {
    await connection.end();
  }
}
