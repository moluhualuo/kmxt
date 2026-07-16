// 作者：花落；本运维诊断脚本按 MIT License 使用。
import { loadConfig } from '/app/src/config.js';
import { mysqlConnectionOptions } from '/app/src/storage/migrate.js';

const LOCK_NAME = 'kmxt_state_transaction';
const STATE_TABLES = [
  'merchants',
  'users',
  'admin_sessions',
  'applications',
  'products',
  'license_batches',
  'licenses',
  'orders',
  'device_bindings',
  'client_sessions',
  'audit_logs',
  'verification_logs',
];
const config = loadConfig();
const mysql = await import('mysql2/promise');
const connection = await mysql.createConnection(await mysqlConnectionOptions(config));

try {
  const [[lock]] = await connection.execute(
    'SELECT CONNECTION_ID() AS diagnosticConnectionId, '
      + 'IS_USED_LOCK(?) AS lockOwnerConnectionId, IS_FREE_LOCK(?) AS lockIsFree',
    [LOCK_NAME, LOCK_NAME],
  );

  const [processes] = await connection.execute(
    `SELECT ID AS connectionId, USER AS user, HOST AS host, DB AS databaseName,
            COMMAND AS command, TIME AS secondsInState, STATE AS state,
            LEFT(INFO, 240) AS statement
       FROM information_schema.PROCESSLIST
      WHERE DB = ? OR ID = ?
      ORDER BY ID`,
    [config.mysql.database, lock.lockOwnerConnectionId ?? -1],
  );

  let userLevelLocks = [];
  let performanceSchemaError = null;
  try {
    const [rows] = await connection.query(
      `SELECT threads.PROCESSLIST_ID AS connectionId,
              locks.OBJECT_NAME AS lockName,
              locks.LOCK_TYPE AS lockType,
              locks.LOCK_DURATION AS lockDuration,
              locks.LOCK_STATUS AS lockStatus
         FROM performance_schema.metadata_locks AS locks
         JOIN performance_schema.threads AS threads
           ON threads.THREAD_ID = locks.OWNER_THREAD_ID
        WHERE locks.OBJECT_TYPE = 'USER LEVEL LOCK'`,
    );
    userLevelLocks = rows;
  } catch (error) {
    performanceSchemaError = error.code || error.message;
  }

  const tableStats = [];
  for (const table of STATE_TABLES) {
    const startedAt = performance.now();
    const [[row]] = await connection.query(
      `SELECT COUNT(*) AS rowCount,
              COALESCE(SUM(OCTET_LENGTH(payload)), 0) AS payloadBytes
         FROM \`${table}\``,
    );
    tableStats.push({
      table,
      rowCount: Number(row.rowCount),
      payloadBytes: Number(row.payloadBytes),
      queryMilliseconds: Math.round((performance.now() - startedAt) * 100) / 100,
    });
  }

  console.log(JSON.stringify({
    lockName: LOCK_NAME,
    ...lock,
    processes,
    userLevelLocks,
    performanceSchemaError,
    tableStats,
  }, null, 2));
} finally {
  await connection.end();
}
