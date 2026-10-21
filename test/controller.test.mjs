import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.mjs';
import { ILinkClient } from '../src/ilink.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ statuses = [], getQr, start, stop, profile = 'web', key, sessionController } = {}) {
  const records = new Map();
  const calls = { clients: [], starts: 0, stops: 0, interactions: 0, lists: 0 };
  const state = { enabled: false, sessionId: null, cursor: '', inbox: [], outbox: [], seen: [], binding: null };
  const store = {
    snapshot() { return structuredClone(state); },
    async update(mutator) { return mutator(state); },
    async close() { calls.closed = true; },
  };
  const ctx = {
    credentials: {
      async readRecord(id) { return records.get(id); },
      async modifyRecord(id, fn) { const next = await fn(records.get(id)); records.set(id, next); return next; },
      async deleteRecord(id) { records.delete(id); },
    },
    ...(sessionController ? { sessionController } : {}),
  };
  const factories = {
    client(options) {
      const validated = new ILinkClient(options);
      calls.clients.push(validated.baseUrl);
      return {
        baseUrl: validated.baseUrl,
        async getQr(signal) { return getQr ? getQr(signal) : { qrcode: 'code-1', qrcode_img_content: 'qr-data' }; },
        async getQrStatus(_code, signal) {
          const current = statuses.shift();
          return typeof current === 'function' ? current(signal) : current ?? { status: 'expired' };
        },
      };
    },
    qrDataUrl: async () => 'data:image/png;base64,ZGF0YQ==',
    interactions() { return { async dispose() { calls.interactions++; } }; },
    harness: () => ({}),
    bridge() {
      return {
        connected: true,
        async start() { calls.starts++; if (start) await start(); },
        async stop() { calls.stops++; if (stop) await stop(); },
      };
    },
  };
  const controller = new Controller(ctx, store, {
    cwd: '/work', agentPreset: 'standard', profile,
    ...(key ? { credentialKey: key } : {}),
  }, factories);
  return { controller, store, state, ctx, calls, records };
}

test('profile-separated keys; login persists only validated grant and binding', async () => {
  const a = fixture({ profile: 'alpha', statuses: [{ status: 'confirmed', bot_token: 'token', ilink_user_id: 'owner', ilink_bot_id: 'bot' }] });
  const b = fixture({ profile: 'beta' });
  assert.notEqual(a.controller.key, b.controller.key);
  assert.equal(a.controller.key, 'dsh-wechat/alpha');
  await a.controller.action('login');
  await a.controller.loginTask;
  assert.equal((await a.controller.status()).login.status, 'confirmed');
  assert.deepEqual(a.records.get(a.controller.key), { kind: 'grant', payload: {
    token: 'token', ownerId: 'owner', botId: 'bot', baseUrl: 'https://ilinkai.weixin.qq.com',
  } });
  assert.deepEqual(a.state.binding, { ownerId: 'owner', botId: 'bot' });
  await a.controller.close();
  await b.controller.close();
});

test('rejects invalid credential keys before touching credentials', () => {
  assert.throws(() => fixture({ key: 'dsh-wechat:default' }), /Credential key must be/);
  assert.throws(() => fixture({ key: 'other/default' }), /Credential key must be/);
  assert.throws(() => fixture({ profile: 'UPPER_case' }), /Credential key must be/);
});

test('explicit credentialKey overrides ambient profile; start and logout use same key', async () => {
  const { controller, state, records, calls } = fixture({ key: 'dsh-wechat/custom' });
  state.binding = { ownerId: 'owner' };
  records.set(controller.key, { kind: 'grant', payload: {
    token: 'token', ownerId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com',
  } });
  await controller.action('start');
  assert.equal(calls.starts, 1);
  assert.equal(state.enabled, true);
  await controller.action('logout');
  assert.equal(calls.stops, 1);
  assert.equal(records.has(controller.key), false);
  assert.equal(state.binding, null);
  await controller.close();
});

test('safe QR redirect uses allowlisted HTTPS hostname and rejects other hosts', async () => {
  const safe = fixture({ statuses: [
    { status: 'wait', redirect_host: 'other.weixin.qq.com' },
    { status: 'confirmed', bot_token: 'token', ilink_user_id: 'owner' },
  ] });
  await safe.controller.action('login');
  await safe.controller.loginTask;
  assert.ok(safe.calls.clients.includes('https://other.weixin.qq.com'));
  await safe.controller.close();
  const evil = fixture({ statuses: [{ status: 'wait', redirect_host: 'https://evil.example' }] });
  await evil.controller.action('login');
  await evil.controller.loginTask;
  assert.equal(evil.records.size, 0);
  assert.equal((await evil.controller.status()).login.status, 'error');
  await evil.controller.close();
});

test('stop aborts and joins in-flight QR poll; close is idempotent', async () => {
  const entered = deferred();
  const f = fixture({ statuses: [(signal) => {
    entered.resolve();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }] });
  await f.controller.action('login');
  await entered.promise;
  await f.controller.action('stop');
  assert.equal((await f.controller.status()).login.status, 'idle');
  const first = f.controller.close();
  assert.strictEqual(first, f.controller.close());
  await first;
  assert.equal(f.calls.closed, true);
  await assert.rejects(f.controller.action('start'), /已关闭/);
});

test('invalid login grant never reaches credentials; expired QR has no pending login', async () => {
  const invalid = fixture({ statuses: [{ status: 'confirmed', bot_token: 'token\rsecret', ilink_user_id: 'owner' }] });
  await invalid.controller.action('login');
  await invalid.controller.loginTask;
  assert.equal(invalid.records.size, 0);
  assert.equal((await invalid.controller.status()).login.status, 'error');
  await invalid.controller.close();
  const expired = fixture({ statuses: [{ status: 'expired' }] });
  await expired.controller.action('login');
  await expired.controller.loginTask;
  assert.equal((await expired.controller.status()).login.status, 'expired');
  await expired.controller.close();
});

test('bridge constructor failure disposes interactions', async () => {
  const { controller, state, records, calls } = fixture();
  state.binding = { ownerId: 'owner' };
  records.set(controller.key, { kind: 'grant', payload: {
    token: 'token', ownerId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com',
  } });
  controller.makeBridge = () => { throw new Error('construction failed'); };
  await assert.rejects(controller.action('start'), /construction failed/);
  assert.equal(calls.interactions, 1);
  assert.equal(state.enabled, false);
  await controller.close();
});

test('failed bridge stop still disposes interactions and retains handle for retry', async () => {
  const f = fixture();
  let failures = 1;
  f.controller.bridge = { async stop() { if (failures-- > 0) throw new Error('stop failed'); } };
  f.controller.interactions = { async dispose() { f.calls.interactions++; } };
  await assert.rejects(f.controller.stop(), /stop failed/);
  assert.equal(f.calls.interactions, 1);
  assert.ok(f.controller.bridge);
  assert.equal(f.controller.interactions, null);
  await f.controller.close();
});

test('failing bridge startup disposes bridge and interactions without enabling store', async () => {
  const { controller, state, records, calls } = fixture({ start: async () => { throw new Error('startup failure'); } });
  state.binding = { ownerId: 'owner' };
  records.set(controller.key, { kind: 'grant', payload: {
    token: 'token', ownerId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com',
  } });
  await assert.rejects(controller.action('start'), /startup failure/);
  assert.equal(state.enabled, false);
  assert.equal(calls.stops, 1);
  assert.equal(calls.interactions, 1);
  await controller.close();
});

test('status reports the bound Session title and caches the lookup', async () => {
  let lists = 0;
  const items = [{ sessionId: 'session-a', projections: { values: { title: '  修登录  ' } } }];
  // `sessionController.list` answers `{ items }`, not a bare array.
  const f = fixture({ sessionController: { async list() { lists++; return { items }; } } });
  f.state.sessionId = 'session-a';
  const status = await f.controller.status();
  assert.equal(status.sessionId, 'session-a');
  assert.equal(status.sessionTitle, '修登录');
  assert.equal(lists, 1);
  // The settings page polls every second; the second poll must reuse the cache.
  await f.controller.status();
  assert.equal(lists, 1);
  items[0].projections.values.title = '已改名';
  f.controller.titleCache = null;
  assert.equal((await f.controller.status()).sessionTitle, '已改名');
  await f.controller.close();
});

test('status tolerates missing, deleted, untitled, and failing Session lookups', async () => {
  const plain = fixture();
  plain.state.sessionId = 'session-x';
  assert.equal((await plain.controller.status()).sessionTitle, null);
  await plain.controller.close();

  const deleted = fixture({ sessionController: { async list() { return { items: [] }; } } });
  deleted.state.sessionId = 'session-gone';
  assert.equal((await deleted.controller.status()).sessionTitle, null);
  await deleted.controller.close();

  const untitled = fixture({ sessionController: { async list() { return { items: [{ sessionId: 'session-z' }] }; } } });
  untitled.state.sessionId = 'session-z';
  assert.equal((await untitled.controller.status()).sessionTitle, null);
  await untitled.controller.close();

  // A bare list stays accepted even though the Host contract wraps it in `items`.
  const bare = fixture({ sessionController: { async list() { return [{ sessionId: 'session-b', projections: { values: { title: '裸列表' } } }]; } } });
  bare.state.sessionId = 'session-b';
  assert.equal((await bare.controller.status()).sessionTitle, '裸列表');
  await bare.controller.close();

  let lists = 0;
  const failing = fixture({ sessionController: { async list() { lists++; throw new Error('runtime down'); } } });
  failing.state.sessionId = 'session-y';
  const status = await failing.controller.status();
  assert.equal(status.sessionId, 'session-y');
  assert.equal(status.sessionTitle, null);
  assert.equal(lists, 1);
  await failing.controller.close();
});
