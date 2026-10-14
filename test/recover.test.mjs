import test from 'node:test';
import assert from 'node:assert/strict';
import { recover } from '../scripts/recover.mjs';

test('recovery output omits payload/context and uncertain submissions cannot retry', async () => {
  const state = {inbox:[
    {id:'failed',status:'failed',text:'private',contextToken:'secret',failure:{stage:'prepare'}},
    {id:'unknown',status:'needs-review',text:'private',failure:{stage:'submit'}},
    {id:'tracked',status:'submitted',requestId:'request-id',text:'private'},
  ],seen:[]};
  const store = {snapshot:() => structuredClone(state), update:async fn => fn(state)};
  const output = JSON.stringify(await recover(store, 'list'));
  assert.doesNotMatch(output, /private|secret|text|contextToken/);
  await assert.rejects(recover(store, 'retry', 'unknown'), /uncertain/);
  assert.equal((await recover(store, 'retry', 'failed')).status, 'queued');
  assert.equal((await recover(store, 'discard', 'unknown')).status, 'cancelled');
  assert.equal((await recover(store, 'hold', 'tracked')).status, 'needs-review');
  assert.equal(state.inbox[2].requestId, 'request-id');
  await assert.rejects(recover(store, 'retry', 'tracked'), /uncertain/);
  await assert.rejects(recover(store, 'discard', 'missing'), /No matching/);
});
