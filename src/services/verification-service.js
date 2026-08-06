import { randomUUID } from 'node:crypto';
import { AppError } from '../core/app-error.js';
import { optionalString, requireString } from '../core/validation.js';
import {
  createOpaqueToken,
  createSignedEnvelope,
  decryptText,
  digestSecret,
  normalizeLicenseKey,
} from '../security/crypto.js';
import { ReplayGuard } from '../security/replay-guard.js';
import {
  findApplicationOrThrow,
  findMerchantOrThrow,
} from './access-control.js';
import { assertClientIntegrity, parseClientIntegrityInput } from './client-integrity.js';

function ensureLicenseUsable(license, now) {
  if (license.status === 'disabled') {
    throw new AppError('LICENSE_DISABLED', 'License is disabled', 403);
  }
  if (license.status === 'expired' || (license.expiresAt && Date.parse(license.expiresAt) <= now)) {
    throw new AppError('LICENSE_EXPIRED', 'License has expired', 403);
  }
}

function appendVerificationLog(state, entry) {
  state.verificationLogs.push({
    id: randomUUID(),
    merchantId: entry.merchantId,
    appId: entry.appId,
    licenseId: entry.licenseId,
    bindingId: entry.bindingId,
    event: entry.event,
    resultCode: entry.resultCode,
    clientVersion: entry.clientVersion,
    createdAt: new Date().toISOString(),
  });
}

// Author: 花落. The signed authorization contract is provided under the MIT License.
export class VerificationService {
  constructor(store, rootSecret, config, securityState, announcements = null) {
    this.store = store;
    this.rootSecret = rootSecret;
    this.config = config;
    this.replayGuard = new ReplayGuard(config.clockSkewSeconds, securityState);
    // 花落 / MIT：公告服务可选注入。缺省为 null 时签名载荷仍带 clientPolicy，
    // 只是 announcements 恒为空数组，便于测试单独构造本服务。
    this.announcements = announcements;
  }

  async activate(input) {
    const appId = requireString(input.appId, 'appId', { min: 36, max: 36 });
    const licenseKey = requireString(input.licenseKey, 'licenseKey', { min: 20, max: 128 });
    const deviceId = requireString(input.deviceId, 'deviceId', { min: 8, max: 256, normalize: false });
    const deviceLabel = optionalString(input.deviceLabel, 'deviceLabel', { min: 1, max: 100 });
    const clientVersion = optionalString(input.clientVersion, 'clientVersion', { min: 1, max: 50 });
    const clientIp = optionalString(input.clientIp, 'clientIp', { min: 2, max: 64, normalize: false });
    const clientIntegrity = parseClientIntegrityInput(input);
    const appSnapshot = await this.#getActiveApplication(appId);
    // WS4 防重打包：应用注册了绑定约束时，强制校验客户端 packageName/证书指纹/versionCode。
    assertClientIntegrity(appSnapshot, clientIntegrity);
    await this.replayGuard.assertFresh(`activate:${appId}`, input.timestamp, input.nonce);

    const nowMilliseconds = Date.now();
    const now = new Date(nowMilliseconds).toISOString();
    const licenseDigest = digestSecret(
      this.rootSecret,
      'license-key',
      normalizeLicenseKey(licenseKey),
    );
    const deviceDigest = digestSecret(this.rootSecret, `device:${appId}`, deviceId);
    const sessionToken = createOpaqueToken();
    const sessionDigest = digestSecret(this.rootSecret, 'client-session', sessionToken);

    if (this.store.repositories?.verification) {
      const activation = await this.store.repositories.verification.activate({
        appId, licenseDigest, deviceDigest, deviceLabel, clientVersion, clientIp, sessionDigest,
        nowMilliseconds, now, clientSessionTtlSeconds: this.config.clientSessionTtlSeconds,
      });
      return this.#sign(activation.application, {
        licensed: true, code: 'LICENSE_VALID', appId, licenseId: activation.licenseId, bindingId: activation.bindingId,
        sessionToken, issuedAt: now, licenseExpiresAt: activation.licenseExpiresAt, sessionExpiresAt: activation.sessionExpiresAt,
        heartbeatAfterSeconds: appSnapshot.settings.heartbeatSeconds, offlineGraceSeconds: appSnapshot.settings.offlineGraceSeconds,
        requestNonce: input.nonce,
        ...await this.#clientContext(appSnapshot, nowMilliseconds),
      });
    }

    const activation = await this.store.transaction((state) => {
      const application = findApplicationOrThrow(state, appId, { requireActive: true });
      findMerchantOrThrow(state, application.merchantId, { requireActive: true });
      const license = state.licenses.find(
        (item) => item.appId === appId && item.keyDigest === licenseDigest,
      );
      if (!license) {
        throw new AppError('LICENSE_INVALID', 'License key is invalid for this application', 401);
      }
      ensureLicenseUsable(license, nowMilliseconds);

      if (!license.activatedAt) {
        license.activatedAt = now;
        if (license.durationDays) {
          license.expiresAt = new Date(
            nowMilliseconds + license.durationDays * 24 * 60 * 60 * 1000,
          ).toISOString();
        }
        license.status = 'active';
        license.updatedAt = now;
      }
      ensureLicenseUsable(license, nowMilliseconds);

      let binding = state.deviceBindings.find(
        (item) => item.licenseId === license.id
          && item.deviceDigest === deviceDigest
          && item.status === 'active',
      );
      if (!binding) {
        const activeBindings = state.deviceBindings.filter(
          (item) => item.licenseId === license.id && item.status === 'active',
        );
        if (license.maxDevices > 0 && activeBindings.length >= license.maxDevices) {
          throw new AppError('DEVICE_LIMIT_REACHED', 'License device limit has been reached', 409);
        }
        binding = {
          id: randomUUID(),
          merchantId: license.merchantId,
          appId,
          licenseId: license.id,
          deviceDigest,
          deviceLabel,
          status: 'active',
          boundAt: now,
          lastVerifiedAt: now,
          lastClientVersion: clientVersion,
          lastIpAddress: clientIp,
          revokedAt: null,
          updatedAt: now,
        };
        state.deviceBindings.push(binding);
      } else {
        binding.lastVerifiedAt = now;
        binding.deviceLabel = deviceLabel || binding.deviceLabel;
        binding.lastClientVersion = clientVersion || binding.lastClientVersion;
        binding.lastIpAddress = clientIp || binding.lastIpAddress;
        binding.updatedAt = now;
      }

      const sessionExpiresAt = new Date(Math.min(
        nowMilliseconds + this.config.clientSessionTtlSeconds * 1000,
        Date.parse(license.expiresAt),
      )).toISOString();
      state.clientSessions = state.clientSessions.filter(
        (session) => Date.parse(session.expiresAt) > nowMilliseconds,
      );
      state.clientSessions.push({
        id: randomUUID(),
        merchantId: license.merchantId,
        appId,
        licenseId: license.id,
        bindingId: binding.id,
        tokenDigest: sessionDigest,
        createdAt: now,
        expiresAt: sessionExpiresAt,
        lastVerifiedAt: now,
        clientVersion,
        ipAddress: clientIp,
      });
      appendVerificationLog(state, {
        merchantId: license.merchantId,
        appId,
        licenseId: license.id,
        bindingId: binding.id,
        event: 'activate',
        resultCode: 'LICENSE_VALID',
        clientVersion,
      });
      return {
        application,
        licenseId: license.id,
        bindingId: binding.id,
        licenseExpiresAt: license.expiresAt,
        sessionExpiresAt,
      };
    });

    return this.#sign(activation.application, {
      licensed: true,
      code: 'LICENSE_VALID',
      appId,
      licenseId: activation.licenseId,
      bindingId: activation.bindingId,
      sessionToken,
      issuedAt: now,
      licenseExpiresAt: activation.licenseExpiresAt,
      sessionExpiresAt: activation.sessionExpiresAt,
      heartbeatAfterSeconds: appSnapshot.settings.heartbeatSeconds,
      offlineGraceSeconds: appSnapshot.settings.offlineGraceSeconds,
      requestNonce: input.nonce,
      ...await this.#clientContext(appSnapshot, nowMilliseconds),
    });
  }

  async verify(input) {
    const appId = requireString(input.appId, 'appId', { min: 36, max: 36 });
    const sessionToken = requireString(input.sessionToken, 'sessionToken', {
      min: 32,
      max: 128,
      normalize: false,
    });
    const deviceId = requireString(input.deviceId, 'deviceId', { min: 8, max: 256, normalize: false });
    const clientVersion = optionalString(input.clientVersion, 'clientVersion', { min: 1, max: 50 });
    const clientIp = optionalString(input.clientIp, 'clientIp', { min: 2, max: 64, normalize: false });
    const clientIntegrity = parseClientIntegrityInput(input);
    const appSnapshot = await this.#getActiveApplication(appId);
    // WS4 防重打包：应用注册了绑定约束时，强制校验客户端 packageName/证书指纹/versionCode。
    assertClientIntegrity(appSnapshot, clientIntegrity);
    await this.replayGuard.assertFresh(`verify:${appId}`, input.timestamp, input.nonce);

    const nowMilliseconds = Date.now();
    const now = new Date(nowMilliseconds).toISOString();
    const sessionDigest = digestSecret(this.rootSecret, 'client-session', sessionToken);
    const deviceDigest = digestSecret(this.rootSecret, `device:${appId}`, deviceId);

    if (this.store.repositories?.verification) {
      const verification = await this.store.repositories.verification.verify({
        appId, sessionDigest, deviceDigest, clientVersion, clientIp, nowMilliseconds, now,
        clientSessionTtlSeconds: this.config.clientSessionTtlSeconds,
      });
      return this.#sign(verification.application, {
        licensed: true, code: 'LICENSE_VALID', appId, licenseId: verification.licenseId, bindingId: verification.bindingId,
        issuedAt: now, licenseExpiresAt: verification.licenseExpiresAt, sessionExpiresAt: verification.sessionExpiresAt,
        heartbeatAfterSeconds: appSnapshot.settings.heartbeatSeconds, offlineGraceSeconds: appSnapshot.settings.offlineGraceSeconds,
        requestNonce: input.nonce,
        ...await this.#clientContext(appSnapshot, nowMilliseconds),
      });
    }

    const verification = await this.store.transaction((state) => {
      const application = findApplicationOrThrow(state, appId, { requireActive: true });
      findMerchantOrThrow(state, application.merchantId, { requireActive: true });
      const session = state.clientSessions.find(
        (item) => item.appId === appId && item.tokenDigest === sessionDigest,
      );
      if (!session || Date.parse(session.expiresAt) <= nowMilliseconds) {
        throw new AppError('SESSION_EXPIRED', 'Verification session is invalid or expired', 401);
      }
      const license = state.licenses.find((item) => item.id === session.licenseId);
      if (!license) {
        throw new AppError('LICENSE_INVALID', 'License is unavailable', 401);
      }
      ensureLicenseUsable(license, nowMilliseconds);
      const binding = state.deviceBindings.find(
        (item) => item.id === session.bindingId
          && item.deviceDigest === deviceDigest
          && item.status === 'active',
      );
      if (!binding) {
        throw new AppError('DEVICE_MISMATCH', 'The verification device does not match the binding', 401);
      }

      binding.lastVerifiedAt = now;
      binding.lastClientVersion = clientVersion || binding.lastClientVersion;
      binding.lastIpAddress = clientIp || binding.lastIpAddress;
      binding.updatedAt = now;
      session.lastVerifiedAt = now;
      session.clientVersion = clientVersion || session.clientVersion;
      session.ipAddress = clientIp || session.ipAddress;
      session.expiresAt = new Date(Math.min(
        nowMilliseconds + this.config.clientSessionTtlSeconds * 1000,
        Date.parse(license.expiresAt),
      )).toISOString();
      appendVerificationLog(state, {
        merchantId: license.merchantId,
        appId,
        licenseId: license.id,
        bindingId: binding.id,
        event: 'verify',
        resultCode: 'LICENSE_VALID',
        clientVersion,
      });
      return {
        application,
        licenseId: license.id,
        bindingId: binding.id,
        licenseExpiresAt: license.expiresAt,
        sessionExpiresAt: session.expiresAt,
      };
    });

    return this.#sign(verification.application, {
      licensed: true,
      code: 'LICENSE_VALID',
      appId,
      licenseId: verification.licenseId,
      bindingId: verification.bindingId,
      issuedAt: now,
      licenseExpiresAt: verification.licenseExpiresAt,
      sessionExpiresAt: verification.sessionExpiresAt,
      heartbeatAfterSeconds: appSnapshot.settings.heartbeatSeconds,
      offlineGraceSeconds: appSnapshot.settings.offlineGraceSeconds,
      requestNonce: input.nonce,
      ...await this.#clientContext(appSnapshot, nowMilliseconds),
    });
  }

  async unbind(input) {
    const appId = requireString(input.appId, 'appId', { min: 36, max: 36 });
    const sessionToken = requireString(input.sessionToken, 'sessionToken', {
      min: 32,
      max: 128,
      normalize: false,
    });
    const deviceId = requireString(input.deviceId, 'deviceId', { min: 8, max: 256, normalize: false });
    const clientVersion = optionalString(input.clientVersion, 'clientVersion', { min: 1, max: 50 });
    const clientIp = optionalString(input.clientIp, 'clientIp', { min: 2, max: 64, normalize: false });
    await this.replayGuard.assertFresh(`unbind:${appId}`, input.timestamp, input.nonce);

    const nowMilliseconds = Date.now();
    const now = new Date(nowMilliseconds).toISOString();
    const sessionDigest = digestSecret(this.rootSecret, 'client-session', sessionToken);
    const deviceDigest = digestSecret(this.rootSecret, `device:${appId}`, deviceId);

    if (this.store.repositories?.verification) {
      const result = await this.store.repositories.verification.unbind({
        appId,
        sessionDigest,
        deviceDigest,
        clientVersion,
        clientIp,
        nowMilliseconds,
        now,
      });
      return this.#sign(result.application, {
        unbound: true,
        code: 'DEVICE_UNBOUND',
        appId,
        licenseId: result.licenseId,
        bindingId: result.bindingId,
        sessionsRevoked: result.sessionsRevoked,
        issuedAt: now,
        requestNonce: input.nonce,
      });
    }

    const result = await this.store.transaction((state) => {
      const application = findApplicationOrThrow(state, appId, { requireActive: true });
      findMerchantOrThrow(state, application.merchantId, { requireActive: true });
      const session = state.clientSessions.find(
        (item) => item.appId === appId && item.tokenDigest === sessionDigest,
      );
      if (!session || Date.parse(session.expiresAt) <= nowMilliseconds) {
        throw new AppError('SESSION_EXPIRED', 'Verification session is invalid or expired', 401);
      }
      const binding = state.deviceBindings.find(
        (item) => item.id === session.bindingId
          && item.deviceDigest === deviceDigest
          && item.status === 'active',
      );
      if (!binding) {
        throw new AppError('DEVICE_MISMATCH', 'The verification device does not match the binding', 401);
      }
      binding.status = 'revoked';
      binding.lastVerifiedAt = now;
      binding.lastClientVersion = clientVersion || binding.lastClientVersion;
      binding.lastIpAddress = clientIp || binding.lastIpAddress;
      binding.revokedAt = now;
      binding.updatedAt = now;
      const previousSessionCount = state.clientSessions.length;
      state.clientSessions = state.clientSessions.filter((item) => item.bindingId !== binding.id);
      const sessionsRevoked = previousSessionCount - state.clientSessions.length;
      appendVerificationLog(state, {
        merchantId: binding.merchantId,
        appId,
        licenseId: binding.licenseId,
        bindingId: binding.id,
        event: 'unbind',
        resultCode: 'DEVICE_UNBOUND',
        clientVersion,
      });
      return {
        application,
        licenseId: binding.licenseId,
        bindingId: binding.id,
        sessionsRevoked,
      };
    });

    return this.#sign(result.application, {
      unbound: true,
      code: 'DEVICE_UNBOUND',
      appId,
      licenseId: result.licenseId,
      bindingId: result.bindingId,
      sessionsRevoked: result.sessionsRevoked,
      issuedAt: now,
      requestNonce: input.nonce,
    });
  }

  /**
   * 构造随授权信封一起签名下发的版本策略与公告。
   *
   * 花落 / MIT：这两块内容搭现有签名载荷的车，因此自动继承 requestNonce 防重放、
   * 程序独立 Ed25519 签名和 native 强制验签，不新增任何未签名的下发通道。
   * 全部可选字段显式归一为 null——canonicalJson 遇到 undefined 会抛错，
   * 历史应用没有这些键，不归一就会让所有心跳验签失败。
   */
  async #clientContext(application, nowMilliseconds) {
    const minVersionCode = Number.isSafeInteger(application.minVersionCode)
      ? application.minVersionCode
      : null;
    const latestVersionCode = Number.isSafeInteger(application.latestVersionCode)
      ? application.latestVersionCode
      : null;
    return {
      clientPolicy: {
        minVersionCode,
        latestVersionCode,
        latestVersionName: application.latestVersionName ?? null,
        releaseNotes: application.releaseNotes ?? null,
      },
      announcements: await this.#publishableAnnouncements(application.id, nowMilliseconds),
    };
  }

  async #publishableAnnouncements(appId, nowMilliseconds) {
    if (!this.announcements) return [];
    try {
      // 通道 A 只服务已激活客户端的软件内界面，因此只取 placement 命中 app 的公告。
      // 卡密验证页专属公告（placement=gate）不进这条载荷。
      return await this.announcements.listPublishable(appId, nowMilliseconds, 'app');
    } catch {
      // 公告是纯展示信息，读取失败绝不能连带拖垮授权验证。
      return [];
    }
  }

  async #getActiveApplication(appId) {
    if (this.store.repositories?.verification) return this.store.repositories.verification.getActiveApplication(appId);
    return this.store.read((state) => {
      const application = findApplicationOrThrow(state, appId, { requireActive: true });
      findMerchantOrThrow(state, application.merchantId, { requireActive: true });
      return application;
    });
  }

  #sign(application, payload) {
    const privateKey = decryptText(
      this.rootSecret,
      `app-signing:${application.id}`,
      application.signingPrivateKeyEncrypted,
    );
    return createSignedEnvelope(payload, privateKey, application.signingKeyId);
  }
}
