import { randomUUID } from 'node:crypto';

function sqlDate(value) { return value ? new Date(value) : null; }

// Author: 花落. MySQL maintenance cleanup and audit summaries are MIT licensed.
export class MysqlMaintenanceRepository {
  constructor(pool) { this.pool = pool; }

  async cleanupSessions(now = Date.now()) {
    return this.#transaction(async (connection) => {
      const [adminResult] = await connection.execute('DELETE FROM admin_sessions WHERE expires_at <= ?', [new Date(now)]);
      const [clientResult] = await connection.execute('DELETE FROM client_sessions WHERE expires_at <= ?', [new Date(now)]);
      const summary = {
        expiredAdminSessions: Number(adminResult.affectedRows ?? 0),
        expiredClientSessions: Number(clientResult.affectedRows ?? 0),
      };
      await this.#audit(connection, 'maintenance.sessions.cleanup', summary, new Date(now).toISOString());
      return summary;
    });
  }

  async cleanupVerificationLogs(retentionDays, cutoff) {
    return this.#transaction(async (connection) => {
      const [result] = await connection.execute('DELETE FROM verification_logs WHERE created_at < ?', [new Date(cutoff)]);
      const summary = {
        deletedVerificationLogs: Number(result.affectedRows ?? 0),
        retentionDays,
        cutoff: new Date(cutoff).toISOString(),
      };
      await this.#audit(connection, 'maintenance.verification_logs.cleanup', summary, new Date().toISOString());
      return summary;
    });
  }

  async #transaction(operation) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async #audit(connection, action, metadata, createdAt) {
    const entry = {
      id: randomUUID(), merchantId: null, actorUserId: null, actorUsername: 'system', action,
      resourceType: 'maintenance', resourceId: null, metadata, createdAt,
    };
    await connection.execute(
      'INSERT INTO audit_logs (id, merchant_id, actor_id, action, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
      [entry.id, null, null, entry.action, sqlDate(entry.createdAt), JSON.stringify(entry)],
    );
  }
}
