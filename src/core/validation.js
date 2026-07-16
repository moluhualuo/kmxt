import { AppError } from './app-error.js';

export function requireObject(value, field = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_INPUT', `${field} must be an object`, 400);
  }
  return value;
}

export function requireString(value, field, options = {}) {
  const { min = 1, max = 255, pattern, normalize = true } = options;
  if (typeof value !== 'string') {
    throw new AppError('INVALID_INPUT', `${field} must be a string`, 400);
  }

  const result = normalize ? value.trim() : value;
  if (result.length < min || result.length > max) {
    throw new AppError(
      'INVALID_INPUT',
      `${field} length must be between ${min} and ${max}`,
      400,
    );
  }
  if (pattern && !pattern.test(result)) {
    throw new AppError('INVALID_INPUT', `${field} format is invalid`, 400);
  }
  return result;
}

export function optionalString(value, field, options = {}) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return requireString(value, field, options);
}

export function requireInteger(value, field, options = {}) {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AppError('INVALID_INPUT', `${field} must be an integer between ${min} and ${max}`, 400);
  }
  return value;
}

export function optionalInteger(value, field, options = {}) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return requireInteger(value, field, options);
}

export function requireEnum(value, field, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw new AppError(
      'INVALID_INPUT',
      `${field} must be one of: ${allowedValues.join(', ')}`,
      400,
    );
  }
  return value;
}

export function requireFutureIsoDate(value, field, now = Date.now()) {
  const rawValue = requireString(value, field, { min: 20, max: 40 });
  const timestamp = Date.parse(rawValue);
  if (!Number.isFinite(timestamp) || timestamp <= now) {
    throw new AppError('INVALID_INPUT', `${field} must be a future ISO-8601 date`, 400);
  }
  return new Date(timestamp).toISOString();
}

export function parsePagination(searchParams, maximumLimit = 100) {
  const page = Number.parseInt(searchParams.get('page') || '1', 10);
  const limit = Number.parseInt(searchParams.get('limit') || '20', 10);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > maximumLimit) {
    throw new AppError('INVALID_PAGINATION', `page must be positive and limit must be 1-${maximumLimit}`, 400);
  }
  return { page, limit, offset: (page - 1) * limit };
}
