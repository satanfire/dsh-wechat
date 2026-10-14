import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Bridge } from '../src/bridge.mjs';
import { Store } from '../src/store.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(fn, ms = 2500) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw Error('timed out waiting for test condition'); await tick(); }
}
function message(id, text, from = 'owner') {
  return { message_type: 1, from_user_id: from, message_id: id, context_token: 'ctx',
    item_list: [{ type: 1, text_item: { text } }] };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-bridge-'));
  const store = await Store.open(dir);
  const updates = [];
  const sends = [];
  const pending = [];
  const client = {
    getUpdates: async (_cursor, signal) => {
      if (updates.length) return updates.shift();
      const d = deferred(); pending.push(d);
      signal.addEventListener('abort', () => d.reject(Error('poll aborted')), { once: true });
      return d.promise;
    },
    sendText: async (payload) => { sends.push(payload); },
  };
  const calls = { create: 0, submits: [], cancel: [], lookup: [], waits: [] };
  const harness = {
    async createSession() { calls.create++; return 'session-one'; },
    async submit(sessionId, requestId, text) { calls.submits.push({ sessionId, requestId, text }); },
    async lookupRequest(sessionId, requestId) { calls.lookup.push({ sessionId, requestId }); return { status: 'completed' }; },
    async waitForReply(sessionId, requestId) { calls.waits.push({ sessionId, requestId }); return '回复'; },
    async cancel(sessionId) { calls.cancel.push(sessionId); },
  };
  let serial = 0;
  const push = (...msgs) => {
    const batch = { msgs, get_updates_buf: `cursor-${++serial}` };
    if (pending.length) pending.shift().resolve(batch); else updates.push(batch);
  };
  const bridge = new Bridge({ store, client, harness, ownerId: 'owner' });
  t.after(async () => { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, store, client, harness, calls, sends, push, bridge };
}

test('owner prompt is durably admitted and answered exactly once; duplicate poll ignored', async t => {
  const f = await fixture(t);
  await f.bridge.start(); f.push(message('one', 'hello'), message('other', 'no', 'stranger'));
  await until(() => f.sends.length === 1);
  assert.deepEqual(f.calls.submits, [{ sessionId: 'session-one', requestId: 'wechat-one', text: 'hello' }]);
  assert.deepEqual(f.sends[0], { userId: 'owner', contextToken: 'ctx', text: '回复', clientId: 'wechat-reply-one-0' });
  f.push(message('one', 'hello'));
  await until(() => f.store.snapshot().cursor === 'cursor-2');
  assert.equal(f.calls.submits.length, 1);
  assert.equal(f.sends.length, 1);
  await f.bridge.stop();
});

test('/stop bypasses an active prompt waiting for its answer', async t => {
  const f = await fixture(t);
  const held = deferred();
  f.harness.waitForReply = async () => held.promise;
  await f.bridge.start(); f.push(message('first', 'long task'));
  await until(() => f.calls.submits.length === 1);
  f.push(message('stop', '/stop'));
  await until(() => f.calls.cancel.length === 1);
  assert.deepEqual(f.calls.cancel, ['session-one']);
  assert.equal(f.calls.submits.length, 1);
  held.resolve('请求已中断。');
  await until(() => f.sends.some(s => s.clientId === 'wechat-reply-stop-0'));
  await f.bridge.stop();
});

test('unknown dispatch outcome retains recoverable record without replay', async t => {
  const f = await fixture(t);
  await f.store.ingest([message('one', 'hello')], 'cursor-one', 'owner');
  await f.store.update(s => { s.sessionId = 'session-one';
    Object.assign(s.inbox[0], { status: 'dispatching', requestId: 'wechat-one', sessionId: 'session-one' }); });
  f.harness.lookupRequest = async () => ({ status: 'unknown' });
  await f.bridge.start();
  await until(() => f.store.snapshot().inbox[0]?.status === 'needs-review');
  assert.equal(f.calls.submits.length, 0);
  await until(() => f.sends.length === 1);
  assert.match(f.sends[0].text, /避免重复执行/);
  f.push(message('one', 'hello'));
  await until(() => f.store.snapshot().cursor === 'cursor-1');
  assert.equal(f.calls.submits.length, 0);
  assert.equal(f.store.snapshot().inbox[0].status, 'needs-review');
  await f.bridge.stop();
});

test('submission failure retains original request and user feedback', async t => {
  const f = await fixture(t);
  f.harness.submit = async () => { throw new Error('network failure'); };
  await f.bridge.start(); f.push(message('failed', 'hello'));
  await until(() => f.sends.length === 1);
  assert.equal(f.store.snapshot().inbox[0].status, 'needs-review');
  assert.ok(f.store.snapshot().seen.includes('failed'));
  assert.match(f.sends[0].text, /避免重复执行/);
});

test('known dispatching outcome resumes without submitting a second prompt', async t => {
  const f = await fixture(t);
  await f.store.ingest([message('one', 'hello')], 'cursor-one', 'owner');
  await f.store.update(s => { s.sessionId = 'session-one';
    Object.assign(s.inbox[0], { status: 'dispatching', requestId: 'wechat-one', sessionId: 'session-one' }); });
  await f.bridge.start(); await until(() => f.sends.length === 1);
  assert.equal(f.calls.submits.length, 0);
  assert.equal(f.calls.lookup.length, 1);
  await f.bridge.stop();
});

test('interrupted sending is not automatically replayed after restart', async t => {
  const f = await fixture(t);
  await f.store.enqueue({ id: 'out-one', userId: 'owner', contextToken: 'ctx', text: 'hi' });
  const held = deferred();
  f.client.sendText = async payload => { f.sends.push(payload); await held.promise; };
  await f.bridge.start(); await until(() => f.sends.length === 1);
  const closing = f.bridge.stop();
  held.resolve(); await closing;
  assert.equal(f.store.snapshot().outbox[0].status, 'sending');
  await f.bridge.start(); await tick();
  assert.equal(f.sends.length, 1);
  await f.bridge.stop();
});

test('outbound failure is marked uncertain, never sent again automatically', async t => {
  const f = await fixture(t);
  await f.store.enqueue({ id: 'out-one', userId: 'owner', contextToken: 'ctx', text: 'hi' });
  f.client.sendText = async payload => { f.sends.push(payload); throw Error('response lost'); };
  await f.bridge.start();
  await until(() => f.store.snapshot().outbox[0]?.status === 'uncertain');
  assert.equal(f.sends.length, 1);
  await f.bridge.stop();
  await f.bridge.start(); await tick();
  assert.equal(f.sends.length, 1);
  await f.bridge.stop();
});

test('media input submits attachment content and installs outbound only for task lifetime', async t => {
  const f = await fixture(t);
  let installed = 0, disposed = 0;
  const parts = [{ type: 'text', text: '分析' }, { type: 'file', receiptId: 'r1' }];
  f.bridge.media = { async prepare(item, sessionId) { assert.equal(item.media.length, 1); assert.equal(sessionId, 'session-one'); return parts; } };
  f.bridge.outbound = async () => { installed++; return () => { disposed++; }; };
  const key = Buffer.alloc(16).toString('base64');
  await f.bridge.start();
  f.push({ message_type: 1, from_user_id: 'owner', message_id: 'media', context_token: 'ctx',
    item_list: [{ type: 4, file_item: { file_name: 'a.txt', len: '4', media: { encrypt_query_param: 'p', aes_key: key } } }] });
  await until(() => disposed === 1 && f.sends.length === 1);
  assert.deepEqual(f.calls.submits[0].text, parts);
  assert.equal(installed, 1);
});

test('media preparation failure does not dispatch or lose attachment notice', async t => {
  const f = await fixture(t);
  f.bridge.media = { async prepare() { throw new RangeError('too large'); } };
  await f.store.update(s => { s.inbox.push({ id:'bad-media', userId:'owner', contextToken:'ctx', text:'附件', sourceKind:'media', status:'queued', media:[{kind:'file'}] }); });
  await f.bridge.start();
  await until(() => f.sends.some(x => x.text.includes('附件处理失败')));
  assert.equal(f.calls.submits.length,0);
});

test('durable media outbox sends immutable attachment bytes instead of text', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('video bytes');
  f.bridge.attachments = { async *readFileStream(ref) { assert.equal(ref.attachmentId,'a'); yield bytes; } };
  f.client.sendMedia = async payload => { f.sends.push(payload); };
  await f.store.update(s => s.outbox.push({id:'media-send',userId:'owner',contextToken:'ctx',text:'',status:'queued',media:{kind:'video',name:'v.mp4',attachment:{attachmentId:'a'}}}));
  await f.bridge.start(); await until(() => f.sends.length===1);
  assert.equal(f.sends[0].kind,'video'); assert.deepEqual(f.sends[0].bytes,bytes);
});

test('stop waits in-flight send and poll before reporting stopped', async t => {
  const f = await fixture(t);
  await f.store.enqueue({ id: 'out-one', userId: 'owner', contextToken: 'ctx', text: 'hi' });
  const held = deferred();
  f.client.sendText = async () => held.promise;
  await f.bridge.start();
  await until(() => f.store.snapshot().outbox[0]?.status === 'sending');
  let finished = false;
  const stop = f.bridge.stop().then(() => { finished = true; });
  await tick(); assert.equal(finished, false);
  held.resolve(); await stop;
  assert.equal(f.bridge.status.running, false);
});


test('observation timeout retains submitted tracking and eventually forwards reply', async t => {
  const f = await fixture(t);
  let waits = 0;
  f.harness.waitForReply = async () => {
    if (++waits === 1) throw Object.assign(new Error('observation timeout'), {code:'observation-timeout'});
    return 'eventual reply';
  };
  await f.bridge.start(); f.push(message('long', 'long task'));
  await until(() => waits === 1);
  assert.equal(f.store.snapshot().inbox[0].status, 'submitted');
  await until(() => f.sends.some(item => item.text === 'eventual reply'), 4000);
  assert.equal(f.calls.submits.length, 1);
});


test('temporary media preparation failure retains original descriptors for recovery', async t => {
  const f = await fixture(t);
  f.bridge.media = {async prepare() { throw Object.assign(new Error('offline'), {code:'network-error'}); }};
  await f.store.update(state => state.inbox.push({id:'media-offline',userId:'owner',contextToken:'ctx',text:'file',sourceKind:'media',status:'queued',media:[{kind:'file',name:'original.txt'}]}));
  await f.bridge.start();
  await until(() => f.store.snapshot().inbox[0]?.status === 'failed');
  assert.equal(f.store.snapshot().inbox[0].failure.stage, 'prepare');
  assert.equal(f.store.snapshot().inbox[0].media[0].name, 'original.txt');
  assert.equal(f.calls.submits.length, 0);
});

test('definite reply rejection marks failed and cancels unsent suffix', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 2; index++) await f.store.enqueue({id:`wechat-reply-long-${index}`,userId:'owner',contextToken:'ctx',text:`part ${index}`});
  f.client.sendText = async payload => { f.sends.push(payload); throw Object.assign(new Error('rejected'), {uncertain:false}); };
  await f.bridge.start();
  await until(() => f.store.snapshot().outbox[0]?.status === 'failed');
  assert.equal(f.store.snapshot().outbox.length, 1);
  assert.equal(f.sends.length, 1);
});


test('retry after preparation failure uses a distinct final-reply delivery ID', async t => {
  const f = await fixture(t);
  let fail = true;
  f.bridge.outbound = async () => { if (fail) throw new Error('preparation failed'); return () => {}; };
  await f.bridge.start(); f.push(message('retryable', 'hello'));
  await until(() => f.sends.length === 1);
  await f.bridge.stop();
  fail = false;
  await f.store.update(state => { state.inbox[0].status = 'queued'; delete state.inbox[0].failure; });
  await f.bridge.start();
  await until(() => f.sends.length === 2);
  assert.notEqual(f.sends[0].clientId, f.sends[1].clientId);
  assert.equal(f.sends[1].text, '回复');
});
