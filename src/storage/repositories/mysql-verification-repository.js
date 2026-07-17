import { randomUUID } from 'node:crypto';
import { AppError } from '../../core/app-error.js';

function parsePayload(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function sqlDate(value) { return value ? new Date(value) : null; }

function assertLicenseUsable(license, now) {
  if (license.status === 'disabled') throw new AppError('LICENSE_DISABLED', 'License is disabled', 403);
  if (license.status === 'expired' || (license.expiresAt && Date.parse(license.expiresAt) <= now)) {
    throw new AppError('LICENSE_EXPIRED', 'License has expired', 403);
  }
}

// Author: 花落. MySQL activation and verification transactions are provided under the MIT License.
export class MysqlVerificationRepository {
  constructor(pool) { this.pool = pool; }

  async #withRetry(operation) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await operation(); } catch (error) {
        lastError = error;
        if (!['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error?.code)) throw error;
      }
    }
    throw lastError;
  }

  async getActiveApplication(appId) {
    const [appRows] = await this.pool.execute('SELECT payload, merchant_id, status FROM applications WHERE id = ?', [appId]);
    if (!appRows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    if (appRows[0].status !== 'active') throw new AppError('APPLICATION_DISABLED', 'Application is disabled', 403);
    const [merchantRows] = await this.pool.execute('SELECT status FROM merchants WHERE id = ?', [appRows[0].merchant_id]);
    if (!merchantRows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
    if (merchantRows[0].status !== 'active') throw new AppError('MERCHANT_DISABLED', 'Merchant is disabled', 403);
    return parsePayload(appRows[0].payload);
  }

  async activate(input) {
    return this.#withRetry(() => this.#activateOnce(input));
  }

  async #activateOnce(input) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const application = await this.#lockActiveApplication(connection, input.appId);
      const [licenseRows] = await connection.execute(
        'SELECT payload FROM licenses WHERE app_id = ? AND key_digest = ? FOR UPDATE',
        [input.appId, input.licenseDigest],
      );
      if (!licenseRows[0]) throw new AppError('LICENSE_INVALID', 'License key is invalid for this application', 401);
      const license = parsePayload(licenseRows[0].payload);
      assertLicenseUsable(license, input.nowMilliseconds);
      if (!license.activatedAt) {
        license.activatedAt = input.now;
        if (license.durationDays) license.expiresAt = new Date(input.nowMilliseconds + license.durationDays * 86400000).toISOString();
        license.status = 'active';
        license.updatedAt = input.now;
        await this.#saveLicense(connection, license);
      }
      assertLicenseUsable(license, input.nowMilliseconds);

      const [bindingRows] = await connection.execute(
        "SELECT payload FROM device_bindings WHERE license_id = ? AND device_digest = ? AND status = 'active' FOR UPDATE",
        [license.id, input.deviceDigest],
      );
      let binding = bindingRows[0] ? parsePayload(bindingRows[0].payload) : null;
      if (!binding) {
        if (license.maxDevices > 0) {
          const [countRows] = await connection.execute(
            "SELECT COUNT(*) AS total FROM device_bindings WHERE license_id = ? AND status = 'active'",
            [license.id],
          );
          if (Number(countRows[0]?.total ?? 0) >= license.maxDevices) {
            throw new AppError('DEVICE_LIMIT_REACHED', 'License device limit has been reached', 409);
          }
        }
        binding = {
          id: randomUUID(), merchantId: license.merchantId, appId: input.appId, licenseId: license.id,
          deviceDigest: input.deviceDigest, deviceLabel: input.deviceLabel, status: 'active', boundAt: input.now,
          lastVerifiedAt: input.now, revokedAt: null, updatedAt: input.now,
        };
        await connection.execute(
          'INSERT INTO device_bindings (id, merchant_id, app_id, license_id, device_digest, status, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [binding.id, binding.merchantId, binding.appId, binding.licenseId, binding.deviceDigest, binding.status, sqlDate(binding.boundAt), JSON.stringify(binding)],
        );
      } else {
        binding.lastVerifiedAt = input.now;
        binding.deviceLabel = input.deviceLabel || binding.deviceLabel;
        binding.updatedAt = input.now;
        await this.#saveBinding(connection, binding);
      }
      const sessionExpiresAt = new Date(Math.min(input.nowMilliseconds + input.clientSessionTtlSeconds * 1000, Date.parse(license.expiresAt))).toISOString();
      const session = {
        id: randomUUID(), merchantId: license.merchantId, appId: input.appId, licenseId: license.id, bindingId: binding.id,
        tokenDigest: input.sessionDigest, createdAt: input.now, expiresAt: sessionExpiresAt, lastVerifiedAt: input.now,
      };
      await connection.execute(
        'INSERT INTO client_sessions (id, merchant_id, app_id, license_id, binding_id, token_digest, expires_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [session.id, session.merchantId, session.appId, session.licenseId, session.bindingId, session.tokenDigest, sqlDate(session.expiresAt), JSON.stringify(session)],
      );
      await this.#appendLog(connection, { merchantId: license.merchantId, appId: input.appId, licenseId: license.id, bindingId: binding.id, event: 'activate', resultCode: 'LICENSE_VALID', clientVersion: input.clientVersion, createdAt: input.now });
      await connection.commit();
      return { application, licenseId: license.id, bindingId: binding.id, licenseExpiresAt: license.expiresAt, sessionExpiresAt };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async verify(input) {
    return this.#withRetry(() => this.#verifyOnce(input));
  }

  async #verifyOnce(input) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const application = await this.#lockActiveApplication(connection, input.appId);
      const [sessionRows] = await connection.execute(
        'SELECT payload FROM client_sessions WHERE app_id = ? AND token_digest = ? FOR UPDATE',
        [input.appId, input.sessionDigest],
      );
      if (!sessionRows[0]) throw new AppError('SESSION_EXPIRED', 'Verification session is invalid or expired', 401);
      const session = parsePayload(sessionRows[0].payload);
      if (Date.parse(session.expiresAt) <= input.nowMilliseconds) throw new AppError('SESSION_EXPIRED', 'Verification session is invalid or expired', 401);
      const [licenseRows] = await connection.execute('SELECT payload FROM licenses WHERE id = ? FOR UPDATE', [session.licenseId]);
      if (!licenseRows[0]) throw new AppError('LICENSE_INVALID', 'License is unavailable', 401);
      const license = parsePayload(licenseRows[0].payload);
      assertLicenseUsable(license, input.nowMilliseconds);
      const [bindingRows] = await connection.execute('SELECT payload FROM device_bindings WHERE id = ? FOR UPDATE', [session.bindingId]);
      const binding = bindingRows[0] ? parsePayload(bindingRows[0].payload) : null;
      if (!binding || binding.deviceDigest !== input.deviceDigest || binding.status !== 'active') {
        throw new AppError('DEVICE_MISMATCH', 'The verification device does not match the binding', 401);
      }
      binding.lastVerifiedAt = input.now;
      binding.updatedAt = input.now;
      await this.#saveBinding(connection, binding);
      session.lastVerifiedAt = input.now;
      session.expiresAt = new Date(Math.min(input.nowMilliseconds + input.clientSessionTtlSeconds * 1000, Date.parse(license.expiresAt))).toISOString();
      await connection.execute('UPDATE client_sessions SET expires_at = ?, payload = ? WHERE id = ?', [sqlDate(session.expiresAt), JSON.stringify(session), session.id]);
      await this.#appendLog(connection, { merchantId: license.merchantId, appId: input.appId, licenseId: license.id, bindingId: binding.id, event: 'verify', resultCode: 'LICENSE_VALID', clientVersion: input.clientVersion, createdAt: input.now });
      await connection.commit();
      return { application, licenseId: license.id, bindingId: binding.id, licenseExpiresAt: license.expiresAt, sessionExpiresAt: session.expiresAt };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async #lockActiveApplication(connection, appId) {
    const [identityRows] = await connection.execute('SELECT merchant_id FROM applications WHERE id = ?', [appId]);
    if (!identityRows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    const [merchantRows] = await connection.execute('SELECT status FROM merchants WHERE id = ? FOR UPDATE', [identityRows[0].merchant_id]);
    if (!merchantRows[0]) throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
    if (merchantRows[0].status !== 'active') throw new AppError('MERCHANT_DISABLED', 'Merchant is disabled', 403);
    const [appRows] = await connection.execute('SELECT payload, status FROM applications WHERE id = ? FOR UPDATE', [appId]);
    if (!appRows[0]) throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    if (appRows[0].status !== 'active') throw new AppError('APPLICATION_DISABLED', 'Application is disabled', 403);
    return parsePayload(appRows[0].payload);
  }

  async #saveLicense(connection, license) {
    await connection.execute('UPDATE licenses SET status = ?, expires_at = ?, payload = ? WHERE id = ?', [license.status, sqlDate(license.expiresAt), JSON.stringify(license), license.id]);
  }

  async #saveBinding(connection, binding) {
    await connection.execute('UPDATE device_bindings SET status = ?, payload = ? WHERE id = ?', [binding.status, JSON.stringify(binding), binding.id]);
  }

  async #appendLog(connection, entry) {
    const log = { id: randomUUID(), ...entry };
    await connection.execute(
      'INSERT INTO verification_logs (id, merchant_id, app_id, license_id, binding_id, event, result_code, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [log.id, log.merchantId, log.appId, log.licenseId, log.bindingId, log.event, log.resultCode, sqlDate(log.createdAt), JSON.stringify(log)],
    );
  }
}
