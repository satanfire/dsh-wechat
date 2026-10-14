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

test('unknown dispatch outcome discards payload without replay', async t => {
  const f = await fixture(t);
  await f.store.ingest([message('one', 'hello')], 'cursor-one', 'owner');
  await f.store.update(s => { s.sessionId = 'session-one';
    Object.assign(s.inbox[0], { status: 'dispatching', requestId: 'wechat-one', sessionId: 'session-one' }); });
  f.harness.lookupRequest = async () => ({ status: 'unknown' });
  await f.bridge.start();
  await until(() => f.store.snapshot().inbox.length === 0);
  assert.equal(f.calls.submits.length, 0);
  await until(() => f.sends.length === 1);
  assert.match(f.sends[0].text, /DSH 会话中查看/);
  f.push(message('one', 'hello'));
  await until(() => f.store.snapshot().cursor === 'cursor-1');
  assert.equal(f.calls.submits.length, 0);
  assert.deepEqual(f.store.snapshot().inbox, []);
  await f.bridge.stop();
});

test('submission failure discards original request and reports where to inspect it', async t => {
  const f = await fixture(t);
  f.harness.submit = async () => { throw new Error('network failure'); };
  await f.bridge.start(); f.push(message('failed', 'hello'));
  await until(() => f.sends.length === 1);
  assert.deepEqual(f.store.snapshot().inbox, []);
  assert.ok(f.store.snapshot().seen.includes('failed'));
  assert.match(f.sends[0].text, /DSH 会话中查看/);
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
  assert.deepEqual(f.store.snapshot().outbox, []);
  assert.ok(f.store.snapshot().seen.includes('\0outbox-failed\0out-one'));
  await f.bridge.start(); await tick();
  assert.equal(f.sends.length, 1);
  await f.bridge.stop();
});

test('outbound failure is discarded, never sent again automatically', async t => {
  const f = await fixture(t);
  await f.store.enqueue({ id: 'out-one', userId: 'owner', contextToken: 'ctx', text: 'hi' });
  f.client.sendText = async payload => { f.sends.push(payload); throw Error('response lost'); };
  await f.bridge.start();
  await until(() => f.store.snapshot().seen.includes('\0outbox-failed\0out-one'));
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


test('observation timeout drops tracking and processes later input without cancelling DSH', async t => {
  const f = await fixture(t);
  let waits = 0;
  f.harness.waitForReply = async () => {
    if (++waits === 1) throw Object.assign(new Error('observation timeout'), {code:'observation-timeout'});
    return 'next reply';
  };
  await f.bridge.start(); f.push(message('long', 'long task'), message('next', 'next task'));
  await until(() => f.sends.some(item => item.text === 'next reply'));
  assert.equal(waits, 2);
  assert.deepEqual(f.calls.submits.map(item => item.requestId), ['wechat-long', 'wechat-next']);
  assert.deepEqual(f.calls.cancel, []);
  assert.deepEqual(f.store.snapshot().inbox, []);
  assert.match(f.sends.find(item => item.clientId.includes('failure-long')).text, /DSH 会话中查看/);
  f.push(message('long', 'long task'));
  await until(() => f.store.snapshot().cursor === 'cursor-2');
  assert.equal(waits, 2);
});

test('temporary media preparation failure discards descriptors without admission', async t => {
  const f = await fixture(t);
  f.bridge.media = {async prepare() { throw Object.assign(new Error('offline'), {code:'network-error'}); }};
  await f.store.update(state => state.inbox.push({id:'media-offline',userId:'owner',contextToken:'ctx',text:'file',sourceKind:'media',status:'queued',media:[{kind:'file',name:'original.txt'}]}));
  await f.bridge.start();
  await until(() => f.sends.length === 1);
  assert.deepEqual(f.store.snapshot().inbox, []);
  assert.ok(f.store.snapshot().seen.includes('media-offline'));
  assert.match(f.sends[0].text, /尚未提交.*已丢弃/);
  assert.equal(f.calls.submits.length, 0);
});

for (const uncertain of [false, true]) {
  test(`reply failure uncertain=${uncertain} drops suffix and delivers unrelated output`, async t => {
    const f = await fixture(t);
    for (const id of ['wechat-reply-long-0', 'wechat-reply-long-1', 'unrelated']) {
      await f.store.enqueue({id,userId:'owner',contextToken:'ctx',text:id});
    }
    f.client.sendText = async payload => {
      f.sends.push(payload);
      if (payload.clientId === 'wechat-reply-long-0') throw Object.assign(new Error('rejected'), {uncertain});
    };
    await f.bridge.start();
    await until(() => f.store.snapshot().seen.includes('\0outbox\0unrelated'));
    assert.deepEqual(f.sends.map(item => item.clientId), ['wechat-reply-long-0', 'unrelated']);
    assert.deepEqual(f.store.snapshot().outbox, []);
    assert.ok(f.store.snapshot().seen.includes('\0outbox-failed\0wechat-reply-long-1'));
  });
}

test('preparation failure drops duplicate ID but later input still completes', async t => {
  const f = await fixture(t);
  let fail = true;
  f.bridge.outbound = async () => { if (fail) throw new Error('preparation failed'); return () => {}; };
  await f.bridge.start(); f.push(message('failed', 'hello'));
  await until(() => f.sends.length === 1);
  assert.deepEqual(f.store.snapshot().inbox, []);
  fail = false;
  f.push(message('failed', 'hello'), message('next', 'hello again'));
  await until(() => f.sends.some(item => item.text === '回复'));
  assert.deepEqual(f.calls.submits.map(item => item.requestId), ['wechat-next']);
});

for (const status of ['queued', 'dispatching', 'submitted']) {
  test(`reopened ${status} input recovers without duplicate submission`, async t => {
    const f = await fixture(t);
    await f.store.ingest([message('resume', 'hello')], 'saved-cursor', 'owner');
    await f.store.update(s => {
      s.sessionId = 'saved-session';
      Object.assign(s.inbox[0], {status, sessionId:'saved-session', requestId:'wechat-resume'});
    });
    await f.store.close();
    const reopened = await Store.open(f.dir);
    const bridge = new Bridge({store:reopened, client:f.client, harness:f.harness, ownerId:'owner'});
    try {
      f.harness.lookupRequest = async () => ({status:'pending'});
      await bridge.start();
      await until(() => reopened.snapshot().seen.includes('\0outbox\0wechat-reply-resume-0'));
      assert.equal(f.calls.submits.length, status === 'queued' ? 1 : 0);
      assert.equal(f.calls.waits.length, 1);
      assert.equal(reopened.snapshot().sessionId, 'saved-session');
      assert.equal(reopened.snapshot().cursor, 'saved-cursor');
    } finally { await bridge.stop(); await reopened.close(); }
  });
}

for (const text of ['hello', '/new']) {
  test(`session creation failure drops ${text} and later input can create a session`, async t => {
    const f = await fixture(t);
    let attempts = 0;
    f.harness.createSession = async () => {
      if (++attempts === 1) throw new Error('create failed');
      return 'recovered-session';
    };
    await f.bridge.start(); f.push(message('failed-create', text), message('later', 'work'));
    await until(() => f.sends.some(item => item.text === '回复'));
    assert.deepEqual(f.store.snapshot().inbox, []);
    assert.ok(f.store.snapshot().seen.includes('failed-create'));
    assert.match(f.sends[0].text, /已丢弃/);
    assert.deepEqual(f.calls.submits.map(item => item.requestId), ['wechat-later']);
    f.push(message('failed-create', text));
    await until(() => f.store.snapshot().cursor === 'cursor-2');
    assert.equal(attempts, 2);
  });
}

test('failed control is discarded and later input continues', async t => {
  const f = await fixture(t);
  await f.store.update(s => { s.sessionId = 'session-one'; });
  f.harness.cancel = async () => { f.calls.cancel.push('session-one'); throw new Error('cancel failed'); };
  await f.bridge.start(); f.push(message('control', '/stop'), message('later', 'work'));
  await until(() => f.sends.some(item => item.text === '回复') && !f.store.snapshot().inbox.length);
  f.push(message('control', '/stop'));
  await until(() => f.store.snapshot().cursor === 'cursor-2');
  assert.equal(f.calls.cancel.length, 1);
  assert.ok(f.store.snapshot().seen.includes('control'));
});

test('stop waits for in-flight control and removes its terminal payload', async t => {
  const f = await fixture(t);
  const held = deferred();
  await f.store.update(s => { s.sessionId = 'session-one'; });
  f.harness.cancel = async () => { f.calls.cancel.push('session-one'); await held.promise; throw new Error('cancel failed'); };
  await f.bridge.start(); f.push(message('control', '/stop'));
  await until(() => f.store.snapshot().inbox[0]?.status === 'control-pending');
  let stopped = false;
  const stopping = f.bridge.stop().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  held.resolve(); await stopping;
  assert.deepEqual(f.store.snapshot().inbox, []);
  assert.ok(f.store.snapshot().seen.includes('control'));
});


test('legacy failed deliveries and their suffix never send after reopening', async t => {
  const f = await fixture(t);
  await f.store.close();
  const filename = path.join(f.dir, 'store.json');
  const state = JSON.parse(await fs.readFile(filename, 'utf8'));
  state.binding = {ownerId:'owner',botId:'bot',context:{token:'saved-context',receivedAt:123}};
  state.sessionId = 'saved-session'; state.cursor = 'saved-cursor';
  state.outbox = ['failed', 'uncertain', 'cancelled', 'sending'].flatMap(status => [
    {id:`wechat-reply-old-${status}-0`,status,userId:'owner',contextToken:'ctx',text:'failed'},
    {id:`wechat-reply-old-${status}-1`,status:'queued',userId:'owner',contextToken:'ctx',text:'suffix'},
  ]);
  state.outbox.push({id:'independent',status:'queued',userId:'owner',contextToken:'ctx',text:'deliver'});
  await fs.writeFile(filename, JSON.stringify(state));
  const reopened = await Store.open(f.dir);
  const bridge = new Bridge({store:reopened,client:f.client,harness:f.harness,ownerId:'owner'});
  try {
    await bridge.start();
    await until(() => reopened.snapshot().seen.includes('\0outbox\0independent'));
    assert.deepEqual(f.sends.map(item => item.clientId), ['independent']);
    assert.deepEqual(reopened.snapshot().binding, state.binding);
    assert.equal(reopened.snapshot().sessionId, state.sessionId);
    assert.equal(reopened.snapshot().cursor, state.cursor);
    assert.equal(f.calls.submits.length, 0);
  } finally { await bridge.stop(); await reopened.close(); }
});

test('stop cleanup write failure can retry after storage recovers', async t => {
  const f = await fixture(t);
  await f.bridge.start();
  const update = f.store.update.bind(f.store);
  let fail = true;
  f.store.update = async mutator => {
    if (fail) { fail = false; throw new Error('temporary storage failure'); }
    return update(mutator);
  };
  await assert.rejects(f.bridge.stop(), /temporary storage failure/);
  assert.equal(f.bridge.status.running, false);
  assert.equal(f.bridge.connected, false);
  await f.bridge.stop();
  await f.store.enqueue({id:'after-stop',userId:'owner',contextToken:'ctx',text:'ok'});
  await f.bridge.start();
  await until(() => f.store.snapshot().seen.includes('\0outbox\0after-stop'));
  assert.equal(f.sends.length, 1);
});
