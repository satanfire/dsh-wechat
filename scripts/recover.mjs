import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Store } from '../src/store.mjs';

export async function recover(store, action, id) {
  if (action === 'list') return store.snapshot().inbox
    .filter(row => ['failed', 'needs-review', 'submitted', 'dispatching'].includes(row.status))
    .map(({ id, status, sessionId, requestId, failure }) => ({ id, status,
      sessionId: sessionId ?? null, requestId: requestId ?? null, stage: failure?.stage ?? null }));
  if (!['retry', 'discard', 'hold'].includes(action) || !id) throw new Error('Expected list, retry ID, discard ID, or hold ID');
  return store.update(state => {
    const row = state.inbox.find(item => item.id === id);
    if (action === 'hold') {
      if (!row || !['submitted', 'dispatching'].includes(row.status)) throw new Error('No matching tracked request');
      row.status = 'needs-review';
      row.failure = { stage: 'wait', code: 'manual-hold' };
      return { id, status: row.status };
    }
    if (!row || !['failed', 'needs-review'].includes(row.status)) throw new Error('No matching failed inbound message');
    if (action === 'retry') {
      if (row.status !== 'failed' || !['prepare', 'create'].includes(row.failure?.stage)) {
        throw new Error('Cannot retry a request whose submission outcome is uncertain');
      }
      row.status = 'queued';
      delete row.failure;
    } else row.status = 'cancelled';
    return { id, status: row.status };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const profile = args[0] === '--profile' ? args.splice(0, 2)[1] : process.env.DSH_PROFILE ?? 'default';
  if (!/^[a-z][a-z0-9-]*$/.test(profile)) throw new Error('Invalid profile');
  const [action, id, ...extra] = args;
  if (extra.length || !['list', 'retry', 'discard', 'hold'].includes(action) || (action !== 'list' && !id)) {
    throw new Error('Usage: node scripts/recover.mjs --profile PROFILE list|retry ID|discard ID|hold ID');
  }
  const root = process.env.DSH_HOME || path.join(homedir(), '.dsh');
  const store = await Store.open(path.join(root, 'storages', 'dsh-wechat', profile));
  try { console.log(JSON.stringify(await recover(store, action, id), null, 2)); }
  finally { await store.close(); }
}
