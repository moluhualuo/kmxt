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
    this.baseUrl = String(options.baseUrl).replace(/\/+$/, '');
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
    return this.#post('/api/v1/client/activate', {
      appId: this.appId,
      licenseKey,
      deviceId: this.deviceId,
      deviceLabel: options.deviceLabel,
      clientVersion: this.clientVersion,
      timestamp: Date.now(),
      nonce: createNonce(),
    });
  }

  async verify(sessionToken) {
    return this.#post('/api/v1/client/verify', {
      appId: this.appId,
      sessionToken,
      deviceId: this.deviceId,
      clientVersion: this.clientVersion,
      timestamp: Date.now(),
      nonce: createNonce(),
    });
  }

  async #post(path, body) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new LicenseProtocolError('NETWORK_ERROR', error.message);
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
    return this.#verifyEnvelope(result.data);
  }

  #verifyEnvelope(envelope) {
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
    if (envelope.payload.appId !== this.appId || envelope.payload.licensed !== true) {
      throw new LicenseProtocolError('LICENSE_REJECTED', 'Signed response does not authorize this application');
    }
    const licenseExpiresAt = Date.parse(envelope.payload.licenseExpiresAt);
    if (!Number.isFinite(licenseExpiresAt) || licenseExpiresAt <= Date.now()) {
      throw new LicenseProtocolError('LICENSE_EXPIRED', 'Signed license response has expired');
    }
    return envelope.payload;
  }
}
