import assert from 'node:assert/strict';
import {
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../src/app.js';
import { verifySignedEnvelope } from '../src/security/crypto.js';

async function request(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

function nonce(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function unwrap(payload, privateKey) {
  const wrapped = payload.wrappedDek;
  const serverPublicKey = createPublicKey({
    key: Buffer.from(payload.serverEphemeralPublicKey, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  const shared = diffieHellman({ privateKey, publicKey: serverPublicKey });
  const wrappingKey = Buffer.from(hkdfSync(
    'sha256',
    shared,
    Buffer.from('kmxt-model-lease-salt'),
    Buffer.from(wrapped.associatedData),
    32,
  ));
  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(wrapped.iv, 'base64url'));
  decipher.setAAD(Buffer.from(wrapped.associatedData));
  decipher.setAuthTag(Buffer.from(wrapped.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(wrapped.ciphertext, 'base64url')),
    decipher.final(),
  ]);
}

async function createRegistrationFixture(context) {
  const runtimeRoot = path.join(process.cwd(), '.runtime');
  await mkdir(runtimeRoot, { recursive: true });
  const directory = await mkdtemp(path.join(runtimeRoot, 'model-validation-'));
  const runtime = await createRuntime({
    dataFile: path.join(directory, 'state.json'),
    secretFile: path.join(directory, 'secret.key'),
    port: 0,
  });
  context.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const platform = await runtime.services.auth.bootstrapPlatformAdmin({
    username: 'model.validation.platform',
    password: 'Model-Validation-Password!',
    displayName: 'Model Validation Platform',
  });
  const merchant = await runtime.services.merchants.create(platform, {
    code: 'MODEL_VALIDATION',
    name: 'Model Validation Merchant',
  });
  const application = await runtime.services.applications.create(platform, merchant.id, {
    code: 'MODEL_VALIDATION_APP',
    name: 'Model Validation App',
  });
  return { runtime, platform, application };
}

function registrationPayload(version, encryption) {
  return {
    name: 'validation-model.onnx',
    version,
    format: 'onnx',
    cipherSha256: createHash('sha256').update(`ciphertext-${version}`).digest('hex'),
    size: 1024,
    encryption,
    contentKey: randomBytes(32).toString('base64url'),
  };
}

test('model artifact registration strictly validates AES-GCM metadata', async (context) => {
  const { runtime, platform, application } = await createRegistrationFixture(context);
  const nonce = randomBytes(12).toString('base64url');
  const tag = randomBytes(16).toString('base64url');
  const invalidCases = [
    ['missing nonce', { algorithm: 'AES-256-GCM', tag }],
    ['missing tag', { algorithm: 'AES-256-GCM', nonce }],
    ['short nonce', { algorithm: 'AES-256-GCM', nonce: randomBytes(11).toString('base64url'), tag }],
    ['long nonce', { algorithm: 'AES-256-GCM', nonce: randomBytes(13).toString('base64url'), tag }],
    ['short tag', { algorithm: 'AES-256-GCM', nonce, tag: randomBytes(15).toString('base64url') }],
    ['long tag', { algorithm: 'AES-256-GCM', nonce, tag: randomBytes(17).toString('base64url') }],
    ['non-canonical tag', { algorithm: 'AES-256-GCM', nonce, tag: `${Buffer.alloc(16).toString('base64url').slice(0, -1)}B` }],
    ['string chunk size', { algorithm: 'AES-256-GCM', nonce, tag, chunkSize: '65536' }],
    ['small chunk size', { algorithm: 'AES-256-GCM', nonce, tag, chunkSize: 65535 }],
    ['large chunk size', { algorithm: 'AES-256-GCM', nonce, tag, chunkSize: 64 * 1024 * 1024 + 1 }],
    ['fractional chunk size', { algorithm: 'AES-256-GCM', nonce, tag, chunkSize: 65536.5 }],
  ];

  for (const [label, encryption] of invalidCases) {
    await assert.rejects(
      () => runtime.services.modelDelivery.register(
        platform,
        application.id,
        registrationPayload('invalid', encryption),
      ),
      (error) => error?.code === 'INVALID_INPUT' && error?.status === 400,
      label,
    );
  }
  assert.equal(await runtime.store.read((state) => state.modelArtifacts.length), 0);

  const unchunked = await runtime.services.modelDelivery.register(
    platform,
    application.id,
    registrationPayload('unchunked', {
      algorithm: 'AES-256-GCM',
      nonce,
      tag,
      chunkSize: null,
    }),
  );
  assert.equal(unchunked.encryption.chunkSize, null);

  const minimumChunk = await runtime.services.modelDelivery.register(
    platform,
    application.id,
    registrationPayload('minimum-chunk', {
      algorithm: 'AES-256-GCM',
      nonce,
      tag,
      chunkSize: 64 * 1024,
    }),
  );
  assert.equal(minimumChunk.encryption.chunkSize, 64 * 1024);

  const maximumChunk = await runtime.services.modelDelivery.register(
    platform,
    application.id,
    registrationPayload('maximum-chunk', {
      algorithm: 'AES-256-GCM',
      nonce,
      tag,
      chunkSize: 64 * 1024 * 1024,
    }),
  );
  assert.equal(maximumChunk.encryption.chunkSize, 64 * 1024 * 1024);

  await runtime.services.applications.setStatus(platform, application.id, 'disabled');
  await assert.rejects(
    () => runtime.services.modelDelivery.register(
      platform,
      application.id,
      registrationPayload('disabled-app', { algorithm: 'AES-256-GCM', nonce, tag }),
    ),
    (error) => error?.code === 'APPLICATION_DISABLED' && error?.status === 403,
  );
});

test('model artifact leases are signed, short-lived, and bound to a client key', async (context) => {
  const runtimeRoot = path.join(process.cwd(), '.runtime');
  await mkdir(runtimeRoot, { recursive: true });
  const directory = await mkdtemp(path.join(runtimeRoot, 'model-delivery-'));
  const runtime = await createRuntime({
    dataFile: path.join(directory, 'state.json'),
    secretFile: path.join(directory, 'secret.key'),
    port: 0,
    clockSkewSeconds: 30,
    clientSessionTtlSeconds: 300,
    modelLeaseTtlSeconds: 120,
    modelLeaseMaxTtlSeconds: 180,
  });
  context.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });

  const platform = await runtime.services.auth.bootstrapPlatformAdmin({
    username: 'model.platform',
    password: 'Model-Platform-Password!',
    displayName: 'Model Platform',
  });
  const merchant = await runtime.services.merchants.create(platform, { code: 'MODEL_MERCHANT', name: 'Model Merchant' });
  const application = await runtime.services.applications.create(platform, merchant.id, {
    code: 'MODEL_APP',
    name: 'Model App',
    settings: { defaultDurationDays: 30, defaultMaxDevices: 1, heartbeatSeconds: 60, offlineGraceSeconds: 300 },
  });
  const batch = await runtime.services.licenses.generate(platform, application.id, {
    count: 1,
    durationDays: 30,
    maxDevices: 1,
    batchName: 'Model Batch',
  });
  const licenseKey = batch.licenses[0].key;
  const artifactKey = randomBytes(32);
  const artifact = await runtime.services.modelDelivery.register(platform, application.id, {
    name: 'model.onnx',
    version: '2026.07.22',
    format: 'onnx',
    cipherSha256: createHash('sha256').update('ciphertext').digest('hex'),
    size: 10,
    encryption: {
      algorithm: 'AES-256-GCM',
      nonce: randomBytes(12).toString('base64url'),
      tag: randomBytes(16).toString('base64url'),
    },
    contentKey: artifactKey.toString('base64url'),
  });
  assert.equal(artifact.status, 'draft');
  await runtime.services.modelDelivery.setStatus(platform, artifact.id, 'active');

  const address = await runtime.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const activation = await request(baseUrl, '/api/v1/client/activate', {
    appId: application.id,
    licenseKey,
    deviceId: 'model-device-001',
    clientVersion: '1.0.0',
    timestamp: Date.now(),
    nonce: nonce('activate'),
  });
  assert.equal(activation.status, 200);
  const sessionToken = activation.payload.data.payload.sessionToken;
  const client = generateKeyPairSync('x25519');
  const clientPublicKey = client.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const lease = await request(baseUrl, `/api/v1/client/artifacts/${artifact.id}/lease`, {
    appId: application.id,
    sessionToken,
    deviceId: 'model-device-001',
    clientVersion: '1.0.0',
    clientPublicKey,
    timestamp: Date.now(),
    nonce: nonce('lease'),
  });
  assert.equal(lease.status, 200);
  assert.equal(verifySignedEnvelope(lease.payload.data, application.signing.publicKey), true);
  const leasePayload = lease.payload.data.payload;
  assert.equal(leasePayload.artifactId, artifact.id);
  assert.equal(leasePayload.bindingId, activation.payload.data.payload.bindingId);
  assert.equal(leasePayload.clientKeyFingerprint, createHash('sha256').update(clientPublicKey).digest('hex'));
  assert.deepEqual(unwrap(leasePayload, client.privateKey), artifactKey);
  const persisted = await readFile(path.join(directory, 'state.json'), 'utf8');
  assert.equal(persisted.includes(artifactKey.toString('base64url')), false);

  const replay = await request(baseUrl, `/api/v1/client/artifacts/${artifact.id}/lease`, {
    appId: application.id,
    sessionToken,
    deviceId: 'model-device-001',
    clientPublicKey,
    timestamp: Date.now(),
    nonce: leasePayload.requestNonce,
  });
  assert.equal(replay.status, 409);
  assert.equal(replay.payload.error.code, 'REPLAY_DETECTED');

  const licenseId = activation.payload.data.payload.licenseId;
  const originalLicense = await runtime.store.transaction((state) => {
    const license = state.licenses.find((item) => item.id === licenseId);
    const original = { status: license.status, expiresAt: license.expiresAt };
    license.status = 'expired';
    return original;
  });
  const expiredLicense = await request(baseUrl, `/api/v1/client/artifacts/${artifact.id}/lease`, {
    appId: application.id,
    sessionToken,
    deviceId: 'model-device-001',
    clientPublicKey,
    timestamp: Date.now(),
    nonce: nonce('expired-license'),
  });
  assert.equal(expiredLicense.status, 403);
  assert.equal(expiredLicense.payload.error.code, 'LICENSE_EXPIRED');
  assert.equal(await runtime.store.read((state) => state.modelLeases.length), 1);
  await runtime.store.transaction((state) => {
    const license = state.licenses.find((item) => item.id === licenseId);
    license.status = originalLicense.status;
    license.expiresAt = originalLicense.expiresAt;
  });

  await runtime.services.modelDelivery.setStatus(platform, artifact.id, 'revoked');
  const revoked = await request(baseUrl, `/api/v1/client/artifacts/${artifact.id}/lease`, {
    appId: application.id,
    sessionToken,
    deviceId: 'model-device-001',
    clientPublicKey,
    timestamp: Date.now(),
    nonce: nonce('revoked'),
  });
  assert.equal(revoked.status, 403);
  assert.equal(revoked.payload.error.code, 'ARTIFACT_UNAVAILABLE');

  const revokedAgain = await runtime.services.modelDelivery.setStatus(platform, artifact.id, 'revoked');
  assert.equal(revokedAgain.status, 'revoked');
  await assert.rejects(
    () => runtime.services.modelDelivery.setStatus(platform, artifact.id, 'active'),
    (error) => error?.code === 'ARTIFACT_REVOKED' && error?.status === 409,
  );
  assert.equal(
    await runtime.store.read((state) => state.modelLeases[0]?.status),
    'revoked',
  );

  const leaseExpiry = Date.parse(leasePayload.expiresAt);
  assert.equal((await runtime.services.maintenance.cleanupSessions(leaseExpiry - 1)).expiredModelLeases, 0);
  assert.equal(await runtime.store.read((state) => state.modelLeases.length), 1);
  assert.equal((await runtime.services.maintenance.cleanupSessions(leaseExpiry)).expiredModelLeases, 1);
  assert.equal(await runtime.store.read((state) => state.modelLeases.length), 0);
});

// Author: 花落. JSON cascade behavior for model leases is covered under the MIT License.
test('deleting a JSON-backed license removes its model leases', async (context) => {
  const { runtime, platform, application } = await createRegistrationFixture(context);
  const batch = await runtime.services.licenses.generate(platform, application.id, { count: 1 });
  const licenseId = batch.licenses[0].id;
  await runtime.store.transaction((state) => {
    state.modelLeases.push({
      id: 'model-lease-to-delete',
      licenseId,
      status: 'active',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
  });

  await runtime.services.licenses.delete(platform, licenseId);
  assert.equal(await runtime.store.read((state) => state.modelLeases.length), 0);
});
