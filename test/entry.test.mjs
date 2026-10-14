import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, inject } from '../index.mjs';

async function environment(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-entry-'));
  const before = { DSH_HOME: process.env.DSH_HOME, DSH_PROFILE: process.env.DSH_PROFILE };
  process.env.DSH_HOME = root; process.env.DSH_PROFILE = 'default';
  t.after(async () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('Host entry mounts loader only, without network; unload releases tools, route and lock', async t => {
  const root = await environment(t);
  let route, removed = false;
  const cleanups = [], tools = new Map();
  const ctx = {
    connection: { fetch: { register(value) { route = value; return async () => { removed = true; }; } } },
    effect(fn) { const off = fn(); cleanups.push(off); return off; },
    credentials: {}, agents: { get() {} },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
  };
  await apply(ctx, { cwd: root });
  for (const service of ['sessionController', 'credentials', 'connection', 'fileUploads', 'attachments', 'fs', 'tools', 'agents']) {
    assert.ok(inject.includes(service), `missing Host dependency: ${service}`);
  }
  assert.ok(tools.has('load_wechat_tools'));
  assert.ok(!tools.has('wechat_send_text'));
  const status = await (await route.fetch(new Request('http://localhost/api/dsh-wechat'))).json();
  assert.equal(status.bound, false); assert.equal(status.enabled, false);
  await cleanups.at(-1)();
  assert.equal(removed, true); assert.equal(tools.size, 0);
  await assert.rejects(access(join(root, 'storages/dsh-wechat/default/store.lock')));
});

test('Host route registration failure releases lock for a subsequent startup', async t => {
  const root = await environment(t);
  const ctx = { connection: { fetch: { register() { throw new Error('route failure'); } } } };
  await assert.rejects(apply(ctx, { cwd: root }), /route failure/);
  await assert.rejects(access(join(root, 'storages/dsh-wechat/default/store.lock')));
});

test('tool registration failure releases route and storage', async t => {
  const root = await environment(t);
  let removed = false;
  const ctx = {
    connection: { fetch: { register() { return () => { removed = true; }; } } },
    tools: { register() { throw new Error('tool failure'); } },
  };
  await assert.rejects(apply(ctx, { cwd: root }), /tool failure/);
  assert.equal(removed, true);
  await assert.rejects(access(join(root, 'storages/dsh-wechat/default/store.lock')));
});

test('invalid profile rejected before acquiring a storage lock', async t => {
  const root = await environment(t); process.env.DSH_PROFILE = 'UPPER_case';
  await assert.rejects(apply({}, {}), /lowercase letters/);
  await assert.rejects(access(join(root, 'storages/dsh-wechat/UPPER_case/store.lock')));
});
