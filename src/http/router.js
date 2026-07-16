import { randomUUID } from 'node:crypto';
import { AppError } from '../core/app-error.js';
import { assertRole } from '../services/access-control.js';
import { RateLimiter } from './rate-limiter.js';
import { resolveClientIp } from './client-ip.js';

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePath(pattern) {
  const parameterNames = [];
  const segments = pattern.split('/').map((segment) => {
    if (segment.startsWith(':')) {
      parameterNames.push(segment.slice(1));
      return '([^/]+)';
    }
    return escapeRegularExpression(segment);
  });
  return { expression: new RegExp(`^${segments.join('/')}/?$`), parameterNames };
}

function readBearerToken(request) {
  const authorization = request.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1].trim() : null;
}

async function readJsonBody(request, maximumBytes) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    return {};
  }
  const contentLength = Number.parseInt(request.headers['content-length'] || '0', 10);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new AppError('BODY_TOO_LARGE', 'Request body is too large', 413);
  }
  const contentType = String(request.headers['content-type'] || '').split(';')[0].trim();
  if (contentLength > 0 && contentType !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json', 415);
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maximumBytes) {
      throw new AppError('BODY_TOO_LARGE', 'Request body is too large', 413);
    }
    chunks.push(chunk);
  }
  if (totalBytes === 0) {
    return {};
  }
  if (contentType !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json', 415);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('INVALID_JSON', 'Request body is not valid JSON', 400);
  }
}

export function response(status, data, headers = {}) {
  return { httpResponse: true, status, data, headers };
}

export class Router {
  constructor(options) {
    this.authService = options.authService;
    this.config = options.config;
    this.routes = [];
    this.rateLimiter = new RateLimiter(options.securityState);
  }

  add(method, path, options, handler) {
    const compiled = compilePath(path);
    this.routes.push({
      method: method.toUpperCase(),
      path,
      ...compiled,
      options: options || {},
      handler,
    });
  }

  async handle(request, responseStream) {
    const requestId = randomUUID();
    this.#setCommonHeaders(request, responseStream, requestId);
    if (request.method === 'OPTIONS') {
      responseStream.writeHead(204);
      responseStream.end();
      return;
    }

    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      const route = this.routes.find(
        (candidate) => candidate.method === request.method && candidate.expression.test(url.pathname),
      );
      if (!route) {
        throw new AppError('NOT_FOUND', 'Route was not found', 404);
      }

      const match = route.expression.exec(url.pathname);
      const params = Object.fromEntries(route.parameterNames.map((name, index) => [
        name,
        decodeURIComponent(match[index + 1]),
      ]));
      const remoteAddress = resolveClientIp(request, this.config.trustedProxyCidrs);
      if (route.options.rateLimit) {
        await this.rateLimiter.assertAllowed(
          `${remoteAddress}:${route.path}`,
          route.options.rateLimit,
        );
      }

      const token = readBearerToken(request);
      let user = null;
      if (route.options.auth) {
        user = await this.authService.authenticate(token);
        if (route.options.roles) {
          assertRole(user, route.options.roles);
        }
      }

      const body = await readJsonBody(request, this.config.maxBodyBytes);
      const context = {
        request,
        requestId,
        params,
        query: url.searchParams,
        body,
        user,
        token,
      };
      const handlerResult = await route.handler(context);
      const normalized = handlerResult?.httpResponse === true
        ? handlerResult
        : response(200, handlerResult);
      this.#sendJson(responseStream, normalized.status, {
        success: true,
        data: normalized.data,
        requestId,
      }, normalized.headers);
    } catch (error) {
      this.#sendError(responseStream, error, requestId);
    }
  }

  #setCommonHeaders(request, responseStream, requestId) {
    responseStream.setHeader('Content-Type', 'application/json; charset=utf-8');
    responseStream.setHeader('X-Content-Type-Options', 'nosniff');
    responseStream.setHeader('X-Frame-Options', 'DENY');
    responseStream.setHeader('Referrer-Policy', 'no-referrer');
    responseStream.setHeader('Cache-Control', 'no-store');
    responseStream.setHeader('X-Request-Id', requestId);
    if (this.config.corsOrigin) {
      const origin = request.headers.origin;
      if (this.config.corsOrigin === '*' || origin === this.config.corsOrigin) {
        responseStream.setHeader('Access-Control-Allow-Origin', this.config.corsOrigin === '*' ? '*' : origin);
        responseStream.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        responseStream.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      }
    }
  }

  #sendJson(responseStream, status, payload, headers = {}) {
    if (responseStream.headersSent) {
      return;
    }
    for (const [name, value] of Object.entries(headers)) {
      responseStream.setHeader(name, value);
    }
    const serialized = JSON.stringify(payload);
    responseStream.setHeader('Content-Length', Buffer.byteLength(serialized));
    responseStream.writeHead(status);
    responseStream.end(serialized);
  }

  #sendError(responseStream, error, requestId) {
    const knownError = error instanceof AppError;
    if (!knownError) {
      console.error(`[${requestId}]`, error);
    }
    const status = knownError ? error.status : 500;
    const code = knownError ? error.code : 'INTERNAL_ERROR';
    const message = knownError ? error.message : 'An internal server error occurred';
    const payload = {
      success: false,
      error: {
        code,
        message,
        ...(knownError && error.details ? { details: error.details } : {}),
      },
      requestId,
    };
    const headers = (status === 429 || status === 503) && error.details?.retryAfter
      ? { 'Retry-After': String(error.details.retryAfter) }
      : {};
    this.#sendJson(responseStream, status, payload, headers);
  }
}
