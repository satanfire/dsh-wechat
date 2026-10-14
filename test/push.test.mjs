import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Controller } from '../src/controller.mjs';
import { registerLazySender } from '../src/lazy-sender.mjs';
import { enqueuePush, validatePush } from '../src/push.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-push-'));
  const store = await Store.open(directory);
  const controller = new Controller({}, store, { cwd: directory });
  controller.bridge = { status: { running: true }, async stop() {} };
  await store.update(s => { s.enabled = true; s.binding = { ownerId: 'owner', botId: 'bot' }; });
  t.after(async () => { await controller.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, store, controller };
}

const incoming = (id, token, owner = 'owner') => ({ message_id: id, from_user_id: owner,
  message_type: 1, context_token: token, item_list: [{ type: 1, text_item: { text: 'hello' } }] });
const call = (extras = {}) => ({ sessionId: 'web-session', callId: 'call-one', ...extras });

test('owner context survives completed inbox pruning and restart; strangers, replay and invalid tokens cannot replace it', async t => {
  const f = await fixture(t);
  await f.store.ingest([incoming('first', 'token-one')], 'one', 'owner');
  await f.store.update(s => { s.inbox[0].status = 'done'; });
  assert.equal(f.store.snapshot().inbox.length, 0);
  const context = f.store.snapshot().binding.context;
  await f.store.ingest([incoming('first', 'replayed'), incoming('stranger', 'foreign', 'other'),
    incoming('bad', 'bad\nheader'), incoming('too-long', 'x'.repeat(8193))], 'two', 'owner');
  assert.deepEqual(f.store.snapshot().binding.context, context);
  await f.controller.close();
  const reopened = await Store.open(f.directory);
  try {
    assert.equal(reopened.snapshot().binding.context.token, 'token-one');
    await reopened.ingest([incoming('new', 'token-two')], 'three', 'owner');
    assert.equal(reopened.snapshot().binding.context.token, 'token-two');
  } finally { await reopened.close(); }
});

test('push targets only bound owner and returns queue state; repeated call does not send twice', async t => {
  const { store, controller } = await fixture(t);
  await store.ingest([incoming('one', 'private-context')], 'one', 'owner');
  const first = await controller.enqueueText('通知', call());
  assert.equal(first.status, 'queued');
  assert.match(first.id, /^wechat-push-[a-f0-9]{64}$/);
  assert.deepEqual(await controller.enqueueText('通知', call()), first);
  assert.equal(store.snapshot().outbox.length, 1);
  const row = store.snapshot().outbox[0];
  assert.equal(row.userId, 'owner'); assert.equal(row.contextToken, 'private-context');
  assert.equal(row.sourceSessionId, 'web-session');
  assert.equal(JSON.stringify(first).includes('private-context'), false);
  await assert.rejects(controller.enqueueText('different', call()), /调用 ID/);
  await store.update(s => { s.outbox[0].status = 'uncertain'; });
  assert.equal((await controller.enqueueText('通知', call())).status, 'failed');
  assert.equal(store.snapshot().outbox.length, 0);
  const sentCall = call({ callId: 'successful-call' });
  await controller.enqueueText('通知', sentCall);
  await store.update(s => { s.outbox[0].status = 'sent'; });
  assert.equal((await controller.enqueueText('通知', sentCall)).status, 'sent');
  assert.equal(store.snapshot().outbox.length, 0);
});

test('separate sessions and separate tool calls get independent durable ids', async t => {
  const { store, controller } = await fixture(t);
  await store.ingest([incoming('one', 'token')], 'one', 'owner');
  const results = await Promise.all([
    controller.enqueueText('a', call()), controller.enqueueText('b', call({ sessionId: 'another-session' })),
    controller.enqueueText('c', call({ callId: 'another-call' })),
  ]);
  assert.equal(new Set(results.map(r => r.id)).size, 3);
  assert.equal(store.snapshot().outbox.length, 3);
});

test('missing context, stopped bridge, expired login, cancellation and logout fail before enqueuing', async t => {
  const { store, controller } = await fixture(t);
  await assert.rejects(controller.enqueueText('a', call()), /手机/);
  await store.ingest([incoming('one', 'token')], 'one', 'owner');
  const signal = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(controller.enqueueText('a', call({ signal })), /cancelled/);
  controller.bridge.status.running = false;
  await assert.rejects(controller.enqueueText('a', call()), /启动/);
  controller.bridge.status.running = true; controller.bridge.error = 'requires-login';
  await assert.rejects(controller.enqueueText('a', call()), /启动/);
  controller.bridge.error = null;
  controller.ctx = { credentials: { async deleteRecord() {} } };
  await controller.action('logout');
  await assert.rejects(controller.enqueueText('a', call()), /启动/);
  assert.equal(store.snapshot().binding, null); assert.equal(store.snapshot().outbox.length, 0);
});

test('validates unicode length and bounds queue growth', () => {
  for (const text of ['', ' ', 'a\0b', 'x'.repeat(801)]) assert.throws(() => validatePush(text, call()));
  assert.match(validatePush('😀'.repeat(800), call()), /^wechat-push-/);
  const state = { enabled: true, binding: { ownerId: 'owner', context: { token: 'token' } }, seen: [], outbox: [] };
  for (let index = 0; index < 100; index++) enqueuePush(state, {
    id: validatePush('a', call({ callId: `call-${index}` })), text: 'a', sessionId: 'web-session',
  });
  assert.throws(() => enqueuePush(state, { id: validatePush('a', call({callId:'overflow'})), text: 'a', sessionId: 'web-session' }), /已满/);
});

function lazyFixture() {
  const global = new Map(), agents = new Map(), cleanups = [], enqueues = [];
  const ctx = {
    agents: { get(id) { return agents.get(id); } },
    tools: { register(def) { global.set(def.name, def); return () => global.delete(def.name); } },
    effect(fn) { const off = fn(); cleanups.push(off); return off; },
  };
  const controller = { async enqueueText(text, meta) { enqueues.push({ text, ...meta }); return {id:'queued-id',status:'queued'}; } };
  function makeAgent(id) {
    const scoped = new Map(), effects = [];
    const agent = { id, ctx: {
      tools: { register(def) { scoped.set(def.name, def); return () => scoped.delete(def.name); } },
      effect(fn) { const off = fn(); effects.push(off); return off; },
    } };
    agents.set(id, agent);
    return { agent, scoped, dispose() { for (const off of effects) off(); agents.delete(id); } };
  }
  const close = registerLazySender(ctx, controller);
  const exec = (agent, callId = 'load') => ({agent,callId,signal:new AbortController().signal});
  return {global, agents, enqueues, makeAgent, close, exec};
}

test('only tiny loader is present until requested; loading does not notify or expose private data', async () => {
  const f = lazyFixture(), a = f.makeAgent('a'), b = f.makeAgent('b');
  assert.deepEqual([...f.global.keys()], ['load_wechat_tools']);
  assert.equal(a.scoped.size, 0);
  const loader = f.global.get('load_wechat_tools');
  const reply = await loader.execute({}, f.exec(a.agent));
  assert.match(reply, /wechat_send_text/); assert.match(reply, /Parameters:/);
  assert.deepEqual([...a.scoped.keys()], ['wechat_send_text']); assert.equal(b.scoped.size, 0);
  await loader.execute({}, f.exec(a.agent)); assert.equal(a.scoped.size, 1);
  assert.equal(f.enqueues.length, 0);
  assert.deepEqual(a.scoped.get('wechat_send_text').parameters.required, ['text']);
  assert.equal(a.scoped.get('wechat_send_text').parameters.properties.recipient, undefined);
  f.close(); assert.equal(a.scoped.size, 0); assert.equal(f.global.size, 0);
});

test('loaded sender executes only for exact live Agent and respects cancellation and unload', async () => {
  const f = lazyFixture(), a = f.makeAgent('a'), b = f.makeAgent('b');
  const loader = f.global.get('load_wechat_tools');
  await loader.execute({}, f.exec(a.agent));
  const send = a.scoped.get('wechat_send_text');
  await assert.rejects(send.execute({text:'hi'},f.exec(b.agent)),/another session/);
  await assert.rejects(send.execute({text:'hi',recipient:'other'},f.exec(a.agent)),/Expected/);
  await send.execute({text:'hi'},f.exec(a.agent,'send'));
  assert.equal(f.enqueues[0].sessionId,'a'); assert.equal(f.enqueues[0].callId,'send');
  await assert.rejects(loader.execute({}, {...f.exec(b.agent),signal:AbortSignal.abort()}));
  f.close();
  await assert.rejects(send.execute({text:'hi'},f.exec(a.agent)),/live session/);
  assert.equal(f.enqueues.length,1);
});

test('Agent disposal removes full schema; another Agent can load independently', async () => {
  const f = lazyFixture(), a = f.makeAgent('a'), b = f.makeAgent('b');
  const loader = f.global.get('load_wechat_tools');
  await loader.execute({},f.exec(a.agent));
  a.dispose(); assert.equal(a.scoped.size,0);
  await assert.rejects(loader.execute({},f.exec(a.agent)),/live session/);
  await loader.execute({},f.exec(b.agent)); assert.equal(b.scoped.size,1);
  f.close(); assert.equal(b.scoped.size,0);
});


test('controller status omits delivery backlog and uncertain counts', async t => {
  const {store, controller} = await fixture(t);
  await store.enqueue({id:'pending',userId:'owner',contextToken:'token',text:'pending'});
  const status = controller.status();
  assert.equal(Object.hasOwn(status, 'outboxDepth'), false);
  assert.equal(Object.hasOwn(status, 'uncertainCount'), false);
  assert.equal(status.bound, true);
});
