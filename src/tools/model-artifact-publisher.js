import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const AES_ALGORITHM = 'AES-256-GCM';
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const DEFAULT_HIGH_WATER_MARK = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const ARTIFACT_FORMATS = new Set(['onnx', 'ncnn-param', 'ncnn-bin', 'tflite', 'dlc', 'bundle']);

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_INPUT';
  return error;
}

function assertString(value, field, { min = 1, max = 4096 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw invalid(`${field} must be a string with ${min}-${max} characters`);
  }
  return value;
}

function assertInteger(value, field, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function assertBuffer(value, field, length) {
  if (!Buffer.isBuffer(value) || value.length !== length) {
    throw invalid(`${field} must contain exactly ${length} bytes`);
  }
  return value;
}

function assertHttpsUrl(value, field, { allowHttp = false } = {}) {
  assertString(value, field, { min: 8, max: 4096 });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid(`${field} must be a valid URL`);
  }
  const localHttp = parsed.protocol === 'http:'
    && allowHttp
    && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]');
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw invalid(`${field} must use HTTPS (use allowHttp only for local development)`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function assertPath(value, field) {
  return resolve(assertString(value, field, { min: 1, max: 4096 }));
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function writeChunk(stream, chunk) {
  if (!chunk.length) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolvePromise()));
  });
}

function finishStream(stream) {
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => {
      stream.off('finish', onFinish);
      reject(error);
    };
    const onFinish = () => {
      stream.off('error', onError);
      resolvePromise();
    };
    stream.once('error', onError);
    stream.once('finish', onFinish);
    stream.end();
  });
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Encrypt one model file without loading the whole model into memory.
 * The returned key is intentionally caller-owned and must be wiped after registration.
 * Author: 花落. Model artifact publishing helpers are released under the MIT License.
 */
export async function encryptModelFile({
  inputPath,
  outputPath,
  key = randomBytes(KEY_BYTES),
  nonce = randomBytes(NONCE_BYTES),
  overwrite = false,
  highWaterMark = DEFAULT_HIGH_WATER_MARK,
} = {}) {
  const sourcePath = assertPath(inputPath, 'inputPath');
  const destinationPath = assertPath(outputPath, 'outputPath');
  assertBuffer(key, 'key', KEY_BYTES);
  assertBuffer(nonce, 'nonce', NONCE_BYTES);
  assertInteger(highWaterMark, 'highWaterMark', { min: 16 * 1024, max: 16 * 1024 * 1024 });
  if (sourcePath === destinationPath) throw invalid('inputPath and outputPath must be different');

  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isFile()) throw invalid('inputPath must point to a regular file');
  if (sourceStat.size === 0) throw invalid('inputPath must not be empty');
  if (!overwrite && await pathExists(destinationPath)) {
    throw invalid('outputPath already exists; pass overwrite=true to replace it');
  }
  if (await pathExists(destinationPath)) {
    const destinationStat = await lstat(destinationPath);
    if (destinationStat.isDirectory()) throw invalid('outputPath must not be a directory');
  }

  await mkdir(dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.tmp-${randomUUID()}`;
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const plainHash = createHash('sha256');
  const cipherHash = createHash('sha256');
  const input = createReadStream(sourcePath, { highWaterMark });
  const output = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 });
  let plainSize = 0;
  let cipherSize = 0;

  try {
    for await (const chunk of input) {
      plainHash.update(chunk);
      plainSize += chunk.length;
      const encrypted = cipher.update(chunk);
      if (encrypted.length) {
        cipherHash.update(encrypted);
        cipherSize += encrypted.length;
        await writeChunk(output, encrypted);
      }
    }
    const finalChunk = cipher.final();
    if (finalChunk.length) {
      cipherHash.update(finalChunk);
      cipherSize += finalChunk.length;
      await writeChunk(output, finalChunk);
    }
    const tag = cipher.getAuthTag();
    await finishStream(output);
    if (overwrite) await rm(destinationPath, { force: true });
    await rename(temporaryPath, destinationPath);
    return {
      key,
      nonce,
      tag,
      plainSha256: plainHash.digest('hex'),
      plainSize,
      cipherSha256: cipherHash.digest('hex'),
      cipherSize,
      outputPath: destinationPath,
    };
  } catch (error) {
    input.destroy();
    output.destroy();
    await rm(temporaryPath, { force: true }).catch(() => {});
    // A failed publication must not leave a usable secret in the caller's buffer.
    key.fill(0);
    throw error;
  }
}

function normalizeResponseBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return body.data && typeof body.data === 'object' ? body.data : body;
}

async function readResponse(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Keep transport errors generic; response text may contain credentials or request data.
  }
  return body;
}

function safeRemoteMessage(value, secrets, fallback) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return fallback;
  if (secrets.some((secret) => secret && value.includes(secret))) return fallback;
  return value;
}

export class ArtifactPublishError extends Error {
  constructor(message, { code = 'ARTIFACT_PUBLISH_FAILED', status = 0 } = {}) {
    super(message);
    this.name = 'ArtifactPublishError';
    this.code = code;
    this.status = status;
  }
}

function createAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function validateArtifactInput(input) {
  const apiUrl = assertHttpsUrl(input.apiUrl, 'apiUrl', { allowHttp: input.allowHttp === true });
  const appId = assertString(input.appId, 'appId', { min: 1, max: 128 });
  const token = assertString(input.token, 'token', { min: 1, max: 4096 });
  const name = assertString(input.name, 'name', { min: 1, max: 128 });
  const version = assertString(input.version, 'version', { min: 1, max: 64 });
  const format = assertString(input.format, 'format', { min: 1, max: 32 });
  if (!ARTIFACT_FORMATS.has(format)) throw invalid(`format must be one of ${[...ARTIFACT_FORMATS].join(', ')}`);
  const edition = input.edition == null ? undefined : assertString(input.edition, 'edition', { min: 1, max: 32 });
  const keyVersion = input.keyVersion == null ? 1 : assertInteger(input.keyVersion, 'keyVersion', { min: 1, max: 1_000_000 });
  const timeoutMs = input.timeoutMs == null ? DEFAULT_TIMEOUT_MS : assertInteger(input.timeoutMs, 'timeoutMs', { min: 100, max: 10 * 60 * 1000 });
  return { apiUrl, appId, token, name, version, format, edition, keyVersion, timeoutMs };
}

/**
 * Encrypt, register, and optionally write a non-secret manifest for a model artifact.
 * The ciphertext is written locally and bundled into the APK assets; KMXT stores only the
 * encrypted DEK and metadata and never proxies model bytes. Author: 花落. MIT License.
 */
export async function publishModelArtifact(input = {}) {
  const options = validateArtifactInput(input);
  const inputPath = assertPath(input.inputPath, 'inputPath');
  const outputPath = assertPath(input.outputPath, 'outputPath');
  const manifestPath = input.manifestPath ? assertPath(input.manifestPath, 'manifestPath') : null;
  if (manifestPath === inputPath || manifestPath === outputPath) {
    throw invalid('manifestPath must be different from inputPath and outputPath');
  }
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new ArtifactPublishError('A Fetch implementation is required', { code: 'FETCH_UNAVAILABLE' });

  const encrypted = await encryptModelFile({
    inputPath,
    outputPath,
    overwrite: input.overwrite === true,
    highWaterMark: input.highWaterMark ?? DEFAULT_HIGH_WATER_MARK,
  });
  let registrationAccepted = false;
  let retainAmbiguousCiphertext = input.keepCiphertextOnFailure === true;
  try {
    const payload = {
      name: options.name,
      version: options.version,
      format: options.format,
      ...(options.edition ? { edition: options.edition } : {}),
      cipherSha256: encrypted.cipherSha256,
      // The API's size field is the encrypted object size. Plain size/hash stay in the local manifest/result.
      size: encrypted.cipherSize,
      encryption: {
        algorithm: AES_ALGORITHM,
        nonce: encode(encrypted.nonce),
        tag: encode(encrypted.tag),
        chunkSize: null,
      },
      contentKey: encode(encrypted.key),
      keyVersion: options.keyVersion,
    };
    const endpoint = `${options.apiUrl}/api/v1/apps/${encodeURIComponent(options.appId)}/artifacts`;
    const timeout = createAbortSignal(options.timeoutMs);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify(payload),
        signal: timeout.signal,
      });
    } catch (error) {
      // The server may have committed before the connection failed. Keep the matching
      // ciphertext so an operator can recover by listing the draft artifact.
      retainAmbiguousCiphertext = true;
      throw new ArtifactPublishError(error?.name === 'AbortError' ? 'Artifact registration timed out' : 'Artifact registration request failed', {
        code: error?.name === 'AbortError' ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED',
      });
    } finally {
      timeout.cancel();
    }
    const responseBody = await readResponse(response);
    if (!response.ok) {
      const details = responseBody?.error;
      const fallback = `Artifact registration failed (HTTP ${response.status})`;
      throw new ArtifactPublishError(safeRemoteMessage(
        details?.message,
        [payload.contentKey, options.token],
        fallback,
      ), {
        code: details?.code || 'ARTIFACT_PUBLISH_FAILED',
        status: response.status,
      });
    }
    registrationAccepted = true;
    const artifact = normalizeResponseBody(responseBody);
    if (!artifact || typeof artifact.id !== 'string') {
      throw new ArtifactPublishError('Artifact registration returned an invalid response', { code: 'INVALID_RESPONSE', status: response.status });
    }
    if (JSON.stringify(artifact).includes('contentKey') || JSON.stringify(artifact).includes('encryptedDek')) {
      throw new ArtifactPublishError('Artifact registration response contained a forbidden secret field', { code: 'SECRET_IN_RESPONSE', status: response.status });
    }
    const result = {
      artifact,
      appId: options.appId,
      inputPath,
      outputPath: encrypted.outputPath,
      plainSha256: encrypted.plainSha256,
      plainSize: encrypted.plainSize,
      cipherSha256: encrypted.cipherSha256,
      cipherSize: encrypted.cipherSize,
      encryption: {
        algorithm: AES_ALGORITHM,
        nonce: encode(encrypted.nonce),
        tag: encode(encrypted.tag),
        chunkSize: null,
      },
    };
    if (manifestPath) {
      const manifest = {
        schemaVersion: 1,
        artifactId: artifact.id,
        appId: options.appId,
        name: options.name,
        version: options.version,
        format: options.format,
        edition: options.edition ?? null,
        plainSha256: encrypted.plainSha256,
        plainSize: encrypted.plainSize,
        cipherSha256: encrypted.cipherSha256,
        cipherSize: encrypted.cipherSize,
        encryption: result.encryption,
        keyVersion: options.keyVersion,
      };
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      result.manifestPath = manifestPath;
    }
    return result;
  } finally {
    encrypted.key.fill(0);
    if (!registrationAccepted && !retainAmbiguousCiphertext) {
      await rm(encrypted.outputPath, { force: true }).catch(() => {});
    }
  }
}

/** Read a token from a file without ever printing it. */
export async function readSecretFile(path) {
  const tokenPath = assertPath(path, 'tokenFile');
  const value = (await readFile(tokenPath, 'utf8')).trim();
  if (!value) throw invalid('tokenFile is empty');
  return value;
}

export const MODEL_ARTIFACT_PUBLISHER_CONSTANTS = Object.freeze({
  AES_ALGORITHM,
  NONCE_BYTES,
  KEY_BYTES,
  TAG_BYTES,
  DEFAULT_HIGH_WATER_MARK,
});
