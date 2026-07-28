import { randomUUID } from 'node:crypto';
import { AppError } from '../../core/app-error.js';
import { Roles } from '../../services/access-control.js';
import { onlineWindowSeconds } from '../../services/online-device-service.js';

function parsePayload(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function pageLimit(pagination) { return Math.max(1, Math.trunc(Number(pagination.limit) || 20)); }
function pageOffset(pagination) { return Math.max(0, Math.trunc(Number(pagination.offset) || 0)); }
function assertAccess(actor, merchantId) {
  if (actor.role !== Roles.PLATFORM_ADMIN && actor.merchantId !== merchantId) {
    throw new AppError('FORBIDDEN', 'Cross-merchant access is not allowed', 403);
  }
}

function onlineExists(alias = 'presence') {
  return `EXISTS (
    SELECT 1 FROM client_sessions ${alias}
    WHERE ${alias}.binding_id = db.id
      AND ${alias}.expires_at > ?
      AND JSON_UNQUOTE(JSON_EXTRACT(${alias}.payload, '$.lastVerifiedAt')) >= ?
  )`;
}

function deviceItem(binding, license, session, cutoffMilliseconds) {
  const lastSeenAt = session?.lastVerifiedAt || binding.lastVerifiedAt || binding.boundAt;
  const online = Boolean(session && Date.parse(lastSeenAt) >= cutoffMilliseconds);
  return {
    bindingId: binding.id,
    licenseId: binding.licenseId,
    licenseKeyPreview: license?.keyPreview || null,
    deviceLabel: binding.deviceLabel || '未命名设备',
    clientVersion: session?.clientVersion || binding.lastClientVersion || null,
    ipAddress: session?.ipAddress || binding.lastIpAddress || null,
    online,
    status: online ? 'online' : 'offline',
    boundAt: binding.boundAt,
    lastSeenAt,
    sessionExpiresAt: session?.expiresAt || null,
  };
}

// Author: 花落. Indexed MySQL online-device queries are provided under the MIT License.
export class MysqlOnlineDeviceRepository {
  constructor(pool) { this.pool = pool; }

  async list(actor, appId, pagination, filters) {
    const application = await this.#application(actor, appId);
    const windowSeconds = onlineWindowSeconds(application, filters.fallbackHeartbeatSeconds);
    const now = new Date(filters.nowMilliseconds);
    const cutoff = new Date(filters.nowMilliseconds - windowSeconds * 1000).toISOString();
    const conditions = ["db.app_id = ?", "db.status = 'active'"];
    const conditionValues = [appId];
    if (filters.status === 'online') {
      conditions.push(onlineExists('filtered_session'));
      conditionValues.push(now, cutoff);
    } else if (filters.status === 'offline') {
      conditions.push(`NOT ${onlineExists('filtered_session')}`);
      conditionValues.push(now, cutoff);
    }
    if (filters.search) {
      conditions.push(`(
        LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(db.payload, '$.deviceLabel')), '')) LIKE ?
        OR LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.payload, '$.keyPreview')), '')) LIKE ?
        OR LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(db.payload, '$.lastClientVersion')), '')) LIKE ?
        OR LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(db.payload, '$.lastIpAddress')), '')) LIKE ?
      )`);
      const pattern = `%${filters.search}%`;
      conditionValues.push(pattern, pattern, pattern, pattern);
    }
    const where = ` WHERE ${conditions.join(' AND ')}`;
    const limit = pageLimit(pagination);
    const offset = pageOffset(pagination);
    const [summaryRows] = await this.pool.execute(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN ${onlineExists('summary_session')} THEN 1 ELSE 0 END) AS online
       FROM device_bindings db
       WHERE db.app_id = ? AND db.status = 'active'`,
      [now, cutoff, appId],
    );
    const [[countRows], [rows]] = await Promise.all([
      this.pool.execute(
        `SELECT COUNT(*) AS total FROM device_bindings db JOIN licenses l ON l.id = db.license_id${where}`,
        conditionValues,
      ),
      this.pool.execute(
        `SELECT db.payload AS binding_payload, l.payload AS license_payload,
          (SELECT latest.payload FROM client_sessions latest
           WHERE latest.binding_id = db.id AND latest.expires_at > ?
           ORDER BY JSON_UNQUOTE(JSON_EXTRACT(latest.payload, '$.lastVerifiedAt')) DESC LIMIT 1) AS session_payload
         FROM device_bindings db
         JOIN licenses l ON l.id = db.license_id${where}
         ORDER BY JSON_UNQUOTE(JSON_EXTRACT(db.payload, '$.lastVerifiedAt')) DESC, db.created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        [now, ...conditionValues],
      ),
    ]);
    const totalDevices = Number(summaryRows[0]?.total ?? 0);
    const onlineDevices = Number(summaryRows[0]?.online ?? 0);
    const cutoffMilliseconds = Date.parse(cutoff);
    return {
      items: rows.map((row) => deviceItem(
        parsePayload(row.binding_payload),
        parsePayload(row.license_payload),
        row.session_payload ? parsePayload(row.session_payload) : null,
        cutoffMilliseconds,
      )),
      page: pagination.page,
      limit: pagination.limit,
      total: Number(countRows[0]?.total ?? 0),
      summary: {
        total: totalDevices,
        online: onlineDevices,
        offline: totalDevices - onlineDevices,
        onlineWindowSeconds: windowSeconds,
      },
    };
  }

  async disconnect(actor, bindingId) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute('SELECT payload FROM device_bindings WHERE id = ? FOR UPDATE', [bindingId]);
      if (!rows[0]) throw new AppError('DEVICE_BINDING_NOT_FOUND', 'Device binding was not found', 404);
      const binding = parsePayload(rows[0].payload);
      assertAccess(actor, binding.merchantId);
      const [result] = await connection.execute('DELETE FROM client_sessions WHERE binding_id = ?', [bindingId]);
      const disconnectedSessions = Number(result.affectedRows ?? 0);
      if (disconnectedSessions > 0) {
        const now = new Date().toISOString();
        const entry = {
          id: randomUUID(), merchantId: binding.merchantId, actorUserId: actor.id,
          actorUsername: actor.username ?? 'system', action: 'device.disconnect',
          resourceType: 'device_binding', resourceId: binding.id,
          metadata: { appId: binding.appId, licenseId: binding.licenseId, disconnectedSessions }, createdAt: now,
        };
        await connection.execute(
          'INSERT INTO audit_logs (id, merchant_id, actor_id, action, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
          [entry.id, entry.merchantId, entry.actorUserId, entry.action, new Date(now), JSON.stringify(entry)],
        );
      }
      await connection.commit();
      return { bindingId, disconnectedSessions };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async #application(actor, appId) {
    const [rows] = await this.pool.execute('SELECT payload, merchant_id FROM applications WHERE id = ?', [appId]);
    if (!rows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    assertAccess(actor, rows[0].merchant_id);
    return parsePayload(rows[0].payload);
  }
}
