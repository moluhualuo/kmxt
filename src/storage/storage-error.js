const TRANSIENT_STORAGE_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'POOL_CLOSED',
  'POOL_ACQUIRE_TIMEOUT',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_QUIT',
  'PROTOCOL_SEQUENCE_TIMEOUT',
]);

export class StorageUnavailableError extends Error {
  constructor(message = 'Storage service is unavailable', options = {}) {
    super(message, options);
    this.name = 'StorageUnavailableError';
    this.code = 'STORAGE_UNAVAILABLE';
    this.status = 503;
  }
}

export function isStorageUnavailableError(error) {
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (
      current.code === 'STORAGE_UNAVAILABLE'
      || TRANSIENT_STORAGE_CODES.has(current.code)
      || /pool is closed/i.test(String(current.message || ''))
      || /queue limit reached/i.test(String(current.message || ''))
      || /no connections available/i.test(String(current.message || ''))
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export function toStorageUnavailableError(error) {
  if (!isStorageUnavailableError(error)) return error;
  if (error instanceof StorageUnavailableError) return error;
  return new StorageUnavailableError('Storage service is temporarily unavailable', { cause: error });
}
