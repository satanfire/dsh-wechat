import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';

const moduleUrl = new URL('../src/store.mjs', import.meta.url).href;

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-lock-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function child(t, code) {
  const processChild = spawn(process.execPath, ['--input-type=module', '-e', code],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => {
    if (processChild.exitCode === null && processChild.signalCode === null) {
      const exit = once(processChild, 'exit');
      processChild.kill('SIGKILL');
      await exit;
    }
  });
  return processChild;
}

async function deadPid() {
  const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await once(exited, 'exit');
  assert.throws(() => process.kill(exited.pid, 0), { code: 'ESRCH' });
  return exited.pid;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} exit can reopen without manual lock deletion`, { timeout: 10000 }, async (t) => {
    const directory = await fixture(t);
    const owner = child(t, `
      import { Store } from ${JSON.stringify(moduleUrl)};
      const store = await Store.open(${JSON.stringify(directory)});
      await store.update(s => { s.enabled = true; s.cursor = 'saved'; });
      process.send('ready');
      setInterval(() => {}, 10000);
    `);
    assert.equal((await once(owner, 'message'))[0], 'ready');
    const exit = once(owner, 'exit');
    owner.kill(signal);
    await exit;
    const reopened = await Store.open(directory);
    try {
      assert.equal(reopened.snapshot().enabled, true);
      assert.equal(reopened.snapshot().cursor, 'saved');
      assert.equal((await fs.readFile(path.join(directory, 'store.lock'), 'utf8')).trim(), String(process.pid));
      await assert.rejects(fs.stat(path.join(directory, 'store.lock.recover')), { code: 'ENOENT' });
    } finally {
      await reopened.close();
    }
  });
}

test('simultaneous crash recovery admits exactly one process', { timeout: 10000 }, async (t) => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, 'store.lock'), `${await deadPid()}\n`);
  const workers = Array.from({ length: 8 }, () => child(t, `
    import { Store } from ${JSON.stringify(moduleUrl)};
    process.on('message', async () => {
      try {
        await Store.open(${JSON.stringify(directory)});
        process.send({ acquired: true, pid: process.pid });
      } catch (error) {
        process.send({ acquired: false, code: error.code });
      }
    });
    process.send('ready');
  `));
  await Promise.all(workers.map(async worker => assert.equal((await once(worker, 'message'))[0], 'ready')));
  const results = workers.map(worker => once(worker, 'message').then(([message]) => message));
  workers.forEach(worker => worker.send('start'));
  const settled = await Promise.all(results);
  const owners = settled.filter(result => result.acquired);
  assert.equal(owners.length, 1);
  for (const result of settled.filter(result => !result.acquired)) assert.equal(result.code, 'EEXIST');
  assert.equal((await fs.readFile(path.join(directory, 'store.lock'), 'utf8')).trim(), String(owners[0].pid));
  await assert.rejects(Store.open(directory), error => error.code === 'EEXIST' && /still running/.test(error.message));
});

test('invalid owner records remain untouched', async (t) => {
  const directory = await fixture(t);
  const lockPath = path.join(directory, 'store.lock');
  for (const raw of ['', '0\n', '-1\n', 'abc\n', '9999999999\n', '123\n456\n', '1'.repeat(100)]) {
    await fs.writeFile(lockPath, raw);
    await assert.rejects(Store.open(directory), error => error.code === 'EEXIST' && /invalid owner/.test(error.message));
    assert.equal(await fs.readFile(lockPath, 'utf8'), raw);
  }
});

test('an interrupted recovery gate is preserved for manual inspection', async (t) => {
  const directory = await fixture(t);
  const lockPath = path.join(directory, 'store.lock');
  const recoveryPath = path.join(directory, 'store.lock.recover');
  const raw = `${await deadPid()}\n`;
  await fs.writeFile(lockPath, raw);
  await fs.writeFile(recoveryPath, raw);
  await assert.rejects(Store.open(directory), error => error.code === 'EEXIST' && /recovery/.test(error.message));
  assert.equal(await fs.readFile(lockPath, 'utf8'), raw);
  assert.equal(await fs.readFile(recoveryPath, 'utf8'), raw);
});
