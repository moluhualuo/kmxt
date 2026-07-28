import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../core/app-error.js';
import {
  optionalString,
  requireEnum,
  requireInteger,
  requireObject,
  requireString,
} from '../core/validation.js';
import {
  createSignedEnvelope,
  decryptText,
  digestSecret,
  encodeBase64Url,
  encryptText,
  wrapSecretForClient,
} from '../security/crypto.js';
import {
  assertMerchantAccess,
  assertRole,
  findApplicationOrThrow,
  findLicenseOrThrow,
  findMerchantOrThrow,
  Roles,
} from './access-control.js';
import { AuditService } from './audit-service.js';

const ARTIFACT_FORMATS = ['onnx', 'ncnn-param', 'ncnn-bin', 'tflite', 'dlc', 'bundle'];
const ARTIFACT_STATUSES = ['draft', 'active', 'revoked'];
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const MIN_CHUNK_SIZE_BYTES = 64 * 1024;
const MAX_CHUNK_SIZE_BYTES = 64 * 1024 * 1024;
const ADMIN_ROLES = [Roles.PLATFORM_ADMIN, Roles.MERCHANT_ADMIN, Roles.OPERATOR];
const OWNER_ROLES = [Roles.PLATFORM_ADMIN, Roles.MERCHANT_ADMIN];

function decodeKey(value) {
  const encoded = requireString(value, 'contentKey', { min: 43, max: 64, normalize: false });
  if (!BASE64URL.test(encoded)) {
    throw new AppError('INVALID_INPUT', 'contentKey must be base64url encoded', 400);
  }
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32) {
    throw new AppError('INVALID_INPUT', 'contentKey must contain exactly 32 bytes', 400);
  }
  return key;
}

function requireCanonicalBase64UrlBytes(value, field, expectedBytes) {
  const encoded = requireString(value, field, { min: 1, max: 128, normalize: false });
  if (!BASE64URL.test(encoded)) {
    throw new AppError('INVALID_INPUT', `${field} must be canonical base64url`, 400);
  }
  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.length !== expectedBytes || decoded.toString('base64url') !== encoded) {
    throw new AppError(
      'INVALID_INPUT',
      `${field} must encode exactly ${expectedBytes} bytes as canonical base64url`,
      400,
    );
  }
  return encoded;
}

function validateEncryption(input = {}) {
  const encryption = requireObject(input, 'encryption');
  const algorithm = encryption.algorithm === undefined
    ? 'AES-256-GCM'
    : requireString(encryption.algorithm, 'encryption.algorithm', { min: 8, max: 32 });
  if (algorithm !== 'AES-256-GCM') {
    throw new AppError('INVALID_INPUT', 'Only AES-256-GCM artifact encryption is supported', 400);
  }
  const nonce = requireCanonicalBase64UrlBytes(
    encryption.nonce,
    'encryption.nonce',
    AES_GCM_NONCE_BYTES,
  );
  const tag = requireCanonicalBase64UrlBytes(
    encryption.tag,
    'encryption.tag',
    AES_GCM_TAG_BYTES,
  );
  const chunkSize = encryption.chunkSize === undefined || encryption.chunkSize === null
    ? null
    : requireInteger(encryption.chunkSize, 'encryption.chunkSize', {
      min: MIN_CHUNK_SIZE_BYTES,
      max: MAX_CHUNK_SIZE_BYTES,
    });
  return { algorithm, nonce, tag, chunkSize };
}

// Author: 花落. Lease expiry checks fail closed under the MIT License.
function requireLeaseLicenseExpiry(license, nowMilliseconds) {
  if (license.status === 'disabled') {
    throw new AppError('LICENSE_DISABLED', 'License is disabled', 403);
  }
  if (license.status === 'expired') {
    throw new AppError('LICENSE_EXPIRED', 'License has expired', 403);
  }
  if (license.expiresAt === null || license.expiresAt === undefined) return null;
  const expiresAt = Date.parse(license.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMilliseconds) {
    throw new AppError('LICENSE_EXPIRED', 'License has expired', 403);
  }
  return expiresAt;
}

function presentArtifact(artifact) {
  return {
    id: artifact.id,
    appId: artifact.appId,
    name: artifact.name,
    version: artifact.version,
    format: artifact.format,
    edition: artifact.edition,
    status: artifact.status,
    cipherSha256: artifact.cipherSha256,
    size: artifact.size,
    encryption: artifact.encryption,
    keyVersion: artifact.keyVersion,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function presentLease(lease) {
  return {
    leaseId: lease.id,
    jti: lease.jti,
    artifactId: lease.artifactId,
    bindingId: lease.bindingId,
    clientKeyFingerprint: lease.clientKeyFingerprint,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
  };
}

// Author: 花落. Model artifact registration and device-bound leases are MIT licensed.
export class ModelDeliveryService {
  constructor(store, rootSecret, config, verification) {
    this.store = store;
    this.rootSecret = rootSecret;
    this.config = config;
    this.verification = verification;
  }

  async register(actor, appId, input) {
    assertRole(actor, OWNER_ROLES);
    const payload = requireObject(input);
    const name = requireString(payload.name, 'name', { min: 1, max: 128 });
    const version = requireString(payload.version, 'version', { min: 1, max: 64 });
    const format = requireEnum(payload.format, 'format', ARTIFACT_FORMATS);
    const edition = optionalString(payload.edition, 'edition', { min: 1, max: 32 });
    const cipherSha256 = requireString(payload.cipherSha256, 'cipherSha256', {
      min: 64,
      max: 64,
      pattern: HEX_SHA256,
    }).toLowerCase();
    const size = requireInteger(payload.size, 'size', { min: 1, max: this.config.modelArtifactMaxBytes });
    // 花落/MIT: 服务端不托管模型密文，密文 .vmp 随 APK 打包在本地 assets；
    // 运行期仅凭 DEK + cipherSha256 校验本地 .vmp，不存在服务端对象地址。
    const encryption = validateEncryption(payload.encryption);
    const keyVersion = requireInteger(payload.keyVersion ?? 1, 'keyVersion', { min: 1, max: 1000000 });
    const contentKey = decodeKey(payload.contentKey);
    const now = new Date().toISOString();
    const artifactId = randomUUID();
    const createArtifact = (application) => ({
      id: artifactId,
      merchantId: application.merchantId,
      appId,
      name,
      version,
      format,
      edition,
      status: 'draft',
      cipherSha256,
      size,
      encryption,
      keyVersion,
      encryptedDek: encryptArtifactKey(this.rootSecret, artifactId, contentKey),
      createdAt: now,
      updatedAt: now,
    });
    try {
      if (this.store.repositories?.modelDelivery) {
        return presentArtifact(await this.store.repositories.modelDelivery.register(
          actor,
          appId,
          createArtifact,
        ));
      }
      return await this.store.transaction((state) => {
        const application = findApplicationOrThrow(state, appId, { requireActive: true });
        assertMerchantAccess(actor, application.merchantId);
        findMerchantOrThrow(state, application.merchantId, { requireActive: true });
        const duplicate = state.modelArtifacts.find((item) => item.appId === appId
          && item.name === name && item.version === version);
        if (duplicate) throw new AppError('ARTIFACT_EXISTS', 'Artifact name and version already exist', 409);
        const artifact = createArtifact(application);
        state.modelArtifacts.push(artifact);
        AuditService.append(state, {
          actor,
          merchantId: application.merchantId,
          action: 'model-artifact.register',
          resourceType: 'model_artifact',
          resourceId: artifactId,
          metadata: { appId, name, version, format, cipherSha256, size },
        });
        return presentArtifact(artifact);
      });
    } finally {
      contentKey.fill(0);
    }
  }

  async list(actor, appId) {
    assertRole(actor, ADMIN_ROLES);
    if (this.store.repositories?.modelDelivery) {
      return (await this.store.repositories.modelDelivery.list(actor, appId)).map(presentArtifact);
    }
    return this.store.read((state) => {
      const application = findApplicationOrThrow(state, appId);
      assertMerchantAccess(actor, application.merchantId);
      return state.modelArtifacts
        .filter((item) => item.appId === appId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(presentArtifact);
    });
  }

  async setStatus(actor, artifactId, status) {
    assertRole(actor, OWNER_ROLES);
    const nextStatus = requireEnum(status, 'status', ARTIFACT_STATUSES);
    if (this.store.repositories?.modelDelivery) {
      return presentArtifact(await this.store.repositories.modelDelivery.setStatus(
        actor,
        artifactId,
        nextStatus,
      ));
    }
    return this.store.transaction((state) => {
      const artifact = state.modelArtifacts.find((item) => item.id === artifactId);
      if (!artifact) throw new AppError('ARTIFACT_NOT_FOUND', 'Model artifact was not found', 404);
      assertMerchantAccess(actor, artifact.merchantId);
      const application = findApplicationOrThrow(state, artifact.appId);
      findMerchantOrThrow(state, artifact.merchantId, { requireActive: true });
      if (artifact.status === 'revoked') {
        if (nextStatus === 'revoked') return presentArtifact(artifact);
        throw new AppError('ARTIFACT_REVOKED', 'A revoked model artifact cannot be restored', 409);
      }
      artifact.status = nextStatus;
      artifact.updatedAt = new Date().toISOString();
      if (nextStatus === 'revoked') {
        for (const lease of state.modelLeases) {
          if (lease.artifactId === artifact.id && lease.status === 'active') {
            lease.status = 'revoked';
            lease.updatedAt = artifact.updatedAt;
          }
        }
      }
      AuditService.append(state, {
        actor,
        merchantId: artifact.merchantId,
        action: 'model-artifact.status',
        resourceType: 'model_artifact',
        resourceId: artifact.id,
        metadata: { appId: application.id, status: nextStatus },
      });
      return presentArtifact(artifact);
    });
  }

  async delete(actor, artifactId) {
    assertRole(actor, OWNER_ROLES);
    if (this.store.repositories?.modelDelivery) {
      return await this.store.repositories.modelDelivery.delete(actor, artifactId);
    }
    return this.store.transaction((state) => {
      const artifact = state.modelArtifacts.find((item) => item.id === artifactId);
      if (!artifact) throw new AppError('ARTIFACT_NOT_FOUND', 'Model artifact was not found', 404);
      assertMerchantAccess(actor, artifact.merchantId);
      findApplicationOrThrow(state, artifact.appId);
      findMerchantOrThrow(state, artifact.merchantId, { requireActive: true });
      if (artifact.status !== 'draft' && artifact.status !== 'revoked') {
        throw new AppError('ARTIFACT_ACTIVE', 'Only draft or revoked artifacts can be deleted', 409);
      }
      const leaseCount = state.modelLeases.filter((lease) => lease.artifactId === artifactId).length;
      state.modelArtifacts = state.modelArtifacts.filter((item) => item.id !== artifactId);
      state.modelLeases = state.modelLeases.filter((lease) => lease.artifactId !== artifactId);
      AuditService.append(state, {
        actor,
        merchantId: artifact.merchantId,
        action: 'model-artifact.delete',
        resourceType: 'model_artifact',
        resourceId: artifact.id,
        metadata: { appId: artifact.appId, name: artifact.name, version: artifact.version, deletedLeases: leaseCount },
      });
      return { deletedLeases: leaseCount };
    });
  }

  async issueLease(input) {
    const payload = requireObject(input);
    const appId = requireString(payload.appId, 'appId', { min: 36, max: 36 });
    const artifactId = requireString(payload.artifactId, 'artifactId', { min: 36, max: 36 });
    const sessionToken = requireString(payload.sessionToken, 'sessionToken', { min: 32, max: 128, normalize: false });
    const deviceId = requireString(payload.deviceId, 'deviceId', { min: 8, max: 256, normalize: false });
    const clientPublicKey = requireString(payload.clientPublicKey, 'clientPublicKey', { min: 40, max: 512, normalize: false });
    if (!BASE64URL.test(clientPublicKey)) {
      throw new AppError('INVALID_CLIENT_KEY', 'clientPublicKey must be base64url encoded', 400);
    }
    const clientVersion = optionalString(payload.clientVersion, 'clientVersion', { min: 1, max: 50 });

    // Reuse the signed, device-bound verification transaction before releasing any model key.
    // WS4 花落/MIT: 透传客户端完整性字段（packageName/certSha256/versionCode），
    // 使租约路径继承 verify() 的防重打包 / 签名绑定校验。
    const verified = await this.verification.verify({
      appId,
      sessionToken,
      deviceId,
      clientVersion,
      clientIp: payload.clientIp,
      timestamp: payload.timestamp,
      nonce: payload.nonce,
      packageName: payload.packageName,
      certSha256: payload.certSha256,
      versionCode: payload.versionCode,
    });
    const verifiedPayload = verified?.payload;
    if (!verifiedPayload?.licensed || verifiedPayload.appId !== appId) {
      throw new AppError('SERVER_REJECTED', 'Client session is not licensed', 403);
    }

    const clientKeyFingerprint = createHash('sha256').update(clientPublicKey, 'utf8').digest('hex');
    const leaseId = randomUUID();
    const nowMilliseconds = Date.now();
    const now = new Date(nowMilliseconds).toISOString();
    const sessionDigest = digestSecret(this.rootSecret, 'client-session', sessionToken);
    const deviceDigest = digestSecret(this.rootSecret, `device:${appId}`, deviceId);
    const prepareLease = ({ application, artifact, license, binding, session }) => {
      const licenseExpiry = requireLeaseLicenseExpiry(license, nowMilliseconds);
      const sessionExpiry = session ? Date.parse(session.expiresAt) : Number.NaN;
      if (!session || !Number.isFinite(sessionExpiry) || sessionExpiry <= nowMilliseconds) {
        throw new AppError('SESSION_EXPIRED', 'Verification session is invalid or expired', 401);
      }
      const expiresAt = new Date(Math.min(
        nowMilliseconds + this.config.modelLeaseTtlSeconds * 1000,
        Number.isFinite(licenseExpiry) ? licenseExpiry : nowMilliseconds + this.config.modelLeaseMaxTtlSeconds * 1000,
        Number.isFinite(sessionExpiry) ? sessionExpiry : nowMilliseconds + this.config.modelLeaseMaxTtlSeconds * 1000,
      )).toISOString();
      if (Date.parse(expiresAt) <= nowMilliseconds) {
        throw new AppError('SESSION_EXPIRED', 'Client session cannot issue a model lease', 401);
      }
      const associatedData = [
        appId,
        artifact.id,
        artifact.version,
        artifact.cipherSha256,
        binding.id,
        leaseId,
        payload.nonce,
      ].join('|');
      let secretBuffer;
      let wrapped;
      try {
        const secretText = decryptText(this.rootSecret, `artifact-dek:${artifact.id}`, artifact.encryptedDek);
        secretBuffer = Buffer.from(secretText, 'base64url');
        wrapped = wrapSecretForClient(secretBuffer, clientPublicKey, associatedData);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('ARTIFACT_KEY_UNAVAILABLE', 'Artifact key could not be prepared', 503);
      } finally {
        secretBuffer?.fill(0);
      }
      const lease = {
        id: leaseId,
        jti: leaseId,
        merchantId: application.merchantId,
        appId,
        artifactId: artifact.id,
        licenseId: license.id,
        bindingId: binding.id,
        clientKeyFingerprint,
        status: 'active',
        issuedAt: now,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      };
      return { lease, wrapped, associatedData };
    };

    let result;
    if (this.store.repositories?.modelDelivery) {
      result = await this.store.repositories.modelDelivery.issueLease({
        appId,
        artifactId,
        licenseId: verifiedPayload.licenseId,
        bindingId: verifiedPayload.bindingId,
        sessionDigest,
        deviceDigest,
        nowMilliseconds,
      }, prepareLease);
    } else {
      result = await this.store.transaction((state) => {
        const application = findApplicationOrThrow(state, appId, { requireActive: true });
        findMerchantOrThrow(state, application.merchantId, { requireActive: true });
        const artifact = state.modelArtifacts.find((item) => item.id === artifactId && item.appId === appId);
        if (!artifact) throw new AppError('ARTIFACT_NOT_FOUND', 'Model artifact was not found', 404);
        if (artifact.status !== 'active') throw new AppError('ARTIFACT_UNAVAILABLE', 'Model artifact is not active', 403);
        const license = findLicenseOrThrow(state, verifiedPayload.licenseId);
        if (license.appId !== appId) throw new AppError('LICENSE_INVALID', 'License belongs to another application', 401);
        const binding = state.deviceBindings.find((item) => item.id === verifiedPayload.bindingId
          && item.appId === appId && item.licenseId === license.id
          && item.status === 'active' && item.deviceDigest === deviceDigest);
        if (!binding) throw new AppError('DEVICE_MISMATCH', 'The verification device does not match the binding', 401);
        const session = state.clientSessions.find((item) => item.appId === appId
          && item.licenseId === license.id
          && item.bindingId === binding.id && item.tokenDigest === sessionDigest);
        const prepared = prepareLease({ application, artifact, license, binding, session });
        const { lease } = prepared;
        state.modelLeases.push(lease);
        AuditService.append(state, {
          actor: null,
          merchantId: application.merchantId,
          action: 'model-lease.issue',
          resourceType: 'model_lease',
          resourceId: lease.id,
          metadata: {
            appId,
            artifactId: artifact.id,
            licenseId: license.id,
            bindingId: binding.id,
            clientKeyFingerprint,
            expiresAt: lease.expiresAt,
          },
        });
        return { application, artifact, license, binding, session, ...prepared };
      });
    }

    return createSignedEnvelope({
      type: 'model_lease',
      protocolVersion: this.config.protocolVersion,
      appId,
      artifactId: result.artifact.id,
      name: result.artifact.name,
      version: result.artifact.version,
      format: result.artifact.format,
      edition: result.artifact.edition,
      cipherSha256: result.artifact.cipherSha256,
      size: result.artifact.size,
      encryption: result.artifact.encryption,
      keyVersion: result.artifact.keyVersion,
      licenseId: result.license.id,
      bindingId: result.binding.id,
      leaseId: result.lease.id,
      jti: result.lease.jti,
      clientKeyFingerprint,
      requestNonce: payload.nonce,
      issuedAt: result.lease.issuedAt,
      expiresAt: result.lease.expiresAt,
      wrapAlgorithm: result.wrapped.algorithm,
      serverEphemeralPublicKey: result.wrapped.serverEphemeralPublicKey,
      wrappedDek: {
        iv: result.wrapped.iv,
        tag: result.wrapped.tag,
        ciphertext: result.wrapped.ciphertext,
        associatedData: result.associatedData,
      },
    }, decryptText(
      this.rootSecret,
      `app-signing:${result.application.id}`,
      result.application.signingPrivateKeyEncrypted,
    ), result.application.signingKeyId);
  }
}

function encryptArtifactKey(rootSecret, artifactId, contentKey) {
  return encryptText(rootSecret, `artifact-dek:${artifactId}`, encodeBase64Url(contentKey));
}
