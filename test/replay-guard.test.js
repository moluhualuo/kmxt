import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplayGuard } from '../src/security/replay-guard.js';
import { MemorySecurityState, RedisSecurityState } from '../src/security/security-state.js';

// 作者：花落；MIT License。测试覆盖时间边界和跨适配器 Nonce TTL 契约。

class RecordingSecurityState {
  calls = [];

  async consumeNonce(...args) {
    this.calls.push(args);
    return true;
  }
}

test('accepts a future timestamp at the clock-skew boundary and retains the full replay window', async () => {
  const state = new RecordingSecurityState();
  const guard = new ReplayGuard(5, state);
  const now = 1_700_000_000_000;
  const nonce = 'future_nonce_123';

  await guard.assertFresh('activate:app', now + 5_000, nonce, now);

  assert.deepEqual(state.calls, [[
    `activate:app:${nonce}`,
    11_000,
    now,
  ]]);
});

test('retains at least two clock-skew windows for an accepted past timestamp', async () => {
  const state = new RecordingSecurityState();
  const guard = new ReplayGuard(5, state);
  const now = 1_700_000_000_000;

  await guard.assertFresh('verify:app', now - 5_000, 'past_nonce_12345', now);

  assert.equal(state.calls[0][1], 11_000);
});

test('rejects timestamps beyond the future edge before consuming a nonce', async () => {
  const state = new RecordingSecurityState();
  const guard = new ReplayGuard(5, state);

  await assert.rejects(
    () => guard.assertFresh('activate:app', 1_700_000_005_001, 'future_nonce_123', 1_700_000_000_000),
    (error) => error.code === 'STALE_REQUEST',
  );
  assert.equal(state.calls.length, 0);
});

test('memory state blocks nonce replay through the complete future-timestamp window', async () => {
  const state = new MemorySecurityState();
  const guard = new ReplayGuard(2, state);
  const base = 1_700_000_000_000;
  const nonce = 'memory_nonce_123';

  await guard.assertFresh('verify:app', base + 2_000, nonce, base);
  await assert.rejects(
    () => guard.assertFresh('verify:app', base + 4_999, nonce, base + 4_999),
    (error) => error.code === 'REPLAY_DETECTED',
  );

  await guard.assertFresh('verify:app', base + 5_001, nonce, base + 5_001);
});

test('redis state maps the replay TTL to an atomic NX/PX write', async () => {
  const calls = [];
  const state = new RedisSecurityState({ redis: { keyPrefix: 'kmxt:test:' } });
  state.client = {
    async set(...args) {
      calls.push(args);
      return 'OK';
    },
  };

  assert.equal(await state.consumeNonce('verify:app:redis_nonce', 11_000), true);
  assert.deepEqual(calls, [[
    'kmxt:test:nonce:verify:app:redis_nonce',
    '1',
    { NX: true, PX: 11_000 },
  ]]);
});
