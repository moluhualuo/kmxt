import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applicationRequiresIntegrity,
  assertClientIntegrity,
  normalizeApplicationBinding,
  parseClientIntegrityInput,
} from '../src/services/client-integrity.js';

// 作者: 花落 (MIT License)
// WS4 防重打包 / APK 签名绑定核心判定逻辑单测。纯函数，无需起服务。

const CERT_A = 'a'.repeat(64);
const CERT_B = 'b'.repeat(64);

function expectAppError(fn, code, status) {
  try {
    fn();
    assert.fail(`expected AppError ${code} but nothing was thrown`);
  } catch (error) {
    assert.equal(error.name, 'AppError', `expected AppError, got ${error?.name}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
  }
}

test('parseClientIntegrityInput accepts absent fields as null', () => {
  const parsed = parseClientIntegrityInput({});
  assert.deepEqual(parsed, { packageName: null, certSha256: null, versionCode: null });
});

test('parseClientIntegrityInput normalizes and validates fields', () => {
  const parsed = parseClientIntegrityInput({
    packageName: 'com.example.screenyolo.paid',
    certSha256: CERT_A.toUpperCase(),
    versionCode: 42,
  });
  assert.equal(parsed.packageName, 'com.example.screenyolo.paid');
  assert.equal(parsed.certSha256, CERT_A); // lower-cased
  assert.equal(parsed.versionCode, 42);
});

test('parseClientIntegrityInput rejects malformed package name', () => {
  expectAppError(() => parseClientIntegrityInput({ packageName: 'not a package' }), 'INVALID_INPUT', 400);
});

test('parseClientIntegrityInput rejects non-hex certificate digest', () => {
  expectAppError(() => parseClientIntegrityInput({ certSha256: 'z'.repeat(64) }), 'INVALID_INPUT', 400);
});

test('applicationRequiresIntegrity reflects registered bindings', () => {
  assert.equal(applicationRequiresIntegrity({}), false);
  assert.equal(applicationRequiresIntegrity({ androidPackage: 'com.example.a' }), true);
  assert.equal(applicationRequiresIntegrity({ signingCertificates: [CERT_A] }), true);
  assert.equal(applicationRequiresIntegrity({ signingCertificates: [] }), false);
  assert.equal(applicationRequiresIntegrity({ minVersionCode: 5 }), true);
});

test('assertClientIntegrity is a no-op for applications without bindings (backward compatible)', () => {
  assert.doesNotThrow(() => assertClientIntegrity({}, { packageName: null, certSha256: null, versionCode: null }));
});

test('assertClientIntegrity passes when all bound facts match', () => {
  const application = {
    androidPackage: 'com.example.screenyolo.paid',
    signingCertificates: [CERT_A, CERT_B],
    minVersionCode: 10,
  };
  assert.doesNotThrow(() => assertClientIntegrity(application, {
    packageName: 'com.example.screenyolo.paid',
    certSha256: CERT_B,
    versionCode: 10,
  }));
});

test('assertClientIntegrity rejects a mismatched package name as SIGNATURE_MISMATCH', () => {
  expectAppError(
    () => assertClientIntegrity(
      { androidPackage: 'com.example.screenyolo.paid' },
      { packageName: 'com.attacker.repack', certSha256: null, versionCode: null },
    ),
    'SIGNATURE_MISMATCH',
    403,
  );
});

test('assertClientIntegrity rejects a missing package name as INTEGRITY_REJECTED', () => {
  expectAppError(
    () => assertClientIntegrity(
      { androidPackage: 'com.example.screenyolo.paid' },
      { packageName: null, certSha256: null, versionCode: null },
    ),
    'INTEGRITY_REJECTED',
    403,
  );
});

test('assertClientIntegrity rejects an unlisted signing certificate as SIGNATURE_MISMATCH', () => {
  expectAppError(
    () => assertClientIntegrity(
      { signingCertificates: [CERT_A] },
      { packageName: null, certSha256: CERT_B, versionCode: null },
    ),
    'SIGNATURE_MISMATCH',
    403,
  );
});

test('assertClientIntegrity accepts any listed certificate (rotation support)', () => {
  assert.doesNotThrow(() => assertClientIntegrity(
    { signingCertificates: [CERT_A, CERT_B] },
    { packageName: null, certSha256: CERT_A, versionCode: null },
  ));
});

test('assertClientIntegrity rejects an older versionCode as CLIENT_UPDATE_REQUIRED', () => {
  expectAppError(
    () => assertClientIntegrity(
      { minVersionCode: 20 },
      { packageName: null, certSha256: null, versionCode: 19 },
    ),
    'CLIENT_UPDATE_REQUIRED',
    426,
  );
});

test('assertClientIntegrity accepts an equal or newer versionCode', () => {
  assert.doesNotThrow(() => assertClientIntegrity(
    { minVersionCode: 20 },
    { packageName: null, certSha256: null, versionCode: 20 },
  ));
  assert.doesNotThrow(() => assertClientIntegrity(
    { minVersionCode: 20 },
    { packageName: null, certSha256: null, versionCode: 21 },
  ));
});

test('assertClientIntegrity rejects a missing versionCode when bound as INTEGRITY_REJECTED', () => {
  expectAppError(
    () => assertClientIntegrity(
      { minVersionCode: 20 },
      { packageName: null, certSha256: null, versionCode: null },
    ),
    'INTEGRITY_REJECTED',
    403,
  );
});

test('normalizeApplicationBinding validates and lower-cases certificates', () => {
  const result = normalizeApplicationBinding({
    androidPackage: 'com.example.screenyolo.paid',
    signingCertificates: [CERT_A.toUpperCase()],
    minVersionCode: 7,
  });
  assert.equal(result.androidPackage, 'com.example.screenyolo.paid');
  assert.deepEqual(result.signingCertificates, [CERT_A]);
  assert.equal(result.minVersionCode, 7);
});

test('normalizeApplicationBinding allows clearing bindings with null', () => {
  const result = normalizeApplicationBinding({
    androidPackage: null,
    signingCertificates: null,
    minVersionCode: null,
  });
  assert.equal(result.androidPackage, null);
  assert.equal(result.signingCertificates, null);
  assert.equal(result.minVersionCode, null);
});

test('normalizeApplicationBinding omits fields that were not provided', () => {
  const result = normalizeApplicationBinding({ androidPackage: 'com.example.a' });
  assert.deepEqual(Object.keys(result), ['androidPackage']);
});

test('normalizeApplicationBinding rejects a non-array certificate list', () => {
  expectAppError(() => normalizeApplicationBinding({ signingCertificates: CERT_A }), 'INVALID_INPUT', 400);
});

test('normalizeApplicationBinding rejects more than eight certificates', () => {
  const many = Array.from({ length: 9 }, (_, i) => i.toString(16).repeat(64).slice(0, 64));
  expectAppError(() => normalizeApplicationBinding({ signingCertificates: many }), 'INVALID_INPUT', 400);
});
