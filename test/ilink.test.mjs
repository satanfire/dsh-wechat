import assert from 'node:assert/strict';
import test from 'node:test';
import { ILinkClient, ILinkError } from '../src/ilink.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});
const request = { userId: 'wx-user', contextToken: 'context-secret', text: 'Hello', clientId: 'caller-id-1' };

function client(fetchImpl, overrides = {}) {
  return new ILinkClient({ fetchImpl, token: 'secret-token', retryBaseMs: 1, ...overrides });
}

test('QR and QR status return protocol JSON with encoded query, no auth on QR', async () => {
  const calls = [];
  const api = client(async (url, init) => {
    calls.push({ url, init });
    return json(calls.length === 1 ? { qrcode: 'abc', qrcode_img_content: 'qr-url' }
      : { status: 'confirmed', bot_token: 'bot-secret', ret: 0 });
  });
  assert.deepEqual(await api.getQr(), { qrcode: 'abc', qrcode_img_content: 'qr-url' });
  assert.equal((await api.getQrStatus('a &?')).status, 'confirmed');
  assert.equal(calls[0].url.pathname, '/ilink/bot/get_bot_qrcode');
  assert.equal(calls[0].url.searchParams.get('bot_type'), '3');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[1].url.searchParams.get('qrcode'), 'a &?');
});

test('poll includes cursor, authenticated headers, provider timeout margin', async () => {
  const api = client(async (url, init) => {
    assert.equal(url.pathname, '/ilink/bot/getupdates');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer secret-token');
    assert.equal(init.headers.AuthorizationType, 'ilink_bot_token');
    assert.equal(Buffer.from(init.headers['X-WECHAT-UIN'], 'base64').toString().length > 0, true);
    assert.deepEqual(JSON.parse(init.body), {
      get_updates_buf: 'next', base_info: { channel_version: '2.0.0' },
    });
    return json({ ret: 0, msgs: [], get_updates_buf: 'after' });
  });
  assert.equal((await api.getUpdates('next')).get_updates_buf, 'after');
  assert.equal(api.pollTimeoutMs, 70_000);
  assert.throws(() => client(() => {}, { pollTimeoutMs: 55_000 }), RangeError);
});

test('send retries transient failure using identical caller-supplied client_id', async () => {
  const bodies = [];
  const api = client(async (_url, init) => {
    bodies.push(init.body);
    if (bodies.length === 1) return json({ ret: -2 });
    return json({ ret: 0, delivery: 'accepted' });
  });
  assert.deepEqual(await api.sendText(request), { ret: 0, delivery: 'accepted' });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(JSON.parse(bodies[0]), {
    msg: {
      from_user_id: '', to_user_id: 'wx-user', client_id: 'caller-id-1',
      message_type: 2, message_state: 2, context_token: 'context-secret',
      item_list: [{ type: 1, text_item: { text: 'Hello' } }],
    }, base_info: { channel_version: '2.0.0' },
  });
});

test('ret and errcode rejects, including on HTTP 200, without leaking secrets', async () => {
  for (const payload of [{ ret: -14, errmsg: 'secret-token' },
    { ret: 0, errcode: 41, errmsg: 'context-secret' }]) {
    let count = 0;
    const api = client(async () => { count++; return json(payload); });
    await assert.rejects(api.sendText(request), error => {
      assert.ok(error instanceof ILinkError);
      assert.equal(error.code, 'provider-rejected');
      assert.equal(error.providerCode, String(payload.errcode ?? payload.ret));
      assert.equal(error.uncertain, false);
      assert.doesNotMatch(String(error), /secret-token|context-secret/);
      return true;
    });
    assert.equal(count, 1);
  }
});

test('HTTP 5xx marks send uncertain without retry', async () => {
  let count = 0;
  const api = client(async () => { count++; return json({ errmsg: 'secret-token' }, 503); });
  await assert.rejects(api.sendText(request), error => {
    assert.equal(error.code, 'http-error');
    assert.equal(error.status, 503);
    assert.equal(error.uncertain, true);
    assert.doesNotMatch(String(error), /secret-token/);
    return true;
  });
  assert.equal(count, 1);
});

test('non-JSON HTTP 503 is retried as transient HTTP error', async () => {
  let attempts = 0;
  const api = client(async () => {
    attempts++;
    return attempts === 1 ? new Response('', { status: 503 }) : json({ ret: 0 });
  });
  assert.deepEqual(await api.getQr(), { ret: 0 });
  assert.equal(attempts, 2);
});

test('oversized streamed responses fail before unbounded allocation', async () => {
  const api = client(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(10)); controller.close(); },
  })), { maxResponseBytes: 5 });
  await assert.rejects(api.getQr(), { code: 'response-too-large' });
});

test('caller abort cancels in-flight fetch and aborts retry backoff', async () => {
  const controller = new AbortController();
  let capturedSignal;
  const api = client(async (_url, { signal }) => {
    capturedSignal = signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('token-leak')), { once: true });
    });
  });
  const pending = api.getUpdates('', controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
  assert.equal(capturedSignal.aborted, true);

  const backoffController = new AbortController();
  let tries = 0;
  const retrying = client(async () => {
    tries++;
    queueMicrotask(() => backoffController.abort());
    throw new TypeError('offline');
  }, { retryBaseMs: 1000 }).sendText(request, backoffController.signal);
  await assert.rejects(retrying, error => error.code === 'aborted' && error.uncertain === true);
  assert.equal(tries, 1);
});

test('untrusted base URLs rejected without invoking fetch', () => {
  for (const baseUrl of ['http://ilinkai.weixin.qq.com', 'https://weixin.qq.com.evil.test',
    'https://evilweixin.qq.com', 'https://user:pass@ilinkai.weixin.qq.com',
    'https://ilinkai.weixin.qq.com:444', 'https://ilinkai.weixin.qq.com/path',
    'https://ilinkai.weixin.qq.com/?token=x']) {
    assert.throws(() => client(() => { throw new Error('unexpected'); }, { baseUrl }), TypeError);
  }
  assert.equal(client(() => {}, { baseUrl: 'https://region.weixin.qq.com' }).baseUrl,
    'https://region.weixin.qq.com');
});

test('later explicit rejection does not erase earlier ambiguous send', async () => {
  let attempts = 0;
  const api = client(async () => {
    attempts++;
    if (attempts === 1) throw new TypeError('lost response');
    return json({ ret: -14 });
  });
  await assert.rejects(api.sendText(request), error => {
    assert.equal(error.code, 'network-error');
    assert.equal(error.uncertain, true);
    return true;
  });
  assert.equal(attempts, 1);
});

test('malformed send response is uncertain, pre-aborted send is not', async () => {
  const api = client(async () => new Response('{', { status: 200 }), { retryAttempts: 1 });
  await assert.rejects(api.sendText(request), error => error.code === 'invalid-response' && error.uncertain);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(api.sendText(request, pre.signal), error => error.code === 'aborted' && !error.uncertain);
});
