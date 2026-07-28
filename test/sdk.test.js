import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { LicenseClient, LicenseProtocolError } from '../sdk/node/license-client.js';
import { createSignedEnvelope, generateSigningKeyPair } from '../src/security/crypto.js';

function successResponse(envelope) {
  return new Response(JSON.stringify({ success: true, data: envelope }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestBody(options) {
  return JSON.parse(options.body);
}

function signedLicenseEnvelope({ appId, keyId, keys, requestNonce, sessionToken = 'session-token' }) {
  return createSignedEnvelope({
    licensed: true,
    code: 'LICENSE_VALID',
    appId,
    requestNonce,
    licenseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    sessionToken,
  }, keys.privateKey, keyId);
}

// Author: 花落. Protocol regression tests are provided under the MIT License.
test('Node client accepts only a trusted signed license envelope bound to its request', async () => {
  const appId = randomUUID();
  const keyId = 'trusted-test-key';
  const keys = generateSigningKeyPair();
  let requestedNonce = '';
  const client = new LicenseClient({
    baseUrl: 'https://license.test',
    appId,
    keyId,
    publicKey: keys.publicKey,
    deviceId: 'stable-device-id',
    fetch: async (_url, options) => {
      requestedNonce = requestBody(options).nonce;
      return successResponse(signedLicenseEnvelope({ appId, keyId, keys, requestNonce: requestedNonce }));
    },
  });

  const result = await client.activate('KMXT-TEST-AAAAA-BBBBB-CCCCC-DDDDD');
  assert.equal(result.sessionToken, 'session-token');
  assert.equal(result.requestNonce, requestedNonce);

  const rejectingClient = new LicenseClient({
    baseUrl: 'https://license.test',
    appId,
    keyId,
    publicKey: keys.publicKey,
    deviceId: 'stable-device-id',
    fetch: async (_url, options) => {
      const body = requestBody(options);
      const tampered = signedLicenseEnvelope({ appId, keyId, keys, requestNonce: body.nonce });
      tampered.payload.licenseExpiresAt = new Date(Date.now() + 120_000).toISOString();
      return successResponse(tampered);
    },
  });

  await assert.rejects(
    () => rejectingClient.activate('KMXT-TEST-AAAAA-BBBBB-CCCCC-DDDDD'),
    (error) => error instanceof LicenseProtocolError && error.code === 'INVALID_SIGNATURE',
  );
});

test('Node client rejects a validly signed response with the wrong request nonce', async () => {
  const appId = randomUUID();
  const keyId = 'wrong-nonce-key';
  const keys = generateSigningKeyPair();
  const client = new LicenseClient({
    baseUrl: 'https://license.test',
    appId,
    keyId,
    publicKey: keys.publicKey,
    deviceId: 'stable-device-id',
    fetch: async (_url, options) => {
      const body = requestBody(options);
      return successResponse(signedLicenseEnvelope({
        appId,
        keyId,
        keys,
        requestNonce: `wrong-${body.nonce}`,
      }));
    },
  });

  await assert.rejects(
    () => client.activate('KMXT-TEST-AAAAA-BBBBB-CCCCC-DDDDD'),
    (error) => error instanceof LicenseProtocolError && error.code === 'RESPONSE_NONCE_MISMATCH',
  );
});

test('Node client rejects replaying a prior signed response to a later request', async () => {
  const appId = randomUUID();
  const keyId = 'replay-test-key';
  const keys = generateSigningKeyPair();
  const requestNonces = [];
  let capturedEnvelope = null;
  const client = new LicenseClient({
    baseUrl: 'https://license.test',
    appId,
    keyId,
    publicKey: keys.publicKey,
    deviceId: 'stable-device-id',
    fetch: async (_url, options) => {
      const body = requestBody(options);
      requestNonces.push(body.nonce);
      capturedEnvelope ??= signedLicenseEnvelope({
        appId,
        keyId,
        keys,
        requestNonce: body.nonce,
      });
      return successResponse(capturedEnvelope);
    },
  });

  await client.activate('KMXT-TEST-AAAAA-BBBBB-CCCCC-DDDDD');
  await assert.rejects(
    () => client.activate('KMXT-TEST-AAAAA-BBBBB-CCCCC-DDDDD'),
    (error) => error instanceof LicenseProtocolError && error.code === 'RESPONSE_NONCE_MISMATCH',
  );
  assert.notEqual(requestNonces[0], requestNonces[1]);
});

test('Node client binds verify and self-unbind responses to their own request nonces', async () => {
  const appId = randomUUID();
  const keyId = 'trusted-unbind-key';
  const keys = generateSigningKeyPair();
  const requestedNonces = new Map();
  const client = new LicenseClient({
    baseUrl: 'https://license.test',
    appId,
    keyId,
    publicKey: keys.publicKey,
    deviceId: 'stable-device-id',
    fetch: async (url, options) => {
      const requestedPath = new URL(url).pathname;
      const body = requestBody(options);
      requestedNonces.set(requestedPath, body.nonce);
      if (requestedPath.endsWith('/unbind')) {
        return successResponse(createSignedEnvelope({
          unbound: true,
          code: 'DEVICE_UNBOUND',
          appId,
          requestNonce: body.nonce,
          bindingId: 'binding-1',
          sessionsRevoked: 1,
          issuedAt: new Date().toISOString(),
        }, keys.privateKey, keyId));
      }
      return successResponse(signedLicenseEnvelope({
        appId,
        keyId,
        keys,
        requestNonce: body.nonce,
        sessionToken: undefined,
      }));
    },
  });

  const verified = await client.verify('session-token-with-sufficient-length-123456');
  assert.equal(verified.requestNonce, requestedNonces.get('/api/v1/client/verify'));

  const unbound = await client.unbind('session-token-with-sufficient-length-123456');
  assert.equal(unbound.requestNonce, requestedNonces.get('/api/v1/client/unbind'));
  assert.equal(unbound.unbound, true);
  assert.equal(unbound.code, 'DEVICE_UNBOUND');
});

test('Node client requires secure remote transport and rejects redirects', async () => {
  const appId = randomUUID();
  const keyId = 'transport-test-key';
  const keys = generateSigningKeyPair();
  const common = {
    appId,
    keyId,
    publicKey: keys.publicKey,
    deviceId: 'stable-device-id',
  };
  assert.throws(
    () => new LicenseClient({ ...common, baseUrl: 'http://license.example.test' }),
    /must use HTTPS/,
  );

  let redirectMode;
  const localClient = new LicenseClient({
    ...common,
    baseUrl: 'http://127.0.0.1:8080',
    fetch: async (_url, options) => {
      redirectMode = options.redirect;
      const body = requestBody(options);
      return successResponse(signedLicenseEnvelope({
        appId,
        keyId,
        keys,
        requestNonce: body.nonce,
      }));
    },
  });
  await localClient.activate('KMXT-TEST-AAAAA-BBBBB-CCCCC-DDDDD');
  assert.equal(redirectMode, 'error');
});
