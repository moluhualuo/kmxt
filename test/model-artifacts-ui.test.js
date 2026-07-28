import assert from 'node:assert/strict';
import test from 'node:test';

const sessionValues = new Map();
globalThis.sessionStorage = {
  getItem: (key) => sessionValues.get(key) ?? null,
  setItem: (key, value) => sessionValues.set(key, String(value)),
  removeItem: (key) => sessionValues.delete(key),
};

const { store } = await import('../public/js/state.js');
const { renderModelArtifactsView } = await import('../public/js/views/model-artifacts.js');

function artifact(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'screen-model.onnx',
    version: '2026.07.23',
    format: 'onnx',
    edition: 'paid',
    status: 'draft',
    cipherSha256: 'a'.repeat(64),
    size: 1024,
    encryption: { algorithm: 'AES-256-GCM', nonce: 'n'.repeat(16), tag: 't'.repeat(22), chunkSize: null },
    keyVersion: 1,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
    ...overrides,
  };
}

function prepare(role) {
  store.reset();
  store.patch({
    user: { id: 'user-id', role, merchantId: role === 'platform_admin' ? null : 'merchant-id' },
    merchants: [{ id: 'merchant-id', code: 'MERCHANT', name: 'Merchant' }],
    applications: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', code: 'MODEL_APP', name: 'Model App' }],
    selectedMerchantId: 'merchant-id',
    selectedAppId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    modelArtifactStatus: '',
  });
}

async function renderWith(items) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { success: true, data: items };
    },
  });
  return renderModelArtifactsView();
}

// Author: 花落. Model artifact management UI contracts are covered under the MIT License.
test('model artifact management view enforces owner and terminal-revocation controls', async () => {
  prepare('merchant_admin');
  const ownerHtml = await renderWith([artifact({
    contentKey: 'must-not-render',
    encryptedDek: 'must-not-render-either',
  })]);
  assert.match(ownerHtml, /data-action="upload-model-artifact"/);
  assert.match(ownerHtml, /data-action="set-model-artifact-status"/);
  assert.match(ownerHtml, /data-status="active"/);
  assert.doesNotMatch(ownerHtml, /must-not-render/);

  const revokedHtml = await renderWith([artifact({ status: 'revoked' })]);
  assert.doesNotMatch(revokedHtml, /data-action="set-model-artifact-status"/);

  prepare('operator');
  const operatorHtml = await renderWith([artifact({ status: 'active' })]);
  assert.doesNotMatch(operatorHtml, /data-action="upload-model-artifact"/);
  assert.doesNotMatch(operatorHtml, /data-action="set-model-artifact-status"/);
});
