import { AppError } from '../core/app-error.js';

export class RateLimiter {
  constructor(securityState) {
    this.securityState = securityState;
  }

  async assertAllowed(key, options, now = Date.now()) {
    const current = await this.securityState.incrementRate(key, options.windowSeconds, now);
    if (current.count > options.limit) {
      const retryAfter = current.retryAfter;
      throw new AppError('RATE_LIMITED', 'Too many requests', 429, { retryAfter });
    }
  }
}
