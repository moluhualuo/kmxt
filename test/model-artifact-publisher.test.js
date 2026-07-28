import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ArtifactPublishError,
  encryptModelFile,
  publishModelArtifact,
} from '../src/tools/model-artifact-publisher.js';

async function temporaryDirectory(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kmxt-artifact-publisher-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function assertMissing(filePath) {
  await assert.rejects(access(filePath), (error) => error?.code === 'ENOENT');
}

test('encryptModelFile streams AES-256-GCM ciphertext and reports both hashes', async (context) => {
  const directory = await temporaryDirectory(context);
  const inputPath = path.join(directory, 'model.onnx');
  const outputPath = path.join(directory, 'model.onnx.enc');
  const plaintext = Buffer.concat([
    Buffer.from('ScreenYolo model fixture\n', 'utf8'),
    Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a),
  ]);
  await writeFile(inputPath, plaintext);

  const encrypted = await encryptModelFile({ inputPath, outputPath, highWaterMark: 64 * 1024 });
  try {
    const ciphertext = await readFile(outputPath);
    assert.equal(encrypted.plainSize, plaintext.length);
    assert.equal(encrypted.cipherSize, ciphertext.length);
    assert.equal(encrypted.plainSha256, createHash('sha256').update(plaintext).digest('hex'));
    assert.equal(encrypted.cipherSha256, createHash('sha256').update(ciphertext).digest('hex'));
    assert.equal(encrypted.key.length, 32);
    assert.equal(encrypted.nonce.length, 12);
    assert.equal(encrypted.tag.length, 16);

    const decipher = createDecipheriv('aes-256-gcm', encrypted.key, encrypted.nonce);
    decipher.setAuthTag(encrypted.tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    assert.deepEqual(decrypted, plaintext);
  } finally {
    encrypted.key.fill(0);
  }
});

test('publishModelArtifact registers only ciphertext metadata and writes a secret-free manifest', async (context) => {
  const directory = await temporaryDirectory(context);
  const inputPath = path.join(directory, 'model.tflite');
  const outputPath = path.join(directory, 'model.tflite.enc');
  const manifestPath = path.join(directory, 'model.tflite.manifest.json');
  const plaintext = Buffer.from('tflite-model-content-for-publisher-test', 'utf8');
  await writeFile(inputPath, plaintext);
  let capturedRequest;

  const result = await publishModelArtifact({
    apiUrl: 'https://kmxt.example.test',
    appId: 'app-test-id',
    token: 'admin-token-that-must-not-be-logged',
    inputPath,
    outputPath,
    name: 'model.tflite',
    version: '2026.07.22',
    format: 'tflite',
    edition: 'paid',
    manifestPath,
    fetchImpl: async (url, options) => {
      capturedRequest = { url, options, payload: JSON.parse(options.body) };
      return {
        ok: true,
        status: 201,
        async json() {
          return { success: true, data: { id: 'artifact-id', status: 'draft' } };
        },
      };
    },
  });

  assert.equal(capturedRequest.url, 'https://kmxt.example.test/api/v1/apps/app-test-id/artifacts');
  assert.equal(capturedRequest.options.headers.authorization, 'Bearer admin-token-that-must-not-be-logged');
  assert.equal(capturedRequest.payload.encryption.algorithm, 'AES-256-GCM');
  assert.equal(capturedRequest.payload.encryption.chunkSize, null);
  assert.equal(Buffer.from(capturedRequest.payload.contentKey, 'base64url').length, 32);
  assert.equal(Buffer.from(capturedRequest.payload.encryption.nonce, 'base64url').length, 12);
  assert.equal(Buffer.from(capturedRequest.payload.encryption.tag, 'base64url').length, 16);
  assert.equal(capturedRequest.payload.size, (await readFile(outputPath)).length);
  assert.equal(result.plainSha256, createHash('sha256').update(plaintext).digest('hex'));
  assert.equal(result.plainSize, plaintext.length);

  const manifestText = await readFile(manifestPath, 'utf8');
  assert.equal(manifestText.includes('contentKey'), false);
  assert.equal(manifestText.includes(capturedRequest.payload.contentKey), false);
  assert.equal(JSON.stringify(result).includes(capturedRequest.payload.contentKey), false);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.artifactId, 'artifact-id');
  assert.equal(manifest.plainSha256, result.plainSha256);
  assert.equal(manifest.cipherSha256, result.cipherSha256);
});

test('publishModelArtifact removes unusable ciphertext when registration fails', async (context) => {
  const directory = await temporaryDirectory(context);
  const inputPath = path.join(directory, 'model.dlc');
  const outputPath = path.join(directory, 'model.dlc.enc');
  await writeFile(inputPath, 'model-content');

  await assert.rejects(publishModelArtifact({
    apiUrl: 'https://kmxt.example.test',
    appId: 'app-test-id',
    token: 'admin-token',
    inputPath,
    outputPath,
    name: 'model.dlc',
    version: '1',
    format: 'dlc',
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      async json() {
        return { success: false, error: { code: 'ARTIFACT_EXISTS', message: 'Artifact already exists' } };
      },
    }),
  }), (error) => {
    assert.ok(error instanceof ArtifactPublishError);
    assert.equal(error.code, 'ARTIFACT_EXISTS');
    assert.equal(error.status, 409);
    assert.equal(error.message.includes('admin-token'), false);
    return true;
  });
  await assertMissing(outputPath);
});

test('publishModelArtifact redacts a DEK echoed by a rejected remote response', async (context) => {
  const directory = await temporaryDirectory(context);
  const inputPath = path.join(directory, 'model.bin');
  const outputPath = path.join(directory, 'model.bin.enc');
  await writeFile(inputPath, 'model-content');
  let echoedKey;

  await assert.rejects(publishModelArtifact({
    apiUrl: 'https://kmxt.example.test',
    appId: 'app-test-id',
    token: 'admin-token',
    inputPath,
    outputPath,
    name: 'model.bin',
    version: '1',
    format: 'ncnn-bin',
    fetchImpl: async (_url, options) => {
      echoedKey = JSON.parse(options.body).contentKey;
      return {
        ok: false,
        status: 400,
        async json() {
          return { success: false, error: { code: 'INVALID_INPUT', message: `rejected ${echoedKey}` } };
        },
      };
    },
  }), (error) => {
    assert.equal(error.message, 'Artifact registration failed (HTTP 400)');
    assert.equal(error.message.includes(echoedKey), false);
    return true;
  });
  await assertMissing(outputPath);
});

test('publishModelArtifact retains ciphertext when registration outcome is unknown', async (context) => {
  const directory = await temporaryDirectory(context);
  const inputPath = path.join(directory, 'model.param');
  const outputPath = path.join(directory, 'model.param.enc');
  await writeFile(inputPath, 'model-content');

  await assert.rejects(publishModelArtifact({
    apiUrl: 'https://kmxt.example.test',
    appId: 'app-test-id',
    token: 'admin-token',
    inputPath,
    outputPath,
    name: 'model.param',
    version: '1',
    format: 'ncnn-param',
    fetchImpl: async () => {
      throw new Error('connection lost after request upload');
    },
  }), (error) => {
    assert.ok(error instanceof ArtifactPublishError);
    assert.equal(error.code, 'REQUEST_FAILED');
    assert.equal(error.message, 'Artifact registration request failed');
    return true;
  });
  assert.equal((await readFile(outputPath)).length, 'model-content'.length);
});

test('publishModelArtifact rejects non-HTTPS remote endpoints before creating output', async (context) => {
  const directory = await temporaryDirectory(context);
  const inputPath = path.join(directory, 'model.onnx');
  const outputPath = path.join(directory, 'model.onnx.enc');
  await writeFile(inputPath, 'model-content');

  await assert.rejects(publishModelArtifact({
    apiUrl: 'http://kmxt.example.test',
    appId: 'app-test-id',
    token: 'admin-token',
    inputPath,
    outputPath,
    name: 'model.onnx',
    version: '1',
    format: 'onnx',
    fetchImpl: async () => assert.fail('fetch must not be called'),
  }), /apiUrl must use HTTPS/);
  await assertMissing(outputPath);
});
