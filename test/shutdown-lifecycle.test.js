import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../src/app.js';
import { Router } from '../src/http/router.js';

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function mockResponse() {
  return {
    headers: new Map(),
    headersSent: false,
    status: null,
    body: '',
    setHeader(name, value) { this.headers.set(name.toLowerCase(), String(value)); },
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(body = '') { this.body += body; },
  };
}

test('runtime close waits for active HTTP handlers before closing storage', async () => {
  const directory = await mkdtemp(path.join(process.cwd(), '.runtime-shutdown-'));
  const runtime = await createRuntime({
    dataFile: path.join(directory, 'state.json'),
    secretFile: path.join(directory, 'secret.key'),
    port: 0,
    shutdownTimeoutMs: 2_000,
  });
  const entered = deferred();
  const release = deferred();
  const originalHandle = runtime.services.readiness.check;
  runtime.services.readiness.check = async () => {
    entered.resolve();
    await release.promise;
    return originalHandle.call(runtime.services.readiness);
  };

  try {
    const address = await runtime.listen(0, '127.0.0.1');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = fetch(`${baseUrl}/ready`, { headers: { Connection: 'close' } });
    await entered.promise;

    let closeCompleted = false;
    const firstClose = runtime.close().then(() => { closeCompleted = true; });
    const secondClose = runtime.close();
    assert.equal(runtime.isAcceptingRequests(), false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(closeCompleted, false);

    release.resolve();
    const response = await request;
    assert.equal(response.status, 200);
    await Promise.all([firstClose, secondClose]);
    assert.equal(closeCompleted, true);
    assert.equal(runtime.isAcceptingRequests(), false);
  } finally {
    release.resolve();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('router maps closed storage failures to 503', async () => {
  const router = new Router({
    authService: null,
    config: { maxBodyBytes: 1024, trustedProxyCidrs: [], corsOrigin: '' },
    securityState: { async incrementRate() { return { count: 1, retryAfter: 1 }; } },
  });
  router.add('GET', '/storage', {}, async () => { throw new Error('Pool is closed.'); });
  const response = mockResponse();

  await router.handle({ method: 'GET', url: '/storage', headers: { host: 'localhost' }, socket: {} }, response);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '5');
  assert.equal(JSON.parse(response.body).error.code, 'STORAGE_UNAVAILABLE');
});

test('router rejects requests after the shutdown gate closes', async () => {
  const router = new Router({
    authService: null,
    config: { maxBodyBytes: 1024, trustedProxyCidrs: [], corsOrigin: '' },
    securityState: { async incrementRate() { return { count: 1, retryAfter: 1 }; } },
    requestGate: () => false,
  });
  router.add('GET', '/work', {}, async () => ({ ok: true }));
  const response = mockResponse();

  await router.handle({ method: 'GET', url: '/work', headers: { host: 'localhost' }, socket: {} }, response);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '5');
  assert.equal(JSON.parse(response.body).error.code, 'SERVER_SHUTTING_DOWN');
});
