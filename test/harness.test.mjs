import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessAdapter, NeedsReviewError, inspectRequest } from '../src/harness.mjs';

function event(type, seq, data) { return { type, seq, data }; }
function user(id, text = id) {
  return { role: 'user', source: { kind: 'user', rpcId: id }, content: [{ type: 'text', text }] };
}
function assistant(turn, seq, text, extras = {}) {
  return event('assistant/message', seq, {
    turn, step: 1,
    message: { content: [{ type: 'reasoning', text: 'hidden chain' }, { type: 'text', text }] },
    ...extras,
  });
}
function completed(turn, seq) { return event('turn/end', seq, { turn, reason: { kind: 'completed' } }); }

function fixture() {
  const events = [];
  const listeners = new Set();
  const calls = [];
  const ctx = {
    sessionController: {
      async create(request) { calls.push(['create', request]); return { sessionId: request.sessionId }; },
      async prompt(request, signal) { calls.push(['prompt', request, signal]); return { accepted: true }; },
      cancel(request) { calls.push(['cancel', request]); return { accepted: true }; },
      async inspect() { return { meta: {}, events: [...events] }; },
    },
    on(name, fn) { assert.equal(name, 'session/event'); listeners.add(fn); return () => listeners.delete(fn); },
  };
  const push = (evt, sessionId = 'wechat-1') => {
    events.push(evt);
    for (const listener of listeners) listener({ id: sessionId }, evt);
  };
  return { ctx, events, listeners, calls, push };
}

test('submit uses deterministic requestId with queue mode; create/cancel use SessionController', async () => {
  const { ctx, calls } = fixture();
  const adapter = new HarnessAdapter(ctx, { cwd: '/work', agentPreset: 'ptc' });
  await adapter.createSession('wechat-1');
  const signal = new AbortController().signal;
  await adapter.submit('wechat-1', 'wx-message-1', 'hello', signal);
  await adapter.cancel('wechat-1');
  assert.deepEqual(calls, [
    ['create', { sessionId: 'wechat-1', cwd: '/work', agentPreset: 'ptc' }],
    ['prompt', { sessionId: 'wechat-1', requestId: 'wx-message-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }] }, signal],
    ['cancel', { sessionId: 'wechat-1' }],
  ]);
});

test('submit preserves validated image and staged file content', async () => {
  const { ctx, calls } = fixture();
  const adapter = new HarnessAdapter(ctx, { cwd: '/work' });
  const parts = [{ type: 'text', text: '查看附件' },
    { type: 'image', mediaType: 'image/jpeg', data: '/9j/' },
    { type: 'file', receiptId: 'upload-r1' }];
  await adapter.submit('wechat-1', 'wx-media-1', parts);
  assert.deepEqual(calls[0][1].content, parts);
  assert.throws(() => adapter.submit('wechat-1', 'wx-invalid', [{ type: 'file', receiptId: '' }]), /Invalid prompt/);
});

test('pending and admitted are reconstructed from durable inbox and user source', () => {
  const q = event('agent/inbox/spliced', 0, { target: 'next-turn', start: 0, inserted: [user('wx-1')] });
  assert.deepEqual(inspectRequest([q], 'wx-1'), { status: 'pending' });
  const later = [q,
    event('turn/start', 1, { turn: 1 }),
    event('agent/inbox/spliced', 2, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    event('step/start', 3, { turn: 1, step: 1 }),
    event('user/message', 4, user('wx-1'))];
  assert.deepEqual(inspectRequest(later, 'wx-1'), { status: 'admitted', turn: 1 });
  assert.equal(inspectRequest(later.slice(0, 3), 'wx-1').status, 'needsReview');
  assert.equal(inspectRequest(later, 'different').status, 'unknown');
});

test('wait observes committed turn/end for exact request, ignoring prior web turns and reasoning', async () => {
  const { ctx, events, listeners, push } = fixture();
  events.push(event('turn/start', 0, { turn: 1 }), event('step/start', 1, { turn: 1, step: 1 }),
    event('user/message', 2, user('web-other')), assistant(1, 3, 'Web secret'), completed(1, 4));
  const adapter = new HarnessAdapter(ctx, { cwd: '/work', waitTimeoutMs: 1000 });
  const reply = adapter.waitForReply('wechat-1', 'wx-2');
  push(event('turn/start', 5, { turn: 2 }));
  push(event('step/start', 6, { turn: 2, step: 1 }));
  push(event('user/message', 7, user('wx-2')));
  push(assistant(2, 8, 'intermediate'));
  push(assistant(2, 9, 'Final answer'));
  push(completed(2, 10));
  assert.equal(await reply, 'Final answer');
  assert.equal(listeners.size, 0);
});

test('same turn with another web message fails closed rather than leaking its output', async () => {
  const { ctx, events } = fixture();
  events.push(event('turn/start', 0, { turn: 1 }), event('step/start', 1, { turn: 1, step: 1 }),
    event('user/message', 2, user('wx-1')), event('user/message', 3, user('web-other')),
    assistant(1, 4, 'mixed answer'), completed(1, 5));
  assert.equal(inspectRequest(events, 'wx-1').status, 'needsReview');
  await assert.rejects(new HarnessAdapter(ctx, { cwd: '/work' }).waitForReply('wechat-1', 'wx-1'),
    (error) => error instanceof NeedsReviewError);
});

test('recovery of already completed request returns durable final without resubmit', async () => {
  const { ctx, events, calls } = fixture();
  events.push(event('turn/start', 0, { turn: 3 }), event('step/start', 1, { turn: 3, step: 1 }),
    event('user/message', 2, user('wx-7')), assistant(3, 3, 'delivered'), completed(3, 4));
  const adapter = new HarnessAdapter(ctx, { cwd: '/work' });
  assert.deepEqual(await adapter.lookupRequest('wechat-1', 'wx-7'),
    { status: 'completed', text: 'delivered', reason: 'completed', turn: 3 });
  assert.equal(await adapter.waitForReply('wechat-1', 'wx-7'), 'delivered');
  assert.equal(calls.length, 0);
});

test('aborted or failed turns return summary only', () => {
  const base = [event('turn/start', 0, { turn: 1 }), event('step/start', 1, { turn: 1, step: 1 }),
    event('user/message', 2, user('wx-1')), assistant(1, 3, 'partial', { interrupted: true })];
  assert.equal(inspectRequest([...base, event('turn/end', 4, { turn: 1, reason: { kind: 'aborted' } })], 'wx-1').text,
    '请求已中断。');
  assert.equal(inspectRequest([...base, event('turn/end', 4, {
    turn: 1, reason: { kind: 'error', error: { message: 'network unavailable' } },
  })], 'wx-1').text, '请求失败：network unavailable');
});

test('wait uses bounded lifecycle and cleans listener on timeout and abort', async () => {
  const { ctx, listeners } = fixture();
  const adapter = new HarnessAdapter(ctx, { cwd: '/work', waitTimeoutMs: 15 });
  await assert.rejects(adapter.waitForReply('wechat-1', 'wx-unknown'), { code: 'observation-timeout' });
  assert.equal(listeners.size, 0);
  const stop = new AbortController();
  const pending = adapter.waitForReply('wechat-1', 'wx-unknown', stop.signal);
  stop.abort(new Error('stopped'));
  await assert.rejects(pending, /stopped/);
  assert.equal(listeners.size, 0);
});
