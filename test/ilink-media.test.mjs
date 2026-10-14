import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import test from 'node:test';
import { ILinkClient, ILinkError, normalizeMediaItems } from '../src/ilink.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});

const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

function encrypted(value) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(value), cipher.final()]);
}

test('sendTyping obtains a ticket then sends status 1/2 with exact fields', async () => {
  const calls = [];
  const api = new ILinkClient({ token: 'token', retryBaseMs: 1, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return json(calls.length === 1 ? { ret: 0, typing_ticket: 'ticket' } : { ret: 0 });
  }});
  await api.sendTyping({ userId: 'user', contextToken: 'context', typing: true });
  assert.equal(calls[0].url.pathname, '/ilink/bot/getconfig');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    ilink_user_id: 'user', context_token: 'context', base_info: { channel_version: '2.0.0' },
  });
  assert.equal(calls[1].url.pathname, '/ilink/bot/sendtyping');
  assert.equal(JSON.parse(calls[1].init.body).status, 1);
  await api.sendTyping({ userId: 'user', contextToken: 'context', typing: false });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url.pathname, '/ilink/bot/sendtyping');
  assert.equal(JSON.parse(calls[2].init.body).status, 2);
  assert.equal(JSON.parse(calls[2].init.body).typing_ticket, 'ticket');
});

test('normalizeMediaItems whitelists verified image, file, and video fields', () => {
  assert.deepEqual(normalizeMediaItems([
    { type: 2, image_item: { aeskey: key.toString('hex'), media: { encrypt_query_param: 'iq', ignored: 'x' } } },
    { type: 4, file_item: { file_name: 'a.txt', len: '3', media: { aes_key: key.toString('base64'), encrypt_query_param: 'fq' } } },
    { type: 5, video_item: { media: { aes_key: key.toString('base64'), full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?x=1' } } },
    { type: 4, file_item: { media: { aes_key: 'bad', encrypt_query_param: 'drop' } } },
  ]), [
    { kind: 'image', media: { encrypt_query_param: 'iq', aes_key: key.toString('hex') } },
    { kind: 'file', name: 'a.txt', size: 3, media: { encrypt_query_param: 'fq', aes_key: key.toString('base64') } },
    { kind: 'video', media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?x=1', aes_key: key.toString('base64') } },
  ]);
});

test('downloadMedia decrypts AES-128-ECB and enforces streamed bounds', async () => {
  const body = encrypted(Buffer.from('hello media'));
  const api = new ILinkClient({ token: 'token', maxMediaBytes: 50, fetchImpl: async () => new Response(body) });
  const result = await api.downloadMedia({ kind: 'file', media: {
    encrypt_query_param: 'download-token', aes_key: key.toString('base64'),
  } });
  assert.deepEqual(result, Buffer.from('hello media'));

  const tooLarge = new ILinkClient({ token: 'token', maxMediaBytes: 5, fetchImpl: async () => new Response(body) });
  await assert.rejects(tooLarge.downloadMedia({ kind: 'file', media: {
    encrypt_query_param: 'download-token', aes_key: key.toString('base64'),
  } }), error => error instanceof ILinkError && error.code === 'media-too-large');
});
