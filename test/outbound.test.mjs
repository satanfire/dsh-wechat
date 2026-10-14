import test from 'node:test';
import assert from 'node:assert/strict';
import { enableOutbound } from '../src/outbound.mjs';

function fixture(options = {}) {
  const saved = [];
  const reads = [];
  let tool;
  let disposed = false;
  let changed = false;
  const content = new Uint8Array([1, 2, 3]);
  const state = {
    enabled: true, binding: { ownerId: 'owner' }, seen: [], outbox: [],
    inbox: [{ id: 'incoming', userId: 'owner', contextToken: 'token',
      sessionId: 'session-id', requestId: 'request-id', status: 'submitted' }],
  };
  const fs = {
    async resolve(value, { cwd } = {}) {
      let absolute = value.startsWith('/') ? value : `${cwd}/${value}`;
      if (options.outsideLink && absolute === '/work/link') absolute = '/private/secret';
      if (changed && absolute === '/work/asset.png') absolute = '/private/secret';
      return { targetKey: absolute, displayPath: absolute };
    },
    contains(parent, child) {
      return child.targetKey === parent.targetKey
        || child.targetKey.startsWith(`${parent.targetKey}/`);
    },
    async stat(target) {
      if (target.targetKey === '/work') return { type: 'directory' };
      return { type: 'file', size: options.size ?? content.byteLength };
    },
    async readBytes(target, signal, maxBytes) {
      reads.push({ target, signal, maxBytes });
      if (options.changeDuringRead) changed = true;
      return content;
    },
  };
  const agent = {
    id: 'session-id',
    ctx: {
      fs,
      tools: { register(definition) { tool = definition; return () => { disposed = true; }; } },
      effect(effect) { return effect(); },
    },
  };
  const events = [
    {type:'turn/start',seq:0,data:{turn:1}},
    {type:'step/start',seq:1,data:{turn:1,step:1}},
    {type:'user/message',seq:2,data:{source:{kind:'user',rpcId:'request-id'}}},
    {type:'tool/call',seq:3,data:{turn:1,callId:'call-a',name:'wechat_send_media',arguments:'{}'}},
    {type:'tool/call',seq:4,data:{turn:1,callId:'shared-run-code-call',name:'run_code',arguments:'{}'}},
  ];
  const ctx = {
    fs,
    sessionController: { async inspect() { return {events}; }, async resolveAgent(id) { return id === agent.id ? { agent } : { error: new Error('missing') }; } },
    attachments: { async saveFile(input) {
      saved.push(input);
      return { attachmentId: 'blob-1', name: input.name, bytes: input.data.byteLength };
    } },
  };
  const store = {
    snapshot() { return structuredClone(state); },
    async update(fn) { return fn(state); },
  };
  const enabled = () => enableOutbound(ctx, { store, cwd: '/work', sessionId: agent.id, requestId: 'request-id' });
  const execute = (args = { path: 'asset.png', kind: 'image' }, exec = {}) => tool.execute(args, {
    agent, callId: 'call-a', signal: new AbortController().signal, ...exec,
  });
  return { enabled, execute, events, agent, state, ctx, store, reads, saved,
    get tool() { return tool; }, get disposed() { return disposed; } };
}

test('uses injected Host filesystem when Agent context does not inject fs', async () => {
  const f = fixture();
  Object.defineProperty(f.agent.ctx, 'fs', { get() { throw new Error('cannot get property "fs" without inject'); } });
  const off = await f.enabled();
  assert.equal((await f.execute()).status, 'queued');
  assert.equal(f.reads.length, 1);
  off();
});

test('registers only on the exact WeChat Agent; queues a durable attachment', async () => {
  const f = fixture();
  const off = await f.enabled();
  assert.equal(f.tool.name, 'wechat_send_media');
  assert.deepEqual(f.tool.parameters.required, ['path', 'kind']);
  const result = await f.execute();
  assert.equal(result.status, 'queued');
  assert.match(result.id, /^wechat-media-[a-f0-9]{64}$/);
  assert.equal(f.reads[0].maxBytes, 50 * 1024 * 1024);
  assert.equal(f.saved.length, 1);
  assert.deepEqual(f.state.outbox[0], {
    id: result.id, status: 'queued', text: '', userId: 'owner', contextToken: 'token',
    media: { kind: 'image', name: 'asset.png', attachment: {
      attachmentId: 'blob-1', name: 'asset.png', bytes: 3,
    } },
  });
  off();
  assert.equal(f.disposed, true);
});

test('refuses foreign agent or non-WeChat request before reading file', async () => {
  const f = fixture();
  await f.enabled();
  await assert.rejects(f.execute(undefined, { agent: { id: 'another' } }), /current task/);
  f.state.inbox[0].status = 'done';
  await assert.rejects(f.execute(), /no longer active/);
  assert.equal(f.reads.length, 0);
  const g = fixture();
  g.state.inbox[0].requestId = 'different';
  await assert.rejects(g.enabled(), /No active WeChat task/);
});

test('rejects oversized files and workspace escapes including symlinks', async () => {
  const large = fixture({ size: 50 * 1024 * 1024 + 1 });
  await large.enabled();
  await assert.rejects(large.execute(), /50 MiB/);
  assert.equal(large.reads.length, 0);
  const escaped = fixture();
  await escaped.enabled();
  await assert.rejects(escaped.execute({ path: '/private/secret', kind: 'file' }), /outside/);
  const linked = fixture({ outsideLink: true });
  await linked.enabled();
  await assert.rejects(linked.execute({ path: 'link', kind: 'file' }), /outside/);
  assert.equal(linked.saved.length, 0);
});

test('rejects symlink target changes after reading without queuing data', async () => {
  const f = fixture({ changeDuringRead: true });
  await f.enabled();
  await assert.rejects(f.execute(), /changed during read/);
  assert.equal(f.saved.length, 0);
  assert.equal(f.state.outbox.length, 0);
});

test('deduplicates repeated callId, but distinct calls in one run_code can both queue', async () => {
  const f = fixture();
  await f.enabled();
  const first = await f.execute();
  const repeat = await f.execute();
  assert.equal(first.id, repeat.id);
  assert.equal(repeat.status, 'already-queued');
  const second = await f.execute({ path: 'asset.png', kind: 'video' }, {
    callId: 'call-b', rootCallId: 'shared-run-code-call',
  });
  assert.notEqual(first.id, second.id);
  assert.equal(f.saved.length, 2);
  assert.equal(f.state.outbox.length, 2);
  f.state.outbox.splice(0);
  f.state.seen.push(`\0outbox\0${first.id}`);
  const delivered = await f.execute();
  assert.equal(delivered.status, 'already-queued');
  assert.equal(f.saved.length, 2);
});

test('revoked binding or owner refuses installation and execution', async () => {
  const f = fixture();
  f.state.enabled = false;
  await assert.rejects(f.enabled(), /No active WeChat task/);
  f.state.enabled = true;
  await f.enabled();
  f.state.binding.ownerId = 'other';
  await assert.rejects(f.execute(), /no longer active/);
});


test('pending Web work cannot borrow WeChat media access', async () => {
  const f = fixture();
  await f.enabled();
  f.events[2].data.source.rpcId = 'web-request';
  await assert.rejects(f.execute(), /admitted WeChat turn/);
  assert.equal(f.reads.length, 0);
});

test('mixed or ended WeChat turns cannot send media', async () => {
  for (const end of [false, true]) {
    const f = fixture();
    await f.enabled();
    f.events.push(end
      ? {type:'turn/end',seq:5,data:{turn:1,reason:{kind:'completed'}}}
      : {type:'user/message',seq:5,data:{source:{kind:'user',rpcId:'web-request'}}});
    await assert.rejects(f.execute(), /admitted WeChat turn/);
    assert.equal(f.saved.length, 0);
  }
});


test('failed media call returns failed without reading or saving the attachment again', async () => {
  const f = fixture();
  await f.enabled();
  const first = await f.execute();
  f.state.outbox.splice(0);
  f.state.seen.push(`\0outbox-failed\0${first.id}`);
  const repeated = await f.execute();
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.status, 'failed');
  assert.equal(f.reads.length, 1);
  assert.equal(f.saved.length, 1);
  assert.deepEqual(f.state.outbox, []);
});
