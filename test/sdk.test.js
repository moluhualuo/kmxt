import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { LicenseClient, LicenseProtocolError } from '../sdk/node/license-client.js';
import { createSignedEnvelope, generateSigningKeyPair } from '../src/security/crypto.js';

test('Node client accepts only a trusted signed license envelope', async () => {
  const appId = randomUUID();
  const keyId = 'trusted-test-key';
  const keys = generateSigningKeyPair();
  const envelope = createSignedEnvelope({
    licensed: true,
    appId,
    licenseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    sessionToken: 'session-token',
  }, keys.privateKey, keyId);
  const client = new LicenseClient({
    baseUrl: 'https://license.test',
    appId,
    keyId,
    publicKey: keys.publicKey,
    deviceId: 'stable-device-id',
    fetch: async () => new Response(JSON.stringify({ success: true, data: envelope }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  const result = await client.activate('KMXT-TEST-AAAAA-BBBBB-CCCCC-DDDDD');
  assert.equal(result.sessionToken, 'session-token');

  const tampered = structuredClone(envelope);
  tampered.payload.licenseExpiresAt = new Date(Date.now() + 120_000).toISOString();
  const rejectingClient = new LicenseClient({
    baseUrl: 'https://license.test',
    appId,
    keyId,
    publicKey: keys.publicKey,
    deviceId: 'stable-device-id',
    fetch: async () => new Response(JSON.stringify({ success: true, data: tampered }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  await assert.rejects(
    () => rejectingClient.activate('KMXT-TEST-AAAAA-BBBBB-CCCCC-DDDDD'),
    (error) => error instanceof LicenseProtocolError && error.code === 'INVALID_SIGNATURE',
  );
});

