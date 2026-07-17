import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  scrypt,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const LICENSE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function encode(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function decode(value) {
  return Buffer.from(value, 'base64url');
}

function deriveKey(rootSecret, purpose) {
  return createHash('sha256').update(rootSecret).update(`kmxt:${purpose}`, 'utf8').digest();
}

export async function loadOrCreateRootSecret(secretFile) {
  await mkdir(path.dirname(secretFile), { recursive: true });
  try {
    const value = (await readFile(secretFile, 'utf8')).trim();
    const secret = decode(value);
    if (secret.length !== 32) {
      throw new Error('Root secret must contain exactly 32 bytes.');
    }
    return secret;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const secret = randomBytes(32);
  try {
    await writeFile(secretFile, `${encode(secret)}\n`, { encoding: 'utf8', flag: 'wx' });
    return secret;
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
    const existing = decode((await readFile(secretFile, 'utf8')).trim());
    if (existing.length !== 32) {
      throw new Error('Root secret must contain exactly 32 bytes.');
    }
    return existing;
  }
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt$${encode(salt)}$${encode(derived)}`;
}

export async function verifyPassword(password, storedHash) {
  const [algorithm, saltValue, hashValue] = String(storedHash).split('$');
  if (algorithm !== 'scrypt' || !saltValue || !hashValue) {
    return false;
  }
  const expected = decode(hashValue);
  const actual = await scryptAsync(password, decode(saltValue), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createOpaqueToken(bytes = 32) {
  return encode(randomBytes(bytes));
}

export function digestSecret(rootSecret, purpose, value) {
  return createHmac('sha256', deriveKey(rootSecret, purpose)).update(value, 'utf8').digest('hex');
}

export function normalizeLicenseKey(value) {
  return String(value).trim().toUpperCase();
}

export function generateLicenseKey(prefix = 'APP') {
  const normalizedPrefix = prefix.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'APP';
  const random = randomBytes(20);
  let body = '';
  for (let index = 0; index < 20; index += 1) {
    body += LICENSE_ALPHABET[random[index] % LICENSE_ALPHABET.length];
  }
  const groups = body.match(/.{1,5}/g);
  return `KMXT-${normalizedPrefix}-${groups.join('-')}`;
}

export function previewLicenseKey(key) {
  const parts = key.split('-');
  return `${parts.slice(0, 2).join('-')}-****-****-${parts.at(-1)}`;
}

export function encryptText(rootSecret, purpose, plaintext) {
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(rootSecret, purpose), initializationVector);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();
  return `${encode(initializationVector)}.${encode(authenticationTag)}.${encode(encrypted)}`;
}

export function decryptText(rootSecret, purpose, encryptedValue) {
  const [ivValue, tagValue, dataValue] = String(encryptedValue).split('.');
  if (!ivValue || !tagValue || !dataValue) {
    throw new Error('Encrypted value format is invalid.');
  }
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(rootSecret, purpose), decode(ivValue));
  decipher.setAuthTag(decode(tagValue));
  return Buffer.concat([decipher.update(decode(dataValue)), decipher.final()]).toString('utf8');
}

export function generateSigningKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function createSignedEnvelope(payload, privateKey, keyId) {
  const serialized = canonicalJson(payload);
  return {
    algorithm: 'Ed25519',
    keyId,
    payload,
    signature: encode(sign(null, Buffer.from(serialized, 'utf8'), privateKey)),
  };
}

export function verifySignedEnvelope(envelope, publicKey) {
  return verify(
    null,
    Buffer.from(canonicalJson(envelope.payload), 'utf8'),
    publicKey,
    decode(envelope.signature),
  );
}

