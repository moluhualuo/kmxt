import { randomBytes, verify as verifySignature } from 'node:crypto';

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function createNonce() {
  return randomBytes(18).toString('base64url');
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new TypeError('baseUrl must be an absolute HTTPS URL');
  }
  const localHttp = url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new TypeError('baseUrl must use HTTPS outside loopback development');
  }
  if (url.username || url.password) {
    throw new TypeError('baseUrl must not contain credentials');
  }
  if (url.search || url.hash) {
    throw new TypeError('baseUrl must not contain a query string or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

export class LicenseProtocolError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'LicenseProtocolError';
    this.code = code;
    this.status = status;
  }
}

// Author: 花落. Client integration code is available under the MIT License.
export class LicenseClient {
  constructor(options) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.appId = options.appId;
    this.publicKey = options.publicKey;
    this.keyId = options.keyId;
    this.deviceId = options.deviceId;
    this.clientVersion = options.clientVersion || null;
    this.fetch = options.fetch || globalThis.fetch;
    if (!this.baseUrl || !this.appId || !this.publicKey || !this.keyId || !this.deviceId) {
      throw new TypeError('baseUrl, appId, publicKey, keyId and deviceId are required');
    }
    if (typeof this.fetch !== 'function') {
      throw new TypeError('A Fetch API implementation is required');
    }
  }

  async activate(licenseKey, options = {}) {
    const requestNonce = createNonce();
    return this.#post('/api/v1/client/activate', {
      appId: this.appId,
      licenseKey,
      deviceId: this.deviceId,
      deviceLabel: options.deviceLabel,
      clientVersion: this.clientVersion,
      timestamp: Date.now(),
      nonce: requestNonce,
    }, (envelope) => this.#verifyLicenseEnvelope(envelope, requestNonce));
  }

  async verify(sessionToken) {
    const requestNonce = createNonce();
    return this.#post('/api/v1/client/verify', {
      appId: this.appId,
      sessionToken,
      deviceId: this.deviceId,
      clientVersion: this.clientVersion,
      timestamp: Date.now(),
      nonce: requestNonce,
    }, (envelope) => this.#verifyLicenseEnvelope(envelope, requestNonce));
  }

  async unbind(sessionToken) {
    const requestNonce = createNonce();
    return this.#post('/api/v1/client/unbind', {
      appId: this.appId,
      sessionToken,
      deviceId: this.deviceId,
      clientVersion: this.clientVersion,
      timestamp: Date.now(),
      nonce: requestNonce,
    }, (envelope) => this.#verifyUnbindEnvelope(envelope, requestNonce));
  }

  async #post(path, body, validate) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
      });
    } catch (error) {
      throw new LicenseProtocolError('NETWORK_ERROR', error.message);
    }
    if (response.redirected) {
      throw new LicenseProtocolError('UNTRUSTED_REDIRECT', 'License requests must not follow redirects', response.status);
    }

    let result;
    try {
      result = await response.json();
    } catch {
      throw new LicenseProtocolError('INVALID_SERVER_RESPONSE', 'Server did not return valid JSON', response.status);
    }
    if (!response.ok || !result.success) {
      throw new LicenseProtocolError(
        result.error?.code || 'SERVER_REJECTED',
        result.error?.message || 'License server rejected the request',
        response.status,
      );
    }
    return validate(result.data);
  }

  #verifySignedPayload(envelope, requestNonce) {
    if (!envelope || envelope.algorithm !== 'Ed25519' || envelope.keyId !== this.keyId) {
      throw new LicenseProtocolError('UNTRUSTED_RESPONSE', 'Response signing identity is not trusted');
    }
    if (!envelope.payload || typeof envelope.signature !== 'string') {
      throw new LicenseProtocolError('INVALID_SIGNATURE', 'Signed response is incomplete');
    }
    const signatureValid = verifySignature(
      null,
      Buffer.from(canonicalJson(envelope.payload), 'utf8'),
      this.publicKey,
      Buffer.from(envelope.signature, 'base64url'),
    );
    if (!signatureValid) {
      throw new LicenseProtocolError('INVALID_SIGNATURE', 'License response signature is invalid');
    }
    if (envelope.payload.appId !== this.appId) {
      throw new LicenseProtocolError('LICENSE_REJECTED', 'Signed response belongs to another application');
    }
    if (envelope.payload.requestNonce !== requestNonce) {
      throw new LicenseProtocolError(
        'RESPONSE_NONCE_MISMATCH',
        'Signed response does not belong to the current request',
      );
    }
    return envelope.payload;
  }

  #verifyLicenseEnvelope(envelope, requestNonce) {
    const payload = this.#verifySignedPayload(envelope, requestNonce);
    if (payload.licensed !== true) {
      throw new LicenseProtocolError('LICENSE_REJECTED', 'Signed response does not authorize this application');
    }
    const licenseExpiresAt = Date.parse(payload.licenseExpiresAt);
    if (!Number.isFinite(licenseExpiresAt) || licenseExpiresAt <= Date.now()) {
      throw new LicenseProtocolError('LICENSE_EXPIRED', 'Signed license response has expired');
    }
    return payload;
  }

  #verifyUnbindEnvelope(envelope, requestNonce) {
    const payload = this.#verifySignedPayload(envelope, requestNonce);
    if (payload.unbound !== true || payload.code !== 'DEVICE_UNBOUND') {
      throw new LicenseProtocolError('UNBIND_REJECTED', 'Signed response did not confirm device unbinding');
    }
    return payload;
  }
}
