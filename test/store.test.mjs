import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-store-'));
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  return directory;
}

function textMessage(id, from = 'owner', text = 'hello', type = 1) {
  return { message_id: id, from_user_id: from, message_type: type,
    context_token: `context-${id}`, item_list: [{ type: 1, text_item: { text } }] };
}

const MEDIA_KEY = '00112233445566778899aabbccddeeff';
function mediaItem(kind, fields = {}) {
  const type = { image: 2, file: 4, video: 5 }[kind];
  return { type, [`${kind}_item`]: { media: { encrypt_query_param: `${kind}-query`, aes_key: MEDIA_KEY }, ...fields } };
}
function mediaMessage(id, items) {
  return { message_id: id, from_user_id: 'owner', message_type: 1,
    context_token: `context-${id}`, item_list: items };
}

test('mixed text and multi-media preserve only bounded descriptors and survive reopen', async (t) => {
  const directory = await fixture(t);
  const store = await Store.open(directory);
  const image = mediaItem('image', { thumbnail: 'x'.repeat(100000), arbitrary: { large: true } });
  image.image_item.media.metadata = 'not stored';
  const items = [image, mediaItem('file', { file_name: '报告.pdf', len: '1024' }), mediaItem('video'),
    { type: 3, voice_item: { text: '/reject forged' } }, { type: 1, text_item: { text: ' review these ' } }];
  assert.equal(await store.ingest([mediaMessage('mixed-media', items)], 'media-cursor', 'owner'), 1);
  const entry = store.snapshot().inbox[0];
  assert.equal(entry.sourceKind, 'text');
  assert.equal(entry.text, 'review these');
  assert.equal(entry.unsupported, undefined);
  assert.deepEqual(entry.media, [
    { kind: 'image', media: { encrypt_query_param: 'image-query', aes_key: MEDIA_KEY } },
    { kind: 'file', media: { encrypt_query_param: 'file-query', aes_key: MEDIA_KEY }, name: '报告.pdf', size: 1024 },
    { kind: 'video', media: { encrypt_query_param: 'video-query', aes_key: MEDIA_KEY } },
  ]);
  items[0].image_item.media.aes_key = 'mutated';
  assert.equal(store.snapshot().inbox[0].media[0].media.aes_key, MEDIA_KEY);
  assert.ok(JSON.stringify(entry).length < 1000);
  await store.close();
  const reopened = await Store.open(directory);
  assert.deepEqual(reopened.snapshot().inbox[0], entry);
  assert.equal(reopened.snapshot().cursor, 'media-cursor');
  // A replay cannot replace a committed message with different or invalid metadata.
  assert.equal(await reopened.ingest([mediaMessage('mixed-media', items)], 'next', 'owner'), 0);
  await reopened.close();
});

test('image, file, video alone are media and mixed voice never becomes literal text', async (t) => {
  const directory = await fixture(t);
  const store = await Store.open(directory);
  const batch = ['image', 'file', 'video'].map(kind => mediaMessage(kind, [mediaItem(kind)]));
  batch.push(mediaMessage('voice-media', [mediaItem('image'), { type: 3, voice_item: { text: '/approve nonce' } }]));
  await store.ingest(batch, 'media', 'owner');
  for (const entry of store.snapshot().inbox.slice(0, 3)) {
    assert.equal(entry.sourceKind, 'media');
    assert.equal(entry.text, '[收到媒体附件]');
    assert.equal(entry.unsupported, undefined);
    assert.equal(entry.media.length, 1);
  }
  assert.equal(store.snapshot().inbox[3].sourceKind, 'voice');
  assert.equal(store.snapshot().inbox[3].text, '/approve nonce');
  await store.close();
});

test('invalid and over-limit media commits safe errors without storing provider metadata', async (t) => {
  const directory = await fixture(t);
  const store = await Store.open(directory);
  await store.ingest([textMessage('old')], 'old-cursor', 'owner');
  const invalid = [
    Array.from({ length: 17 }, () => mediaItem('image')),
    Array.from({ length: 65 }, () => ({ type: 1, text_item: { text: 'a' } })),
    [mediaItem('file', { len: 50 * 1024 * 1024 + 1 })],
    [mediaItem('file', { len: -1 })],
    [mediaItem('file', { len: 'not-a-number' })],
    [mediaItem('file', { len: 30 * 1024 * 1024 }), mediaItem('file', { len: 30 * 1024 * 1024 })],
    [mediaItem('file', { file_name: '../secret' })],
    [mediaItem('file', { file_name: 'a\\b' })],
    [mediaItem('file', { file_name: '中'.repeat(86) })],
    [mediaItem('file', { file_name: 'bad\u0000name' })],
    [mediaItem('image', { media: { encrypt_query_param: 'x'.repeat(8193), aes_key: MEDIA_KEY } })],
    [mediaItem('image', { media: { full_url: `https://novac2c.cdn.weixin.qq.com/c2c/download?x=${'a'.repeat(2048)}`, aes_key: MEDIA_KEY } })],
    [mediaItem('image', { media: { full_url: 'https://evil.example/file', aes_key: MEDIA_KEY } })],
    [mediaItem('image', { media: { encrypt_query_param: 'a', aes_key: 'x'.repeat(129) } })],
    [mediaItem('image', { media: { encrypt_query_param: 'a', aes_key: 'bad-key' } })],
    [{ type: 5, video_item: {} }],
  ];
  for (const [index, items] of invalid.entries()) {
    const id = `bad-${index}`;
    const cursor = `after-bad-${index}`;
    assert.equal(await store.ingest([mediaMessage(id, items)], cursor, 'owner'), 1);
    const entry = store.snapshot().inbox.at(-1);
    assert.deepEqual(entry, { id, userId: 'owner', contextToken: `context-${id}`,
      text: '[媒体附件无法处理]', sourceKind: index === 1 ? 'text' : 'media',
      status: 'queued', mediaError: true });
    assert.equal(store.snapshot().cursor, cursor);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'store.json'), 'utf8')), store.snapshot());
    assert.equal(await store.ingest([mediaMessage(id, [mediaItem('image')])], cursor, 'owner'), 0);
  }
  const stranger = { ...mediaMessage('foreign', invalid[0]), from_user_id: 'other' };
  assert.equal(await store.ingest([stranger], 'filtered', 'owner'), 0);
  assert.equal(store.snapshot().inbox.length, invalid.length + 1);
  await store.close();
});

test('invalid media preserves extracted text or voice and admits following valid messages', async (t) => {
  const directory = await fixture(t);
  const store = await Store.open(directory);
  const invalid = mediaItem('image', { media: { full_url: 'https://evil.example/secret', aes_key: MEDIA_KEY } });
  const text = mediaMessage('bad-text', [invalid, { type: 1, text_item: { text: ' safe text ' } }]);
  const voice = mediaMessage('bad-voice', [invalid, { type: 3, voice_item: { text: ' spoken words ' } }]);
  assert.equal(await store.ingest([text, voice], 'bad-cursor', 'owner'), 2);
  assert.deepEqual(store.snapshot().inbox.map(({ id, text, sourceKind, mediaError, media }) =>
    ({ id, text, sourceKind, mediaError, media })), [
    { id: 'bad-text', text: '[媒体附件无法处理]', sourceKind: 'text', mediaError: true, media: undefined },
    { id: 'bad-voice', text: '[媒体附件无法处理]', sourceKind: 'voice', mediaError: true, media: undefined },
  ]);
  assert.equal(await store.ingest([
    mediaMessage('bad-in-batch', [invalid]),
    mediaMessage('good-in-batch', [mediaItem('image')]),
  ], 'same-batch-cursor', 'owner'), 2);
  assert.equal(store.snapshot().inbox[2].mediaError, true);
  assert.equal(store.snapshot().inbox[2].media, undefined);
  assert.equal(store.snapshot().inbox[3].mediaError, undefined);
  assert.equal(store.snapshot().inbox[3].media.length, 1);
  assert.equal(await store.ingest([mediaMessage('good', [mediaItem('image')])], 'good-cursor', 'owner'), 1);
  assert.equal(store.snapshot().cursor, 'good-cursor');
  assert.equal(store.snapshot().inbox[4].sourceKind, 'media');
  assert.equal(store.snapshot().inbox[4].mediaError, undefined);
  assert.equal(store.snapshot().inbox[4].media.length, 1);
  await store.close();
});

test('bounded media at limits and legacy v1 entries remain readable', async (t) => {
  const directory = await fixture(t);
  const store = await Store.open(directory);
  await store.update(s => { s.inbox.push({ id: 'legacy', userId: 'owner', contextToken: '', text: 'old', status: 'queued' }); });
  const items = Array.from({ length: 16 }, () => mediaItem('image'));
  items[0] = mediaItem('file', { file_name: 'a'.repeat(255), len: 50 * 1024 * 1024 });
  items[1] = mediaItem('image', { media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=q', aes_key: MEDIA_KEY } });
  await store.ingest([mediaMessage('limits', items)], 'at-limit', 'owner');
  await store.close();
  const reopened = await Store.open(directory);
  assert.equal(reopened.snapshot().inbox[0].sourceKind, undefined);
  assert.equal(reopened.snapshot().inbox[1].media.length, 16);
  assert.equal(reopened.snapshot().inbox[1].media[0].size, 50 * 1024 * 1024);
  await reopened.close();
});

test('initial state, clone, mode 0600, and reopen', async (t) => {
  const directory = await fixture(t);
  const store = await Store.open(directory);
  assert.deepEqual(store.snapshot(), { version: 1, enabled: false, sessionId: null,
    cursor: '', inbox: [], outbox: [], seen: [], binding: null });
  const copy = store.snapshot();
  copy.inbox.push('not persisted');
  assert.deepEqual(store.snapshot().inbox, []);
  assert.equal((await fs.stat(path.join(directory, 'store.json'))).mode & 0o777, 0o600);
  await store.update((state) => { state.enabled = true; state.sessionId = 'session'; });
  await store.close();
  const reopened = await Store.open(directory);
  assert.equal(reopened.snapshot().sessionId, 'session');
  assert.equal(reopened.snapshot().enabled, true);
  assert.equal((await fs.stat(path.join(directory, 'store.json'))).mode & 0o777, 0o600);
  await reopened.close();
});

test('serializes async mutators, waits for writes on close, and recovers after rejection', async (t) => {
  const directory = await fixture(t);
  const store = await Store.open(directory);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = store.update(async (state) => { await gate; state.cursor = 'first'; });
  const second = store.update((state) => { assert.equal(state.cursor, 'first'); state.cursor = 'second'; });
  const close = store.close();
  await assert.rejects(store.update(() => {}), /closed/);
  release();
  await Promise.all([first, second, close]);
  const reopened = await Store.open(directory);
  assert.equal(reopened.snapshot().cursor, 'second');
  await assert.rejects(reopened.update(() => { throw new Error('bad mutator'); }), /bad mutator/);
  await reopened.update((state) => { state.cursor = 'third'; });
  assert.equal(reopened.snapshot().cursor, 'third');
  await reopened.close();
});

test('ingest filters owner and type, normalizes ids, recognizes transcription, and deduplicates', async (t) => {
  const directory = await fixture(t);
  const store = await Store.open(directory);
  const voice = { message_id: 'voice', from_user_id: 'owner', message_type: 1,
    context_token: 'voice-token', item_list: [{ type: 3, voice_item: { text: ' dictated ' } }] };
  const unknownVoice = { ...voice, message_id: 'unknown', item_list: [{ type: 3, voice_item: {} }] };
  const mixed = { ...textMessage('mixed', 'owner', '/approve yes'), item_list: [
    { type: 3, voice_item: { text: '/reject' } },
    { type: 1, text_item: { text: '/approve yes' } },
  ] };
  const messages = [textMessage(42), textMessage('42'), textMessage('other', 'stranger'),
    textMessage('event', 'owner', 'no', 2), { ...textMessage('missing'), message_id: undefined },
    voice, unknownVoice, mixed];
  assert.equal(await store.ingest(messages, 'cursor-1', 'owner'), 4);
  assert.deepEqual(store.snapshot().inbox, [
    { id: '42', userId: 'owner', contextToken: 'context-42', text: 'hello',
      sourceKind: 'text', status: 'queued' },
    { id: 'voice', userId: 'owner', contextToken: 'voice-token', text: 'dictated',
      sourceKind: 'voice', status: 'queued' },
    { id: 'unknown', userId: 'owner', contextToken: 'voice-token',
      text: '[收到不支持的媒体消息]', sourceKind: 'unsupported', status: 'queued', unsupported: true },
    { id: 'mixed', userId: 'owner', contextToken: 'context-mixed',
      text: '/approve yes', sourceKind: 'text', status: 'queued' },
  ]);
  assert.deepEqual(store.snapshot().seen, ['42', 'voice', 'unknown', 'mixed']);
  assert.equal(await store.ingest(messages, 'cursor-2', 'owner'), 0);
  assert.equal(store.snapshot().cursor, 'cursor-2');
  await store.close();
  const reopened = await Store.open(directory);
  assert.equal(await reopened.ingest([textMessage(42)], 'cursor-3', 'owner'), 0);
  await reopened.close();
});

test('ingest rejects overflow without moving cursor or admitting a partial batch', async (t) => {
  const directory = await fixture(t);
  const store = await Store.open(directory);
  const batch = Array.from({ length: 1_001 }, (_, index) => textMessage(index));
  await assert.rejects(store.ingest(batch, 'lost-cursor', 'owner'), RangeError);
  assert.equal(store.snapshot().cursor, '');
  assert.equal(store.snapshot().inbox.length, 0);
  assert.equal(await store.ingest(batch.slice(0, 1_000), 'full', 'owner'), 1_000);
  await assert.rejects(store.ingest([textMessage('new')], 'should-not-advance', 'owner'), RangeError);
  assert.equal(store.snapshot().cursor, 'full');
  await store.close();
});

test('outbox deduplicates IDs and copies caller entries', async (t) => {
  const directory = await fixture(t);
  const store = await Store.open(directory);
  const entry = { id: 'reply-1', userId: 'owner', contextToken: 'token', text: 'answer' };
  assert.equal(await store.enqueue(entry), true);
  entry.text = 'changed';
  assert.equal(await store.enqueue({ ...entry, text: 'duplicate' }), false);
  assert.deepEqual(store.snapshot().outbox, [
    { id: 'reply-1', userId: 'owner', contextToken: 'token', text: 'answer', status: 'queued' },
  ]);
  await store.update((state) => {
    state.outbox[0].status = 'sending';
    state.outbox[0].requestId = 'request-1';
  });
  await store.close();
  const reopened = await Store.open(directory);
  assert.equal(reopened.snapshot().outbox[0].status, 'sending');
  assert.equal(reopened.snapshot().outbox[0].requestId, 'request-1');
  await reopened.close();
});

test('terminal entries are pruned while completed IDs remain deduplicated', async (t) => {
  const directory = await fixture(t);
  const store = await Store.open(directory);
  const initial = Array.from({ length: 1_000 }, (_, index) => textMessage(`first-${index}`));
  await store.ingest(initial, 'first', 'owner');
  await store.update((state) => {
    for (let index = 0; index < 600; index++) state.inbox[index].status = 'done';
  });
  assert.equal(store.snapshot().inbox.length, 400);
  assert.equal(store.snapshot().seen.length, 1_000);
  const next = Array.from({ length: 600 }, (_, index) => textMessage(`next-${index}`));
  assert.equal(await store.ingest([...initial.slice(0, 5), ...next], 'second', 'owner'), 600);
  assert.equal(store.snapshot().inbox.length, 1_000);
  assert.equal(await store.enqueue({ id: 'sent-id', userId: 'owner', contextToken: '', text: 'ok' }), true);
  assert.equal(await store.enqueue({ id: 'review-id', userId: 'owner', contextToken: '', text: 'retry' }), true);
  await store.update((state) => {
    state.outbox[0].status = 'sent';
    state.outbox[1].status = 'uncertain';
  });
  assert.deepEqual(store.snapshot().outbox.map((item) => item.id), ['review-id']);
  await store.close();
  const reopened = await Store.open(directory);
  assert.equal(await reopened.ingest([initial[0]], 'third', 'owner'), 0);
  assert.equal(await reopened.enqueue({ id: 'sent-id', userId: 'owner', contextToken: '', text: 'duplicate' }), false);
  assert.deepEqual(reopened.snapshot().outbox.map((item) => item.id), ['review-id']);
  await reopened.close();
});

test('legacy failed inbox records survive reopen without replaying their IDs', async (t) => {
  const directory = await fixture(t);
  const store = await Store.open(directory);
  await store.ingest([textMessage('failed'), textMessage('uncertain'), textMessage('active')], 'cursor', 'owner');
  await store.close();
  const filename = path.join(directory, 'store.json');
  const previous = JSON.parse(await fs.readFile(filename, 'utf8'));
  previous.binding = { ownerId: 'owner', botId: 'bot' };
  previous.inbox[0].status = 'failed';
  previous.inbox[1].status = 'needs-review';
  previous.inbox[2].contextToken = '';
  await fs.writeFile(filename, `${JSON.stringify(previous)}\n`);
  const reopened = await Store.open(directory);
  assert.deepEqual(reopened.snapshot().inbox.map(item => item.id), ['failed', 'uncertain', 'active']);
  assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')).inbox, reopened.snapshot().inbox);
  assert.equal(await reopened.ingest([textMessage('failed'), textMessage('uncertain')], 'replayed', 'owner'), 0);
  assert.deepEqual(reopened.snapshot().inbox.map(item => item.id), ['failed', 'uncertain', 'active']);
  await reopened.close();
});

test('new failed inbox records retain original payload and seen IDs', async (t) => {
  const directory = await fixture(t);
  const store = await Store.open(directory);
  await store.ingest([textMessage('failed'), textMessage('uncertain')], 'cursor', 'owner');
  await store.update(state => { state.inbox[0].status = 'failed'; state.inbox[1].status = 'needs-review'; });
  assert.deepEqual(store.snapshot().inbox.map(item => item.status), ['failed', 'needs-review']);
  assert.deepEqual(store.snapshot().seen, ['failed', 'uncertain']);
  await store.close();
});

test('cancelled inbox and outbox entries prune without allowing replay', async (t) => {
  const directory = await fixture(t);
  const store = await Store.open(directory);
  await store.ingest([textMessage('cancelled'), textMessage('pending')], 'before', 'owner');
  const reply = { id: 'cancelled-reply', userId: 'owner', contextToken: '', text: 'answer' };
  await store.enqueue(reply);
  await store.update((state) => {
    state.inbox[0].status = 'cancelled';
    state.outbox[0].status = 'cancelled';
  });
  assert.deepEqual(store.snapshot().inbox.map((item) => item.id), ['pending']);
  assert.deepEqual(store.snapshot().outbox, []);
  await store.close();
  const reopened = await Store.open(directory);
  assert.equal(await reopened.ingest([textMessage('cancelled')], 'after', 'owner'), 0);
  assert.equal(await reopened.enqueue(reply), false);
  assert.equal(reopened.snapshot().cursor, 'after');
  await reopened.close();
});

test('pre-rename write failure preserves previous state and allows retry', async (t) => {
  const directory = await fixture(t);
  const store = await Store.open(directory);
  await store.update((state) => { state.cursor = 'safe'; });
  const target = path.join(directory, 'store.json');
  const backup = path.join(directory, 'backup.json');
  await fs.rename(target, backup);
  await fs.mkdir(target);
  try {
    await assert.rejects(store.ingest([mediaMessage('not-committed', [mediaItem('image')])], 'not-committed', 'owner'), /EISDIR|ENOTEMPTY|EPERM/);
    assert.equal(store.snapshot().cursor, 'safe');
    assert.deepEqual(store.snapshot().inbox, []);
    assert.deepEqual(store.snapshot().seen, []);
    assert.equal(JSON.parse(await fs.readFile(backup, 'utf8')).cursor, 'safe');
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    await fs.rmdir(target);
    await fs.rename(backup, target);
  }
  await store.update((state) => { state.cursor = 'recovered'; });
  await store.close();
});

test('live owner is protected and a crashed owner is recovered without losing queued media', async (t) => {
  const directory = await fixture(t);
  const store = await Store.open(directory);
  await assert.rejects(Store.open(directory), (error) => error.code === 'EEXIST');
  await store.close();
  const moduleUrl = new URL('../src/store.mjs', import.meta.url).href;
  const message = mediaMessage('crash-media', [mediaItem('file', { file_name: 'saved.txt', len: 7 }), mediaItem('video')]);
  const code = `import { Store } from ${JSON.stringify(moduleUrl)}; const store = await Store.open(${JSON.stringify(directory)}); await store.ingest([${JSON.stringify(message)}], 'crash-cursor', 'owner'); process.stdout.write('ready\\n'); setInterval(() => {}, 10000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', (data) => data.toString().includes('ready') ? resolve() : reject(new Error('child did not open store')));
      child.once('exit', () => reject(new Error('child exited before acquiring lock')));
    });
    await assert.rejects(Store.open(directory), (error) => error.code === 'EEXIST' && /still running/.test(error.message));
    assert.equal((await fs.readFile(path.join(directory, 'store.lock'), 'utf8')).trim(), String(child.pid));
    child.kill('SIGKILL');
    await once(child, 'exit');
    const recovered = await Store.open(directory);
    assert.equal(recovered.snapshot().cursor, 'crash-cursor');
    assert.equal(recovered.snapshot().inbox[0].sourceKind, 'media');
    assert.deepEqual(recovered.snapshot().inbox[0].media.map(item => item.kind), ['file', 'video']);
    assert.equal(recovered.snapshot().inbox[0].media[0].name, 'saved.txt');
    assert.equal(await recovered.ingest([message], 'after-crash', 'owner'), 0);
    await recovered.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
