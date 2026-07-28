import { AppError } from '../core/app-error.js';
import { requireString } from '../core/validation.js';

const NONCE_TTL_PADDING_MILLISECONDS = 1000;

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
    const earliestAcceptedTimestamp = now - this.clockSkewMilliseconds;
    const latestAcceptedTimestamp = now + this.clockSkewMilliseconds;
    if (timestamp < earliestAcceptedTimestamp || timestamp > latestAcceptedTimestamp) {
      throw new AppError('STALE_REQUEST', 'Request timestamp is outside the allowed clock window', 401);
    }

    // 作者：花落；MIT License。保留完整（含未来时间戳）的窗口，避免边界重放。
    const nonceTtlMilliseconds = Math.max(
      this.clockSkewMilliseconds * 2 + NONCE_TTL_PADDING_MILLISECONDS,
      timestamp + this.clockSkewMilliseconds - now + NONCE_TTL_PADDING_MILLISECONDS,
    );
    const key = `${scope}:${normalizedNonce}`;
    if (!await this.securityState.consumeNonce(key, nonceTtlMilliseconds, now)) {
      throw new AppError('REPLAY_DETECTED', 'The request nonce has already been used', 409);
    }
  }
}
