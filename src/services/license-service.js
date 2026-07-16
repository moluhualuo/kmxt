import { randomUUID } from 'node:crypto';
import { AppError } from '../core/app-error.js';
import {
  optionalInteger,
  optionalString,
  requireEnum,
  requireFutureIsoDate,
  requireInteger,
} from '../core/validation.js';
import {
  digestSecret,
  generateLicenseKey,
  normalizeLicenseKey,
  previewLicenseKey,
} from '../security/crypto.js';
import {
  assertMerchantAccess,
  findApplicationOrThrow,
  findBindingOrThrow,
  findLicenseOrThrow,
  findMerchantOrThrow,
} from './access-control.js';
import { AuditService } from './audit-service.js';
import { presentDeviceBinding, presentLicense } from './presenters.js';

function effectiveLicense(license, now = Date.now()) {
  const presented = presentLicense(license);
  if (presented.status !== 'disabled' && presented.expiresAt && Date.parse(presented.expiresAt) <= now) {
    presented.status = 'expired';
  }
  return presented;
}

export class LicenseService {
  constructor(store, rootSecret, config) {
    this.store = store;
    this.rootSecret = rootSecret;
    this.config = config;
  }

  async generate(actor, appId, input) {
    const count = requireInteger(input.count ?? 1, 'count', { min: 1, max: this.config.maxLicenseBatch });
    const batchName = optionalString(input.batchName, 'batchName', { min: 1, max: 100 });
    const fixedExpiresAt = input.fixedExpiresAt
      ? requireFutureIsoDate(input.fixedExpiresAt, 'fixedExpiresAt')
      : null;
    if (fixedExpiresAt && input.durationDays !== undefined && input.durationDays !== null) {
      throw new AppError('INVALID_INPUT', 'durationDays and fixedExpiresAt cannot be used together', 400);
    }

    const appSnapshot = await this.store.read((state) => {
      const application = findApplicationOrThrow(state, appId, { requireActive: true });
      assertMerchantAccess(actor, application.merchantId);
      findMerchantOrThrow(state, application.merchantId, { requireActive: true });
      return application;
    });
    const durationDays = fixedExpiresAt
      ? null
      : optionalInteger(input.durationDays, 'durationDays', { min: 1, max: 3650 })
        ?? appSnapshot.settings.defaultDurationDays;
    const maxDevices = optionalInteger(input.maxDevices, 'maxDevices', { min: 0, max: 20 })
      ?? appSnapshot.settings.defaultMaxDevices;

    const generated = Array.from({ length: count }, () => {
      const key = generateLicenseKey(appSnapshot.code);
      return {
        id: randomUUID(),
        key,
        keyDigest: digestSecret(this.rootSecret, 'license-key', normalizeLicenseKey(key)),
        keyPreview: previewLicenseKey(key),
      };
    });

    return this.store.transaction((state) => {
      const application = findApplicationOrThrow(state, appId, { requireActive: true });
      assertMerchantAccess(actor, application.merchantId);
      findMerchantOrThrow(state, application.merchantId, { requireActive: true });
      const existingDigests = new Set(state.licenses.map((license) => license.keyDigest));
      if (generated.some((item) => existingDigests.has(item.keyDigest))) {
        throw new AppError('LICENSE_COLLISION', 'Generated license collision; retry the request', 409);
      }

      const now = new Date().toISOString();
      const batch = {
        id: randomUUID(),
        merchantId: application.merchantId,
        appId,
        name: batchName || `Batch ${now}`,
        count,
        durationDays,
        fixedExpiresAt,
        maxDevices,
        createdBy: actor.id,
        createdAt: now,
      };
      state.licenseBatches.push(batch);

      const licenses = generated.map((item) => ({
        id: item.id,
        merchantId: application.merchantId,
        appId,
        batchId: batch.id,
        keyDigest: item.keyDigest,
        keyPreview: item.keyPreview,
        status: 'pending',
        durationDays,
        fixedExpiresAt,
        activatedAt: null,
        expiresAt: fixedExpiresAt,
        maxDevices,
        createdAt: now,
        updatedAt: now,
      }));
      state.licenses.push(...licenses);
      AuditService.append(state, {
        actor,
        merchantId: application.merchantId,
        action: 'license_batch.create',
        resourceType: 'license_batch',
        resourceId: batch.id,
        metadata: { appId, count, durationDays, fixedExpiresAt, maxDevices },
      });

      return {
        batch,
        licenses: licenses.map((license, index) => ({
          ...presentLicense(license),
          key: generated[index].key,
        })),
        plaintextNotice: 'License keys are returned only by this generation response.',
      };
    });
  }

  async list(actor, appId, pagination, filters = {}) {
    const normalizedStatus = filters.status
      ? requireEnum(filters.status, 'status', ['pending', 'active', 'disabled', 'expired'])
      : null;
    const exactDigest = filters.key
      ? digestSecret(this.rootSecret, 'license-key', normalizeLicenseKey(filters.key))
      : null;

    return this.store.read((state) => {
      const application = findApplicationOrThrow(state, appId);
      assertMerchantAccess(actor, application.merchantId);
      let all = state.licenses
        .filter((license) => license.appId === appId)
        .map((license) => effectiveLicense(license))
        .filter((license) => !normalizedStatus || license.status === normalizedStatus)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      if (exactDigest) {
        const matchingIds = new Set(
          state.licenses.filter((license) => license.keyDigest === exactDigest).map((license) => license.id),
        );
        all = all.filter((license) => matchingIds.has(license.id));
      }
      return {
        items: all.slice(pagination.offset, pagination.offset + pagination.limit),
        page: pagination.page,
        limit: pagination.limit,
        total: all.length,
      };
    });
  }

  async setStatus(actor, licenseId, requestedStatus) {
    const status = requireEnum(requestedStatus, 'status', ['active', 'disabled']);
    return this.store.transaction((state) => {
      const license = findLicenseOrThrow(state, licenseId);
      assertMerchantAccess(actor, license.merchantId);
      findMerchantOrThrow(state, license.merchantId, { requireActive: true });
      findApplicationOrThrow(state, license.appId);
      if (status === 'active' && license.expiresAt && Date.parse(license.expiresAt) <= Date.now()) {
        throw new AppError('LICENSE_EXPIRED', 'An expired license cannot be enabled', 409);
      }
      license.status = status === 'disabled' ? 'disabled' : license.activatedAt ? 'active' : 'pending';
      license.updatedAt = new Date().toISOString();
      if (status === 'disabled') {
        state.clientSessions = state.clientSessions.filter((session) => session.licenseId !== licenseId);
      }
      AuditService.append(state, {
        actor,
        merchantId: license.merchantId,
        action: 'license.status.update',
        resourceType: 'license',
        resourceId: license.id,
        metadata: { status: license.status },
      });
      return effectiveLicense(license);
    });
  }

  async listDevices(actor, licenseId) {
    return this.store.read((state) => {
      const license = findLicenseOrThrow(state, licenseId);
      assertMerchantAccess(actor, license.merchantId);
      return state.deviceBindings
        .filter((binding) => binding.licenseId === licenseId)
        .map(presentDeviceBinding);
    });
  }

  async unbindDevice(actor, bindingId) {
    return this.store.transaction((state) => {
      const binding = findBindingOrThrow(state, bindingId);
      assertMerchantAccess(actor, binding.merchantId);
      if (binding.status === 'revoked') {
        return presentDeviceBinding(binding);
      }
      const now = new Date().toISOString();
      binding.status = 'revoked';
      binding.revokedAt = now;
      binding.updatedAt = now;
      state.clientSessions = state.clientSessions.filter((session) => session.bindingId !== bindingId);
      AuditService.append(state, {
        actor,
        merchantId: binding.merchantId,
        action: 'device.unbind',
        resourceType: 'device_binding',
        resourceId: binding.id,
        metadata: { appId: binding.appId, licenseId: binding.licenseId },
      });
      return presentDeviceBinding(binding);
    });
  }
}
