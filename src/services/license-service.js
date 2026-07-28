import { randomUUID } from 'node:crypto';
import { AppError } from '../core/app-error.js';
import {
  optionalInteger,
  optionalString,
  requireEnum,
  requireFutureIsoDate,
  requireInteger,
  requireString,
} from '../core/validation.js';
import {
  decryptText,
  digestSecret,
  encryptText,
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

function normalizeBulkLicenseIds(input) {
  if (!Array.isArray(input)) {
    throw new AppError('INVALID_INPUT', 'licenseIds must be an array', 400);
  }
  if (input.length < 1 || input.length > 100) {
    throw new AppError('INVALID_INPUT', 'licenseIds length must be between 1 and 100', 400);
  }
  return [...new Set(input.map((item) => requireString(item, 'licenseId', { min: 1, max: 80 })))];
}

function requireObjectLike(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_INPUT', 'body must be an object', 400);
  }
  return value;
}

function bulkFailure(licenseId, error) {
  return {
    licenseId,
    code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
    message: error instanceof AppError ? error.message : 'An internal server error occurred',
  };
}

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

    if (this.store.repositories?.licenses) {
      const result = await this.store.repositories.licenses.generate(actor, appId, (application) => {
        const durationDays = fixedExpiresAt
          ? null
          : optionalInteger(input.durationDays, 'durationDays', { min: 1, max: 3650 })
            ?? application.settings.defaultDurationDays;
        const maxDevices = optionalInteger(input.maxDevices, 'maxDevices', { min: 0, max: 20 })
          ?? application.settings.defaultMaxDevices;
        const generated = Array.from({ length: count }, () => {
          const id = randomUUID();
          const key = generateLicenseKey(application.code);
          return {
            id,
            key,
            keyDigest: digestSecret(this.rootSecret, 'license-key', normalizeLicenseKey(key)),
            keyEncrypted: encryptText(this.rootSecret, `license-key:${id}`, key),
            keyPreview: previewLicenseKey(key),
          };
        });
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
        const licenses = generated.map((item) => ({
          id: item.id,
          merchantId: application.merchantId,
          appId,
          batchId: batch.id,
          keyDigest: item.keyDigest,
          keyEncrypted: item.keyEncrypted,
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
        return { batch, licenses, generated };
      });
      return {
        batch: result.batch,
        licenses: result.licenses.map((license, index) => ({
          ...presentLicense(license),
          key: result.generated[index].key,
        })),
        plaintextNotice: 'License keys can later be explicitly revealed by an authorized owner.',
      };
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
      const id = randomUUID();
      const key = generateLicenseKey(appSnapshot.code);
      return {
        id,
        key,
        keyDigest: digestSecret(this.rootSecret, 'license-key', normalizeLicenseKey(key)),
        keyEncrypted: encryptText(this.rootSecret, `license-key:${id}`, key),
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
        keyEncrypted: item.keyEncrypted,
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
        plaintextNotice: 'License keys can later be explicitly revealed by an authorized owner.',
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

    if (this.store.repositories?.licenses) {
      const result = await this.store.repositories.licenses.list(actor, appId, pagination, { status: normalizedStatus, keyDigest: exactDigest });
      return { ...result, items: result.items.map((license) => effectiveLicense(license)) };
    }

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
    if (this.store.repositories?.licenses) {
      return effectiveLicense(await this.store.repositories.licenses.setStatus(actor, licenseId, status));
    }
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

  // Author: 花落. Encrypted license-key recovery is provided under the MIT License.
  async revealKey(actor, licenseId) {
    if (this.store.repositories?.licenses) {
      return this.store.repositories.licenses.reveal(
        actor,
        licenseId,
        (license, order) => this.#decryptLicenseKey(license, order),
      );
    }
    return this.store.transaction((state) => {
      const license = findLicenseOrThrow(state, licenseId);
      assertMerchantAccess(actor, license.merchantId);
      const order = state.orders.find((item) => item.licenseId === licenseId) || null;
      const key = this.#decryptLicenseKey(license, order);
      AuditService.append(state, {
        actor,
        merchantId: license.merchantId,
        action: 'license.key.reveal',
        resourceType: 'license',
        resourceId: license.id,
        metadata: { appId: license.appId },
      });
      return { licenseId, key };
    });
  }

  async delete(actor, licenseId) {
    if (this.store.repositories?.licenses) return this.store.repositories.licenses.delete(actor, licenseId);
    return this.store.transaction((state) => {
      const license = findLicenseOrThrow(state, licenseId);
      assertMerchantAccess(actor, license.merchantId);
      if (state.orders.some((order) => order.licenseId === licenseId)) {
        throw new AppError('LICENSE_HAS_ORDER', 'A fulfilled store order keeps this license for delivery history', 409);
      }
      const deletedBindings = state.deviceBindings.filter((binding) => binding.licenseId === licenseId).length;
      state.clientSessions = state.clientSessions.filter((session) => session.licenseId !== licenseId);
      state.verificationLogs = state.verificationLogs.filter((entry) => entry.licenseId !== licenseId);
      // Author: 花落. License removal also removes its model leases under the MIT License.
      state.modelLeases = state.modelLeases.filter((lease) => lease.licenseId !== licenseId);
      state.deviceBindings = state.deviceBindings.filter((binding) => binding.licenseId !== licenseId);
      state.licenses = state.licenses.filter((item) => item.id !== licenseId);
      AuditService.append(state, {
        actor,
        merchantId: license.merchantId,
        action: 'license.delete',
        resourceType: 'license',
        resourceId: license.id,
        metadata: { appId: license.appId, deletedBindings },
      });
      return { licenseId, deletedBindings };
    });
  }

  // Author: 花落. Batch license deletion keeps per-license safety checks under the MIT License.
  async bulkDelete(actor, appId, input) {
    const licenseIds = normalizeBulkLicenseIds(requireObjectLike(input).licenseIds);
    if (this.store.repositories?.licenses) {
      return this.store.repositories.licenses.bulkDelete(actor, appId, licenseIds);
    }

    const results = [];
    const failed = [];
    for (const licenseId of licenseIds) {
      try {
        await this.store.read((state) => {
          const application = findApplicationOrThrow(state, appId);
          assertMerchantAccess(actor, application.merchantId);
          const license = findLicenseOrThrow(state, licenseId);
          if (license.appId !== appId) {
            throw new AppError('LICENSE_APP_MISMATCH', 'License does not belong to the selected application', 400);
          }
          return true;
        });
        results.push(await this.delete(actor, licenseId));
      } catch (error) {
        failed.push(bulkFailure(licenseId, error));
      }
    }
    return {
      requestedCount: licenseIds.length,
      deletedCount: results.length,
      deletedBindings: results.reduce((sum, item) => sum + Number(item.deletedBindings || 0), 0),
      deleted: results.map((item) => ({ licenseId: item.licenseId, deletedBindings: item.deletedBindings })),
      failed,
    };
  }

  async listBatches(actor, appId, pagination) {
    if (this.store.repositories?.licenses) return this.store.repositories.licenses.listBatches(actor, appId, pagination);
    return this.store.read((state) => {
      const application = findApplicationOrThrow(state, appId);
      assertMerchantAccess(actor, application.merchantId);
      const all = state.licenseBatches.filter((batch) => batch.appId === appId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return { items: all.slice(pagination.offset, pagination.offset + pagination.limit), page: pagination.page, limit: pagination.limit, total: all.length };
    });
  }

  async listDevices(actor, licenseId) {
    if (this.store.repositories?.licenses) return (await this.store.repositories.licenses.listDevices(actor, licenseId)).map(presentDeviceBinding);
    return this.store.read((state) => {
      const license = findLicenseOrThrow(state, licenseId);
      assertMerchantAccess(actor, license.merchantId);
      return state.deviceBindings
        .filter((binding) => binding.licenseId === licenseId)
        .map(presentDeviceBinding);
    });
  }

  async unbindDevice(actor, bindingId) {
    if (this.store.repositories?.licenses) return presentDeviceBinding(await this.store.repositories.licenses.unbind(actor, bindingId));
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

  // Author: 花落. Bulk device revocation is provided under the MIT License.
  async unbindAllDevices(actor, licenseId) {
    if (this.store.repositories?.licenses) return this.store.repositories.licenses.unbindAll(actor, licenseId);
    return this.store.transaction((state) => {
      const license = findLicenseOrThrow(state, licenseId);
      assertMerchantAccess(actor, license.merchantId);
      const now = new Date().toISOString();
      const activeBindings = state.deviceBindings.filter(
        (binding) => binding.licenseId === licenseId && binding.status === 'active',
      );
      for (const binding of activeBindings) {
        binding.status = 'revoked';
        binding.revokedAt = now;
        binding.updatedAt = now;
      }
      state.clientSessions = state.clientSessions.filter((session) => session.licenseId !== licenseId);
      if (activeBindings.length > 0) {
        AuditService.append(state, {
          actor,
          merchantId: license.merchantId,
          action: 'license.devices.unbind_all',
          resourceType: 'license',
          resourceId: license.id,
          metadata: { appId: license.appId, unboundCount: activeBindings.length },
        });
      }
      return { licenseId, unboundCount: activeBindings.length };
    });
  }

  #decryptLicenseKey(license, order = null) {
    const key = license.keyEncrypted
      ? decryptText(this.rootSecret, `license-key:${license.id}`, license.keyEncrypted)
      : order?.licenseKeyEncrypted
        ? decryptText(this.rootSecret, `order-license:${order.id}`, order.licenseKeyEncrypted)
        : null;
    if (!key) {
      throw new AppError('LICENSE_KEY_UNAVAILABLE', 'This legacy license does not have a recoverable encrypted key', 409);
    }
    const digest = digestSecret(this.rootSecret, 'license-key', normalizeLicenseKey(key));
    if (digest !== license.keyDigest) {
      throw new AppError('LICENSE_KEY_CORRUPTED', 'Stored license key cannot be verified', 500);
    }
    return key;
  }
}
