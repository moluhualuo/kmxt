import { readRequiredSecretFile } from '../storage/secret-file.js';

export class MemorySecurityState {
  #nonces = new Map();
  #limits = new Map();

  async consumeNonce(key, ttlMilliseconds, now = Date.now()) {
    this.#cleanup(now);
    if (this.#nonces.has(key)) return false;
    this.#nonces.set(key, now + ttlMilliseconds);
    return true;
  }

  async incrementRate(key, windowSeconds, now = Date.now()) {
    const current = this.#limits.get(key);
    if (!current || current.resetAt <= now) {
      this.#limits.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { count: 1, retryAfter: windowSeconds };
    }
    current.count += 1;
    return { count: current.count, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }

  #cleanup(now) {
    for (const [key, expiresAt] of this.#nonces) if (expiresAt <= now) this.#nonces.delete(key);
    if (this.#limits.size > 1000) {
      for (const [key, value] of this.#limits) if (value.resetAt <= now) this.#limits.delete(key);
    }
  }

  async close() {}
}

export class RedisSecurityState {
  constructor(config) {
    this.config = config;
    this.client = null;
  }

  async initialize() {
    const { createClient } = await import('redis');
    const password = await readRequiredSecretFile(this.config.redis.passwordFile, 'Redis password');
    this.client = createClient({ url: this.config.redis.url, password });
    this.client.on('error', (error) => console.error('Redis security-state error:', error.message));
    await this.client.connect();
    await this.client.ping();
    return this;
  }

  #key(kind, key) { return `${this.config.redis.keyPrefix}${kind}:${key}`; }

  async consumeNonce(key, ttlMilliseconds) {
    const result = await this.client.set(this.#key('nonce', key), '1', {
      NX: true,
      PX: ttlMilliseconds,
    });
    return result === 'OK';
  }

  async incrementRate(key, windowSeconds) {
    const script = `
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
      local ttl = redis.call('TTL', KEYS[1])
      return {count, ttl}
    `;
    const result = await this.client.eval(script, {
      keys: [this.#key('rate', key)],
      arguments: [String(windowSeconds)],
    });
    return { count: Number(result[0]), retryAfter: Math.max(1, Number(result[1])) };
  }

  async close() {
    if (this.client?.isOpen) await this.client.quit();
  }
}

export async function createSecurityState(config) {
  if (!config.redis.url) {
    if (config.storageDriver === 'mysql') throw new Error('KMXT_REDIS_URL is required with MySQL production storage');
    return new MemorySecurityState();
  }
  return new RedisSecurityState(config).initialize();
}
