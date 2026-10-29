import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSession } from '../src/session-inspect.mjs';
import { HarnessAdapter } from '../src/harness.mjs';

function user(id, text = id) {
  return { role: 'user', source: { kind: 'user', rpcId: id }, content: [{ type: 'text', text }] };
}

function observation({ header = { id: 'session-a', cwd: '/work' }, events = [] } = {}) {
  const lease = {
    header,
    inheritedEventCount: 0,
    events,
    disposed: 0,
    [Symbol.dispose]() { lease.disposed += 1; },
  };
  return lease;
}

test('inspectSession keeps the DSH 0.2.1 sessionController.inspect surface', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const ctx = {
    sessionController: {
      async inspect(sessionId, received) {
        calls.push([sessionId, received]);
        return { meta: { id: sessionId, cwd: '/old' }, events: [] };
      },
    },
    get() { throw new Error('sessionQuery must not be read when inspect exists'); },
  };
  assert.deepEqual(await inspectSession(ctx, 'session-a', signal), {
    meta: { id: 'session-a', cwd: '/old' }, events: [],
  });
  assert.deepEqual(calls, [['session-a', signal]]);
});

test('inspectSession falls back to sessionQuery.observeSession when inspect is gone', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const events = [{ type: 'user/message', seq: 1, data: user('wechat-1') }];
  const lease = observation({ header: { id: 'session-a', cwd: '/new' }, events });
  const ctx = {
    sessionController: {
      async prompt() { throw new Error('prompt is not under test'); },
    },
    get(name) {
      assert.equal(name, 'sessionQuery');
      return {
        async observeSession(sessionId, options) {
          calls.push([sessionId, options]);
          return lease;
        },
      };
    },
  };
  const result = await inspectSession(ctx, 'session-a', signal);
  assert.deepEqual(calls, [['session-a', { signal, projectionMode: 'none' }]]);
  assert.deepEqual(result.meta, { id: 'session-a', cwd: '/new' });
  assert.deepEqual(result.events, events);
  assert.notEqual(result.events, events, 'events are copied out of the lease');
  assert.equal(lease.disposed, 1, 'the lease is released before the read settles');
});

test('inspectSession omits the signal key when no cancellation is supplied', async () => {
  const calls = [];
  const ctx = {
    get() {
      return {
        async observeSession(sessionId, options) {
          calls.push([sessionId, options]);
          return observation();
        },
      };
    },
  };
  await inspectSession(ctx, 'session-a');
  assert.deepEqual(calls, [['session-a', { projectionMode: 'none' }]]);
});

test('inspectSession reports a runtime with neither inspection surface', async () => {
  const ctx = { sessionController: {}, get() { return undefined; } };
  await assert.rejects(inspectSession(ctx, 'session-a'),
    /neither sessionController\.inspect nor sessionQuery\.observeSession/);
});

test('HarnessAdapter.lookupRequest reads the request state through the fallback', async () => {
  const lease = observation({ events: [
    { type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, inserted: [user('wechat-request-1')] } },
  ] });
  const ctx = {
    sessionController: {},
    on() { return () => {}; },
    get(name) { return name === 'sessionQuery' ? { async observeSession() { return lease; } } : undefined; },
  };
  const adapter = new HarnessAdapter(ctx, { cwd: '/work' });
  assert.deepEqual(await adapter.lookupRequest('session-a', 'wechat-request-1'),
    { status: 'pending' });
  assert.equal(lease.disposed, 1);
});
