import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  digestSecret,
  encryptText,
  generateSigningKeyPair,
  verifySignedEnvelope,
} from '../src/security/crypto.js';
import { ModelDeliveryService } from '../src/services/model-delivery-service.js';
import { MysqlModelDeliveryRepository } from '../src/storage/repositories/mysql-model-delivery-repository.js';

const APP_ID = '00000000-0000-0000-0000-000000000001';
const ARTIFACT_ID = '00000000-0000-0000-0000-000000000002';
const LICENSE_ID = '00000000-0000-0000-0000-000000000003';
const BINDING_ID = '00000000-0000-0000-0000-000000000004';
const MERCHANT_ID = '00000000-0000-0000-0000-000000000005';
const ACTOR = { id: 'owner-1', username: 'owner', role: 'merchant_admin', merchantId: MERCHANT_ID };

function application(overrides = {}) {
  return {
    id: APP_ID,
    merchantId: MERCHANT_ID,
    status: 'active',
    signingKeyId: 'key-1',
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    id: ARTIFACT_ID,
    merchantId: MERCHANT_ID,
    appId: APP_ID,
    name: 'model.onnx',
    version: '1.0.0',
    format: 'onnx',
    edition: null,
    status: 'draft',
    cipherSha256: createHash('sha256').update('ciphertext').digest('hex'),
    size: 1024,
    encryption: {
      algorithm: 'AES-256-GCM',
      nonce: randomBytes(12).toString('base64url'),
      tag: randomBytes(16).toString('base64url'),
      chunkSize: null,
    },
    keyVersion: 1,
    encryptedDek: 'encrypted-dek',
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
    ...overrides,
  };
}

// Author: 花落. MySQL model repository isolation is covered under the MIT License.
test('MySQL model repository registers and lists scoped artifacts and cleans expired leases', async () => {
  const calls = [];
  const currentApplication = application();
  const createdArtifact = artifact();
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql === 'SELECT merchant_id FROM applications WHERE id = ?') {
        return [[{ merchant_id: MERCHANT_ID }]];
      }
      if (sql === 'SELECT status FROM merchants WHERE id = ? FOR UPDATE') return [[{ status: 'active' }]];
      if (sql === 'SELECT payload, merchant_id, status FROM applications WHERE id = ? FOR UPDATE') {
        return [[{ payload: JSON.stringify(currentApplication), merchant_id: MERCHANT_ID, status: 'active' }]];
      }
      return [{ affectedRows: 1 }];
    },
  };
  const pool = {
    async getConnection() { return connection; },
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql === 'SELECT payload, merchant_id, status FROM applications WHERE id = ?') {
        return [[{ payload: JSON.stringify(currentApplication), merchant_id: MERCHANT_ID, status: 'active' }]];
      }
      if (/FROM model_artifacts/.test(sql)) {
        return [[{ payload: JSON.stringify(createdArtifact), merchant_id: MERCHANT_ID, app_id: APP_ID, status: 'draft' }]];
      }
      if (sql === 'DELETE FROM model_leases WHERE expires_at <= ?') return [{ affectedRows: 2 }];
      return [[]];
    },
  };
  const repository = new MysqlModelDeliveryRepository(pool);
  const registered = await repository.register(ACTOR, APP_ID, () => createdArtifact);
  assert.equal(registered.id, ARTIFACT_ID);
  assert.ok(calls.some((call) => /INSERT INTO model_artifacts/.test(call.sql)));
  assert.equal((await repository.list(ACTOR, APP_ID))[0].id, ARTIFACT_ID);
  assert.equal(await repository.cleanupExpiredLeases(Date.parse('2026-07-24T00:00:00.000Z')), 2);
  assert.equal(calls.some((call) => /SELECT id, payload FROM/.test(call.sql)), false);
});

test('MySQL model repository issues a lease with scoped row locks', async () => {
  const calls = [];
  const nowMilliseconds = Date.parse('2026-07-23T00:00:00.000Z');
  const currentApplication = application();
  const currentArtifact = artifact({ status: 'active' });
  const currentLicense = {
    id: LICENSE_ID,
    merchantId: MERCHANT_ID,
    appId: APP_ID,
    status: 'active',
    expiresAt: '2026-07-23T01:00:00.000Z',
  };
  const currentBinding = {
    id: BINDING_ID,
    merchantId: MERCHANT_ID,
    appId: APP_ID,
    licenseId: LICENSE_ID,
    status: 'active',
    deviceDigest: 'device-digest',
  };
  const currentSession = {
    id: 'session-1',
    appId: APP_ID,
    licenseId: LICENSE_ID,
    bindingId: BINDING_ID,
    expiresAt: '2026-07-23T00:30:00.000Z',
  };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql === 'SELECT merchant_id FROM applications WHERE id = ?') {
        return [[{ merchant_id: MERCHANT_ID }]];
      }
      if (sql === 'SELECT status FROM merchants WHERE id = ? FOR UPDATE') return [[{ status: 'active' }]];
      if (sql === 'SELECT payload, merchant_id, status FROM applications WHERE id = ? FOR UPDATE') {
        return [[{ payload: JSON.stringify(currentApplication), merchant_id: MERCHANT_ID, status: 'active' }]];
      }
      if (/FROM model_artifacts/.test(sql) && /FOR UPDATE/.test(sql)) {
        return [[{ payload: JSON.stringify(currentArtifact), merchant_id: MERCHANT_ID, app_id: APP_ID, status: 'active' }]];
      }
      if (/FROM licenses WHERE id = \? FOR UPDATE/.test(sql)) {
        return [[{ payload: JSON.stringify(currentLicense), status: 'active', expires_at: new Date(currentLicense.expiresAt) }]];
      }
      if (/FROM device_bindings/.test(sql) && /FOR UPDATE/.test(sql)) {
        return [[{ payload: JSON.stringify(currentBinding), status: 'active', device_digest: currentBinding.deviceDigest }]];
      }
      if (/FROM client_sessions/.test(sql) && /FOR UPDATE/.test(sql)) {
        return [[{ payload: JSON.stringify(currentSession), expires_at: new Date(currentSession.expiresAt) }]];
      }
      return [{ affectedRows: 1 }];
    },
  };
  const repository = new MysqlModelDeliveryRepository({ async getConnection() { return connection; } });
  const result = await repository.issueLease({
    appId: APP_ID,
    artifactId: ARTIFACT_ID,
    licenseId: LICENSE_ID,
    bindingId: BINDING_ID,
    sessionDigest: 'session-digest',
    deviceDigest: currentBinding.deviceDigest,
    nowMilliseconds,
  }, ({ application: lockedApp, artifact: lockedArtifact, license, binding, session }) => {
    assert.equal(lockedApp.id, APP_ID);
    assert.equal(lockedArtifact.id, ARTIFACT_ID);
    assert.equal(license.id, LICENSE_ID);
    assert.equal(binding.id, BINDING_ID);
    assert.equal(session.id, currentSession.id);
    return {
      lease: {
        id: '00000000-0000-0000-0000-000000000006',
        jti: '00000000-0000-0000-0000-000000000006',
        merchantId: MERCHANT_ID,
        appId: APP_ID,
        artifactId: ARTIFACT_ID,
        licenseId: LICENSE_ID,
        bindingId: BINDING_ID,
        clientKeyFingerprint: 'a'.repeat(64),
        status: 'active',
        issuedAt: '2026-07-23T00:00:00.000Z',
        expiresAt: '2026-07-23T00:10:00.000Z',
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z',
      },
      wrapped: { algorithm: 'test' },
      associatedData: 'test-associated-data',
    };
  });

  assert.equal(result.lease.artifactId, ARTIFACT_ID);
  assert.ok(calls.some((call) => /INSERT INTO model_leases/.test(call.sql)));
  assert.ok(calls.some((call) => /INSERT INTO audit_logs/.test(call.sql)));
  const sessionLock = calls.findIndex((call) => /FROM client_sessions/.test(call.sql) && /FOR UPDATE/.test(call.sql));
  const licenseLock = calls.findIndex((call) => /FROM licenses WHERE id = \? FOR UPDATE/.test(call.sql));
  const bindingLock = calls.findIndex((call) => /FROM device_bindings/.test(call.sql) && /FOR UPDATE/.test(call.sql));
  assert.ok(sessionLock >= 0 && sessionLock < licenseLock && licenseLock < bindingLock);
  assert.equal(calls.some((call) => /SELECT id, payload FROM/.test(call.sql)), false);
});

test('MySQL model repository keeps revoked artifacts terminal and revokes active leases', async () => {
  async function runSetStatus(initialStatus, nextStatus) {
    const calls = [];
    const currentArtifact = artifact({ status: initialStatus });
    const connection = {
      async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
      async execute(sql, values) {
        calls.push({ sql, values });
        if (sql === 'SELECT merchant_id, app_id FROM model_artifacts WHERE id = ?') {
          return [[{ merchant_id: MERCHANT_ID, app_id: APP_ID }]];
        }
        if (sql === 'SELECT status FROM merchants WHERE id = ? FOR UPDATE') return [[{ status: 'active' }]];
        if (sql === 'SELECT id FROM applications WHERE id = ? FOR UPDATE') return [[{ id: APP_ID }]];
        if (sql === 'SELECT payload, merchant_id, app_id, status FROM model_artifacts WHERE id = ? FOR UPDATE') {
          return [[{
            payload: JSON.stringify(currentArtifact),
            merchant_id: MERCHANT_ID,
            app_id: APP_ID,
            status: initialStatus,
          }]];
        }
        return [{ affectedRows: 1 }];
      },
    };
    const repository = new MysqlModelDeliveryRepository({ async getConnection() { return connection; } });
    return { calls, operation: repository.setStatus(ACTOR, ARTIFACT_ID, nextStatus) };
  }

  const terminal = await runSetStatus('revoked', 'active');
  await assert.rejects(
    () => terminal.operation,
    (error) => error?.code === 'ARTIFACT_REVOKED' && error?.status === 409,
  );
  assert.equal(terminal.calls.some((call) => /^UPDATE model_artifacts/.test(call.sql)), false);

  const revocation = await runSetStatus('active', 'revoked');
  assert.equal((await revocation.operation).status, 'revoked');
  assert.ok(revocation.calls.some((call) => /UPDATE model_leases/.test(call.sql)
    && /JSON_SET/.test(call.sql)));
});

test('ModelDeliveryService delegates MySQL artifact management without loading StateStore', async () => {
  const calls = [];
  const rootSecret = Buffer.alloc(32, 6);
  const currentApplication = application();
  const currentArtifact = artifact();
  const repository = {
    async register(actor, appId, createArtifact) {
      calls.push(`register:${actor.id}:${appId}`);
      return createArtifact(currentApplication);
    },
    async list(actor, appId) {
      calls.push(`list:${actor.id}:${appId}`);
      return [currentArtifact];
    },
    async setStatus(actor, artifactId, status) {
      calls.push(`status:${actor.id}:${artifactId}:${status}`);
      return { ...currentArtifact, status };
    },
  };
  const store = {
    repositories: { modelDelivery: repository },
    async read() { throw new Error('MySQL model path must not read StateStore'); },
    async transaction() { throw new Error('MySQL model path must not mutate StateStore'); },
  };
  const service = new ModelDeliveryService(store, rootSecret, { modelArtifactMaxBytes: 1024 * 1024 }, {});
  const registered = await service.register(ACTOR, APP_ID, {
    name: 'model.onnx',
    version: '1.0.0',
    format: 'onnx',
    cipherSha256: currentArtifact.cipherSha256,
    size: 1024,
    encryption: currentArtifact.encryption,
    contentKey: randomBytes(32).toString('base64url'),
  });
  assert.equal(registered.status, 'draft');
  assert.equal((await service.list(ACTOR, APP_ID))[0].id, ARTIFACT_ID);
  assert.equal((await service.setStatus(ACTOR, ARTIFACT_ID, 'active')).status, 'active');
  assert.deepEqual(calls.map((entry) => entry.split(':')[0]), ['register', 'list', 'status']);
});

test('ModelDeliveryService delegates MySQL lease issuance without loading StateStore', async () => {
  const rootSecret = Buffer.alloc(32, 7);
  const contentKey = randomBytes(32);
  const signing = generateSigningKeyPair();
  const sessionToken = randomBytes(32).toString('base64url');
  const deviceId = 'mysql-model-device';
  const client = generateKeyPairSync('x25519');
  const clientPublicKey = client.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const currentApplication = application({
    signingPrivateKeyEncrypted: encryptText(rootSecret, `app-signing:${APP_ID}`, signing.privateKey),
  });
  const currentArtifact = artifact({
    status: 'active',
    encryptedDek: encryptText(rootSecret, `artifact-dek:${ARTIFACT_ID}`, contentKey.toString('base64url')),
  });
  let repositoryInput;
  let persistedLease;
  const repository = {
    async issueLease(input, createLease) {
      repositoryInput = input;
      const prepared = createLease({
        application: currentApplication,
        artifact: currentArtifact,
        license: { id: LICENSE_ID, appId: APP_ID, status: 'active', expiresAt: new Date(Date.now() + 600000).toISOString() },
        binding: { id: BINDING_ID, appId: APP_ID, licenseId: LICENSE_ID, status: 'active', deviceDigest: input.deviceDigest },
        session: { id: 'session-1', licenseId: LICENSE_ID, bindingId: BINDING_ID, expiresAt: new Date(Date.now() + 300000).toISOString() },
      });
      persistedLease = prepared.lease;
      return {
        application: currentApplication,
        artifact: currentArtifact,
        license: { id: LICENSE_ID },
        binding: { id: BINDING_ID },
        ...prepared,
      };
    },
  };
  const store = {
    repositories: { modelDelivery: repository },
    async read() { throw new Error('MySQL model path must not read StateStore'); },
    async transaction() { throw new Error('MySQL model path must not mutate StateStore'); },
  };
  const verification = {
    async verify() {
      return { payload: { licensed: true, appId: APP_ID, licenseId: LICENSE_ID, bindingId: BINDING_ID } };
    },
  };
  const service = new ModelDeliveryService(store, rootSecret, {
    protocolVersion: '1',
    modelLeaseTtlSeconds: 120,
    modelLeaseMaxTtlSeconds: 180,
  }, verification);
  const envelope = await service.issueLease({
    appId: APP_ID,
    artifactId: ARTIFACT_ID,
    sessionToken,
    deviceId,
    clientPublicKey,
    timestamp: Date.now(),
    nonce: 'mysql-model-lease-nonce',
  });

  assert.equal(verifySignedEnvelope(envelope, signing.publicKey), true);
  assert.equal(persistedLease.artifactId, ARTIFACT_ID);
  assert.equal(repositoryInput.sessionDigest, digestSecret(rootSecret, 'client-session', sessionToken));
  assert.equal(repositoryInput.deviceDigest, digestSecret(rootSecret, `device:${APP_ID}`, deviceId));
});
