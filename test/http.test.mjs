import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHttp } from '../src/http.mjs';

function setup() {
  const calls = [];
  let route;
  let disposed = false;
  const controller = {
    async status() { return { connected: false, enabled: false, queueDepth: 0, login: { status: 'idle' } }; },
    async action(name) { calls.push(name); },
  };
  const ctx = { connection: { fetch: { register(next) { route = next; return () => { disposed = true; }; } } } };
  const dispose = registerHttp(ctx, controller);
  return { controller, calls, route, dispose, get disposed() { return disposed; } };
}

const post = (body, headers = { 'content-type': 'application/json' }) => new Request('http://localhost/api/dsh-wechat', {
  method: 'POST', body, headers,
});

test('registers the authenticated shared Connection route and disposes it', async () => {
  const fixture = setup();
  assert.equal(fixture.route.path, '/api/dsh-wechat');
  assert.deepEqual(fixture.route.methods, ['GET', 'POST']);
  assert.equal(fixture.route.requestBody, 'buffered');
  const response = await fixture.route.fetch(new Request('http://localhost/api/dsh-wechat'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).enabled, false);
  assert.deepEqual(fixture.calls, []);
  fixture.dispose();
  assert.equal(fixture.disposed, true);
});

test('executes only explicit allowed actions and returns fresh status', async () => {
  const fixture = setup();
  for (const action of ['login', 'start', 'stop', 'logout']) {
    const response = await fixture.route.fetch(post(JSON.stringify({ action })));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).login.status, 'idle');
  }
  assert.deepEqual(fixture.calls, ['login', 'start', 'stop', 'logout']);
});

test('rejects oversized, malformed, non-JSON, and unrecognized action bodies', async () => {
  const fixture = setup();
  for (const [request, status] of [
    [post('{'), 400],
    [post('{}'), 400],
    [post('{"action":"restart"}'), 400],
    [post('{"action":"start","extra":1}'), 400],
    [post('{"action":"start"}', { 'content-type': 'text/plain' }), 415],
    [post('x'.repeat(4097)), 413],
  ]) assert.equal((await fixture.route.fetch(request)).status, status);
  assert.deepEqual(fixture.calls, []);
});

test('does not leak provider errors or credentials to the browser', async () => {
  const fixture = setup();
  fixture.controller.status = () => ({ connected: false, error: 'Bearer secret-token' });
  const status = await fixture.route.fetch(new Request('http://localhost/api/dsh-wechat'));
  assert.deepEqual(await status.json(), { connected: false, error: 'service-error' });
  fixture.controller.action = async () => { throw new Error('Bearer secret-token'); };
  const response = await fixture.route.fetch(post('{"action":"login"}'));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'operation-failed' });
});
