const TOKEN_KEY = 'kmxt.admin.token';

export class ApiError extends Error {
  constructor(code, message, status = 0, details = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError('NETWORK_ERROR', '无法连接授权服务，请检查服务状态。', 0, error.message);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError('INVALID_RESPONSE', '服务返回了无法解析的响应。', response.status);
  }
  if (!response.ok || payload.success !== true) {
    const error = new ApiError(
      payload.error?.code || 'REQUEST_FAILED',
      payload.error?.message || '请求失败。',
      response.status,
      payload.error?.details || null,
    );
    if (response.status === 401 && path !== '/api/v1/auth/login') {
      sessionStorage.removeItem(TOKEN_KEY);
      window.dispatchEvent(new CustomEvent('kmxt:unauthorized'));
    }
    throw error;
  }
  return payload.data;
}

export const api = Object.freeze({
  hasToken: () => Boolean(getToken()),
  setToken: (token) => sessionStorage.setItem(TOKEN_KEY, token),
  clearToken: () => sessionStorage.removeItem(TOKEN_KEY),
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  delete: (path) => request('DELETE', path),
  login: (username, password) => request('POST', '/api/v1/auth/login', { username, password }),
});
