import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { Store } from '../src/store.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (!fn()) { if (Date.now() > deadline) throw Error('test condition timeout'); await sleep(5); }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function aborted(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
const message = (id, text, context_token = 'context') => ({ message_id: id, message_type: 1,
  from_user_id: 'owner', context_token, item_list: [{ type: 1, text_item: { text } }] });
async function fixture(t, { sendTyping, submit, waitForReply, timeoutMs = 50 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-feedback-'));
  const store = await Store.open(dir);
  const batches = [], sends = [], typing = [], calls = [];
  let poll;
  const client = {
    async getUpdates(_cursor, signal) {
      if (batches.length) return batches.shift();
      poll = deferred();
      return Promise.race([poll.promise, aborted(signal)]);
    },
    async sendText(payload) { sends.push(payload); },
    async sendTyping(payload, signal) { typing.push(payload.typing); return sendTyping?.(payload, signal); },
  };
  const harness = {
    async createSession(sessionId) { return { sessionId }; },
    async submit(...args) { calls.push(args); return submit?.(...args); },
    async lookupRequest() { return { status: 'admitted' }; },
    async waitForReply(...args) { return waitForReply ? waitForReply(...args) : 'done'; },
    async cancel() {},
  };
  const bridge = new Bridge({ store, client, harness, ownerId: 'owner', typingIntervalMs: 15, typingTimeoutMs: timeoutMs, prepareRetryDelaysMs: [] });
  const push = (...msgs) => {
    const value = { msgs, get_updates_buf: `cursor-${Date.now()}` };
    if (poll) { const old = poll; poll = null; old.resolve(value); } else batches.push(value);
  };
  t.after(async () => { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { bridge, store, client, harness, sends, typing, calls, push };
}

test('typing replaces receipt text; duplicate polling and restart never duplicate admission', async t => {
  const f = await fixture(t, { waitForReply: (_sid, _id, signal) => aborted(signal) });
  await f.bridge.start(); f.push(message('one', 'work'));
  await until(() => f.calls.length === 1 && f.typing.includes(true));
  assert.equal(f.sends.length, 0);
  f.push(message('one', 'work'));
  await sleep(160);
  await f.bridge.stop();
  f.harness.waitForReply = async () => 'done';
  await f.bridge.start();
  await until(() => f.sends.some(x => x.text === 'done'));
  assert.deepEqual(f.sends.map(x => x.text), ['done']);
  assert.equal(f.calls.length, 1);
});

test('queued input waits behind the active task without sending receipt text', async t => {
  const f = await fixture(t, { waitForReply: (_sid, _id, signal) => aborted(signal) });
  await f.bridge.start(); f.push(message('first', 'long task'));
  await until(() => f.calls.length === 1 && f.typing.includes(true));
  f.push(message('second', 'later task'));
  await until(() => f.store.snapshot().inbox.some(x => x.id === 'second'));
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.snapshot().inbox.find(x => x.id === 'second').status, 'queued');
  assert.equal(f.sends.length, 0);
});

test('slash commands and absent/invalid context tokens do not generate typing or receipts', async t => {
  const f = await fixture(t);
  await f.store.ingest([message('stop', '/stop'), message('new', '/new'), message('empty', 'hello', ''), message('invalid', 'hello', 'x\ny')], 'c', 'owner');
  await f.bridge.start();
  await until(() => !f.store.snapshot().inbox.length);
  assert.equal(f.sends.filter(x => x.clientId.startsWith('wechat-received-')).length, 0);
  assert.equal(f.typing.length, 0);
});

test('upgrade cancels legacy queued receipts but preserves final replies', async t => {
  const f = await fixture(t);
  await f.store.enqueue({ id: 'wechat-received-old', userId: 'owner', contextToken: 'context', text: '收到，正在处理。' });
  await f.store.enqueue({ id: 'wechat-reply-old-0', userId: 'owner', contextToken: 'context', text: 'final reply' });
  await f.bridge.start();
  await until(() => f.sends.length === 1);
  assert.equal(f.sends[0].text, 'final reply');
  assert.ok(f.store.snapshot().seen.includes('\0outbox-failed\0wechat-received-old'));
});

test('typing starts while prompt submission is still pending', async t => {
  const pending = deferred();
  const f = await fixture(t, { submit: () => pending.promise });
  await f.bridge.start(); f.push(message('submitting', 'work'));
  await until(() => f.calls.length === 1 && f.typing.includes(true));
  assert.equal(f.sends.length, 0);
  pending.resolve();
  await until(() => f.sends.some(x => x.text === 'done'));
  assert.equal(f.typing.at(-1), false);
});

test('preparation failure reports not submitted and retires typing without model admission', async t => {
  const f = await fixture(t);
  f.bridge.outbound = async () => { throw new Error('cannot get property fs without inject'); };
  await f.bridge.start(); f.push(message('preparation', 'work'));
  await until(() => f.sends.some(x => x.text.includes('尚未提交')));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.store.snapshot().inbox, []);
  assert.ok(f.store.snapshot().seen.includes('preparation'));
  assert.match(f.sends[0].text, /已丢弃/);
  assert.ok(f.typing.includes(true));
  assert.equal(f.typing.at(-1), false);
  assert.equal(f.sends.length, 1);
  await f.bridge.stop();
  await f.bridge.start(); await sleep(40);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sends.length, 1);
});

test('heartbeat is serial while waiting and sends typing=false on final completion', async t => {
  const answer = deferred(); let active = 0, maximum = 0;
  const f = await fixture(t, { waitForReply: () => answer.promise,
    sendTyping: async () => { active++; maximum = Math.max(active, maximum); await sleep(6); active--; } });
  await f.bridge.start(); f.push(message('typing', 'long request'));
  await until(() => f.typing.filter(Boolean).length >= 3);
  answer.resolve('done');
  await until(() => f.sends.some(x => x.text === 'done'));
  assert.equal(maximum, 1);
  assert.equal(f.typing.at(-1), false);
  const count = f.typing.length; await sleep(60); assert.equal(f.typing.length, count);
});

test('aborting an active wait retires typing and stops subsequent heartbeats', async t => {
  const f = await fixture(t, { waitForReply: (_sid, _id, signal) => aborted(signal) });
  await f.bridge.start(); f.push(message('cancel', 'long request'));
  await until(() => f.typing.includes(true));
  await f.bridge.stop();
  assert.equal(f.typing.at(-1), false);
  const count = f.typing.length; await sleep(60); assert.equal(f.typing.length, count);
});

test('typing rejection does not suppress the final reply', async t => {
  const answer = deferred();
  const f = await fixture(t, { waitForReply: () => answer.promise,
    sendTyping: async () => { throw Error('fake typing outage'); } });
  await f.bridge.start(); f.push(message('reject', 'work'));
  await until(() => f.typing.includes(true));
  answer.resolve('done');
  await until(() => f.sends.some(x => x.text === 'done'));
  assert.equal(f.typing.at(-1), false);
});

test('uncooperative typing client cannot block completion or overlap next request', async t => {
  const stuck = deferred(), first = deferred();
  let waits = 0;
  const f = await fixture(t, { timeoutMs: 20, waitForReply: () => ++waits === 1 ? first.promise : 'second done',
    sendTyping: () => stuck.promise });
  await f.bridge.start(); f.push(message('stuck', 'first'));
  await until(() => f.typing.length === 1);
  await sleep(30); first.resolve('done');
  await until(() => f.sends.some(x => x.text === 'done'));
  f.push(message('next', 'second'));
  await until(() => f.sends.some(x => x.text === 'second done'));
  assert.equal(f.typing.length, 1);
  await f.bridge.stop();
  stuck.resolve();
});
