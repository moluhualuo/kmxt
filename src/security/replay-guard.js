import { AppError } from '../core/app-error.js';
import { requireString } from '../core/validation.js';

export class ReplayGuard {
  constructor(clockSkewSeconds, securityState) {
    this.clockSkewMilliseconds = clockSkewSeconds * 1000;
    this.securityState = securityState;
  }

  async assertFresh(scope, timestamp, nonce, now = Date.now()) {
    if (!Number.isSafeInteger(timestamp)) {
      throw new AppError('INVALID_TIMESTAMP', 'timestamp must be a Unix timestamp in milliseconds', 400);
    }
    const normalizedNonce = requireString(nonce, 'nonce', {
      min: 12,
      max: 128,
      pattern: /^[A-Za-z0-9_-]+$/,
    });
    if (Math.abs(now - timestamp) > this.clockSkewMilliseconds) {
      throw new AppError('STALE_REQUEST', 'Request timestamp is outside the allowed clock window', 401);
    }

    const key = `${scope}:${normalizedNonce}`;
    if (!await this.securityState.consumeNonce(key, this.clockSkewMilliseconds, now)) {
      throw new AppError('REPLAY_DETECTED', 'The request nonce has already been used', 409);
    }
  }
}
