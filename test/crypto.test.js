import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalJson,
  createSignedEnvelope,
  generateSigningKeyPair,
  verifySignedEnvelope,
} from '../src/security/crypto.js';

test('canonical JSON and Ed25519 envelopes are deterministic and verifiable', () => {
  const keys = generateSigningKeyPair();
  const left = { z: 1, nested: { b: true, a: ['x', 2] } };
  const right = { nested: { a: ['x', 2], b: true }, z: 1 };

  assert.equal(canonicalJson(left), canonicalJson(right));
  const envelope = createSignedEnvelope(left, keys.privateKey, 'test-key');
  assert.equal(verifySignedEnvelope(envelope, keys.publicKey), true);

  envelope.payload.z = 2;
  assert.equal(verifySignedEnvelope(envelope, keys.publicKey), false);
});

