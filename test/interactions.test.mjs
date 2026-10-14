import assert from 'node:assert/strict';
import test from 'node:test';
import { Interactions } from '../src/interactions.mjs';

function fixture(t, options = {}) {
  const listeners = new Map();
  const state = { enabled: true, binding: { ownerId: 'owner' }, inbox: [
    { id: 'in-1', status: 'submitted', sessionId: 's1', requestId: 'wx-1', userId: 'owner', contextToken: 'ctx' },
  ], outbox: [] };
  let chain = Promise.resolve();
  const store = {
    snapshot: () => structuredClone(state),
    update(fn) { const work = chain.then(() => fn(state)); chain = work.catch(() => {}); return work; },
    enqueue(entry) { return this.update(s => { s.outbox.push({ ...entry, status: 'queued' }); return true; }); },
  };
  const events = [
    {type:'turn/start',seq:0,data:{turn:1}},
    {type:'step/start',seq:1,data:{turn:1,step:1}},
    {type:'user/message',seq:2,data:{source:{kind:'user',rpcId:'wx-1'}}},
    {type:'tool/call',seq:3,data:{turn:1,step:1,callId:'approval-call',name:'bash',arguments:'{"command":"echo hello"}'}},
    {type:'tool/call',seq:4,data:{turn:1,step:1,callId:'question-call',name:'ask_user_question',arguments:'{}'}},
  ];
  const ctx = { sessionController: { async inspect() { return { events }; } }, on(name, fn, opts) {
    assert.equal(opts.global, true);
    listeners.set(name, fn);
    return () => listeners.delete(name);
  } };
  const bridge = new Interactions(ctx, { store, ...options });
  t.after(() => bridge.dispose());
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const nonce = () => state.outbox.at(-1).id.slice('interaction:'.length);
  const approval = (extra = {}, next = () => { throw new Error('unexpected fallback'); }) => listeners.get('approval/request')({ agent: { id: 's1' }, toolName: 'bash', callId: 'approval-call', reason: 'write files', ...extra }, next);
  const question = (questions, extra = {}) => listeners.get('user-questions/request')({ agent: { id: 's1' }, wait:{callId:'question-call'}, questions, ...extra }, () => { throw new Error('unexpected fallback'); });
  const answer = (text, extra = {}) => bridge.answer({ userId: 'owner', text, ...extra });
  return { bridge, state, events, listeners, flush, nonce, approval, question, answer };
}

test('approval prompts durable owner outbox, allows once, consumes nonce, preserves signal', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const result = f.approval({ signal: controller.signal });
  await f.flush();
  const prompt = f.state.outbox[0];
  assert.equal(prompt.userId, 'owner');
  assert.equal(prompt.contextToken, 'ctx');
  assert.match(prompt.text, /bash/);
  assert.match(prompt.text, /write files/);
  const nonce = f.nonce();
  assert.match(nonce, /^[a-f0-9]{32}$/);
  assert.equal((await f.answer(`/approve ${nonce}`)).accepted, true);
  assert.equal(await result, 'allowed-once');
  assert.equal(controller.signal.aborted, false);
  assert.equal(prompt.status, 'cancelled');
  assert.equal((await f.answer(`/approve ${nonce}`)).accepted, false);
});

test('reject, invalid syntax, foreign user/session, and plain strings cannot grant', async t => {
  const f = fixture(t);
  const pending = f.approval();
  await f.flush();
  const nonce = f.nonce();
  for (const [text, extra] of [
    [`/approve ${nonce}`, { userId: 'stranger' }],
    [`/approve ${nonce}`, { sessionId: 'other' }],
    [`/approve ${nonce} yes`, {}], [`/answer ${nonce} 1`, {}],
  ]) assert.equal((await f.answer(text, extra)).accepted, false);
  assert.equal((await f.bridge.answer(`/approve ${nonce}`)).handled, false);
  assert.equal((await f.answer(`/reject ${nonce}`)).accepted, true);
  assert.equal(await pending, 'rejected');
});

test('unowned, disabled and no-agent requests delegate without overriding policy', async t => {
  const f = fixture(t);
  let calls = 0;
  const next = async () => { calls++; return 'unavailable'; };
  assert.equal(await f.approval({ agent: { id: 'other' } }, next), 'unavailable');
  assert.equal(await f.approval({ agent: undefined }, next), 'unavailable');
  f.state.enabled = false;
  assert.equal(await f.approval({}, next), 'unavailable');
  f.state.enabled = true;
  f.state.inbox[0].status = 'done';
  assert.equal(await f.approval({}, next), 'unavailable');
  assert.equal(calls, 4);
  assert.equal(f.state.outbox.length, 0);
});

test('abort cancels approvals and rejects questions; stale queued prompts cancelled', async t => {
  const f = fixture(t);
  const ac = new AbortController();
  const approval = f.approval({ signal: ac.signal });
  await f.flush();
  const nonce = f.nonce();
  ac.abort();
  assert.equal(await approval, 'cancelled');
  assert.equal((await f.answer(`/approve ${nonce}`)).accepted, false);
  assert.equal(f.state.outbox[0].status, 'cancelled');
  const qc = new AbortController();
  const question = f.question([{ id: 'q', question: 'why?' }], { signal: qc.signal });
  const rejection = assert.rejects(question, { name: 'AbortError' });
  qc.abort();
  await rejection;
});

test('questions validate choices, rotate nonce, and collect sequential multi/custom answers', async t => {
  const f = fixture(t);
  const result = f.question([
    { id: 'q1', question: 'choose', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'q2', question: 'multi', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
    { id: 'q3', question: 'custom' },
  ]);
  await f.flush();
  const n1 = f.nonce();
  for (const bad of ['0', '3', '1,2', '1,1', 'text:']) assert.equal((await f.answer(`/answer ${n1} ${bad}`)).accepted, false);
  assert.equal((await f.answer(`/answer ${n1} 2`)).accepted, true);
  await f.flush();
  const n2 = f.nonce();
  assert.notEqual(n1, n2);
  assert.equal((await f.answer(`/answer ${n1} 1`)).accepted, false);
  assert.equal((await f.answer(`/answer ${n2} 2,1`)).accepted, true);
  await f.flush();
  assert.equal((await f.answer(`/answer ${f.nonce()} text: 123`)).accepted, true);
  assert.deepEqual(await result, { answers: [
    { id: 'q1', selected: ['B'] }, { id: 'q2', selected: ['Y', 'X'] },
    { id: 'q3', selected: [], custom: '123' },
  ] });
});

test('dispose settles both kinds and removes listeners; timeout rejects late replies', async t => {
  const f = fixture(t);
  const a = f.approval();
  const q = f.question([{ id: 'q', question: '?' }]);
  const rejected = assert.rejects(q, { name: 'AbortError' });
  await f.flush();
  const nonce = f.nonce();
  await f.bridge.dispose();
  await rejected;
  assert.equal(await a, 'cancelled');
  assert.equal(f.listeners.size, 0);
  assert.equal((await f.answer(`/answer ${nonce} x`)).accepted, false);
  const timed = fixture(t, { timeoutMs: 5 });
  const pending = timed.approval();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await pending, 'cancelled');
  assert.equal((await timed.answer(`/approve ${timed.nonce()}`)).accepted, false);
});

test('ownership ending rejects answer and cancels request', async t => {
  const f = fixture(t);
  const result = f.approval();
  await f.flush();
  f.state.inbox[0].status = 'done';
  assert.equal((await f.answer(`/approve ${f.nonce()}`)).accepted, false);
  assert.equal(await result, 'cancelled');
});


test('Web or mixed-turn approvals delegate even with a submitted WeChat row', async t => {
  const f = fixture(t);
  f.events[2].data.source.rpcId = 'web-request';
  assert.equal(await f.approval({}, async () => 'web'), 'web');
  f.events[2].data.source.rpcId = 'wx-1';
  f.events.push({type:'user/message',seq:5,data:{source:{kind:'user',rpcId:'web-request'}}});
  assert.equal(await f.approval({}, async () => 'web'), 'web');
  assert.equal(f.state.outbox.length, 0);
});

test('phone approval includes full concrete arguments; unknown/oversized calls delegate', async t => {
  const f = fixture(t);
  const pending = f.approval();
  await f.flush();
  assert.match(f.state.outbox[0].text, /echo hello/);
  assert.equal((await f.answer(`/reject ${f.nonce()}`)).accepted, true);
  assert.equal(await pending, 'rejected');
  assert.equal(await f.approval({callId:undefined}, async () => 'web'), 'web');
  f.events[3].data.arguments = 'x'.repeat(501);
  assert.equal(await f.approval({}, async () => 'web'), 'web');
});
