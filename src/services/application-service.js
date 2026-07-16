import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../core/app-error.js';
import {
  optionalString,
  requireEnum,
  requireInteger,
  requireString,
} from '../core/validation.js';
import { encryptText, generateSigningKeyPair } from '../security/crypto.js';
import {
  assertMerchantAccess,
  assertRole,
  findApplicationOrThrow,
  findMerchantOrThrow,
  Roles,
} from './access-control.js';
import { AuditService } from './audit-service.js';
import { presentApplication } from './presenters.js';

const APP_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

function readSettings(input, defaults = {}) {
  return {
    defaultDurationDays: requireInteger(
      input.defaultDurationDays ?? defaults.defaultDurationDays ?? 30,
      'settings.defaultDurationDays',
      { min: 1, max: 3650 },
    ),
    defaultMaxDevices: requireInteger(
      input.defaultMaxDevices ?? defaults.defaultMaxDevices ?? 1,
      'settings.defaultMaxDevices',
      { min: 0, max: 20 },
    ),
    heartbeatSeconds: requireInteger(
      input.heartbeatSeconds ?? defaults.heartbeatSeconds ?? 300,
      'settings.heartbeatSeconds',
      { min: 30, max: 86400 },
    ),
    offlineGraceSeconds: requireInteger(
      input.offlineGraceSeconds ?? defaults.offlineGraceSeconds ?? 900,
      'settings.offlineGraceSeconds',
      { min: 60, max: 604800 },
    ),
  };
}

export class ApplicationService {
  constructor(store, rootSecret, config) {
    this.store = store;
    this.rootSecret = rootSecret;
    this.config = config;
  }

  async create(actor, merchantId, input) {
    assertRole(actor, [Roles.PLATFORM_ADMIN, Roles.MERCHANT_ADMIN]);
    assertMerchantAccess(actor, merchantId);
    const code = requireString(input.code, 'code', {
      min: 2,
      max: 32,
      pattern: APP_CODE_PATTERN,
    }).toUpperCase();
    const name = requireString(input.name, 'name', { min: 2, max: 100 });
    const description = optionalString(input.description, 'description', { min: 1, max: 500 });
    const settings = readSettings(input.settings || {}, {
      heartbeatSeconds: this.config.heartbeatSeconds,
    });
    const appId = randomUUID();
    const keyPair = generateSigningKeyPair();
    const signingKeyId = createHash('sha256').update(keyPair.publicKey).digest('hex').slice(0, 16);
    const encryptedPrivateKey = encryptText(this.rootSecret, `app-signing:${appId}`, keyPair.privateKey);

    return this.store.transaction((state) => {
      findMerchantOrThrow(state, merchantId, { requireActive: true });
      if (state.applications.some((app) => app.merchantId === merchantId && app.code === code)) {
        throw new AppError('APPLICATION_CODE_EXISTS', 'Application code already exists for this merchant', 409);
      }
      const now = new Date().toISOString();
      const application = {
        id: appId,
        merchantId,
        code,
        name,
        description,
        status: 'active',
        settings,
        signingKeyId,
        signingPublicKey: keyPair.publicKey,
        signingPrivateKeyEncrypted: encryptedPrivateKey,
        createdAt: now,
        updatedAt: now,
      };
      state.applications.push(application);
      AuditService.append(state, {
        actor,
        merchantId,
        action: 'application.create',
        resourceType: 'application',
        resourceId: application.id,
        metadata: { code },
      });
      return presentApplication(application);
    });
  }

  async list(actor, merchantId) {
    assertMerchantAccess(actor, merchantId);
    return this.store.read((state) => {
      findMerchantOrThrow(state, merchantId);
      return state.applications
        .filter((application) => application.merchantId === merchantId)
        .map(presentApplication);
    });
  }

  async get(actor, appId) {
    return this.store.read((state) => {
      const application = findApplicationOrThrow(state, appId);
      assertMerchantAccess(actor, application.merchantId);
      return presentApplication(application);
    });
  }

  async setStatus(actor, appId, status) {
    assertRole(actor, [Roles.PLATFORM_ADMIN, Roles.MERCHANT_ADMIN]);
    const nextStatus = requireEnum(status, 'status', ['active', 'disabled']);
    return this.store.transaction((state) => {
      const application = findApplicationOrThrow(state, appId);
      assertMerchantAccess(actor, application.merchantId);
      findMerchantOrThrow(state, application.merchantId, { requireActive: true });
      application.status = nextStatus;
      application.updatedAt = new Date().toISOString();
      if (nextStatus === 'disabled') {
        state.clientSessions = state.clientSessions.filter((session) => session.appId !== appId);
      }
      AuditService.append(state, {
        actor,
        merchantId: application.merchantId,
        action: 'application.status.update',
        resourceType: 'application',
        resourceId: appId,
        metadata: { status: nextStatus },
      });
      return presentApplication(application);
    });
  }

  async getPublicConfig(appId) {
    return this.store.read((state) => {
      const application = findApplicationOrThrow(state, appId, { requireActive: true });
      findMerchantOrThrow(state, application.merchantId, { requireActive: true });
      return {
        appId: application.id,
        code: application.code,
        name: application.name,
        heartbeatSeconds: application.settings.heartbeatSeconds,
        offlineGraceSeconds: application.settings.offlineGraceSeconds,
        signing: {
          algorithm: 'Ed25519',
          keyId: application.signingKeyId,
          publicKey: application.signingPublicKey,
        },
      };
    });
  }

  async getClientConfig(actor, appId) {
    return this.store.read((state) => {
      const application = findApplicationOrThrow(state, appId);
      assertMerchantAccess(actor, application.merchantId);
      const config = {
        protocolVersion: this.config.protocolVersion,
        baseUrl: this.config.publicBaseUrl,
        appId: application.id,
        keyId: application.signingKeyId,
        publicKey: application.signingPublicKey,
      };
      const cppHeader = `#pragma once\n// Generated by KMXT. Author: 花落. MIT License.\nnamespace kmxt::config {\ninline constexpr int protocol_version = ${config.protocolVersion};\ninline constexpr char base_url[] = R\"KMXT(${config.baseUrl})KMXT\";\ninline constexpr char app_id[] = R\"KMXT(${config.appId})KMXT\";\ninline constexpr char key_id[] = R\"KMXT(${config.keyId})KMXT\";\ninline constexpr char ed25519_public_key[] = R\"KMXT(${config.publicKey})KMXT\";\n}\n`;
      return { config, cppHeader };
    });
  }
}
