import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeMediaItems } from './ilink.mjs';
import { isContextToken } from './push.mjs';

const MAX_INBOX = 1_000;
const MAX_MEDIA_ITEMS = 16;
const MAX_MESSAGE_ITEMS = 64;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_MEDIA_PARAM_BYTES = 8192;
const MAX_MEDIA_URL_BYTES = 2048;
const MAX_MEDIA_NAME_BYTES = 255;
const FIELDS = ['version', 'enabled', 'sessionId', 'cursor', 'inbox', 'outbox', 'seen', 'binding'];
const initialState = () => ({ version: 1, enabled: false, sessionId: null, cursor: '', inbox: [], outbox: [], seen: [], binding: null });

function validate(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || Object.keys(state).some((key) => !FIELDS.includes(key))
    || FIELDS.some((key) => !Object.hasOwn(state, key))
    || state.version !== 1 || typeof state.enabled !== 'boolean'
    || (state.sessionId !== null && typeof state.sessionId !== 'string')
    || typeof state.cursor !== 'string' || !Array.isArray(state.inbox)
    || state.inbox.length > MAX_INBOX || !Array.isArray(state.outbox)
    || !Array.isArray(state.seen)
    || (state.binding !== null && (typeof state.binding !== 'object' || Array.isArray(state.binding)))) {
    throw new TypeError('Invalid store state');
  }
  const json = JSON.stringify(state, (_key, value) => {
    if (['bigint', 'function', 'symbol', 'undefined'].includes(typeof value)
      || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new TypeError('Store state must contain only JSON values');
    }
    return value;
  });
  return { json: `${json}\n`, value: JSON.parse(json) };
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EBADF'].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function persist(directory, state) {
  const { json, value } = validate(state);
  const temp = path.join(directory, `.store-${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(json, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, path.join(directory, 'store.json'));
    renamed = true;
    await syncDirectory(directory);
    return value;
  } catch (error) {
    if (renamed) error.storeCommitUncertain = true;
    throw error;
  } finally {
    if (!renamed) await fs.rm(temp, { force: true }).catch(() => {});
  }
}

const OUTBOX_SEEN_PREFIX = '\u0000outbox\u0000';
const outboxSeenId = (id) => `${OUTBOX_SEEN_PREFIX}${id}`;

function compact(state) {
  const seen = new Set(state.seen);
  state.inbox = state.inbox.filter((item) => {
    if (item.status !== 'done' && item.status !== 'cancelled') return true;
    seen.add(item.id);
    return false;
  });
  state.outbox = state.outbox.filter((item) => {
    if (item.status !== 'sent' && item.status !== 'cancelled') return true;
    seen.add(outboxSeenId(item.id));
    return false;
  });
  state.seen = [...seen];
}

function boundedString(value, limit, label) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > limit
    || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`Invalid media ${label}`);
  return value;
}

function boundedMediaDescriptors(message) {
  const items = message.item_list;
  if (!Array.isArray(items)) return [];
  if (items.length > MAX_MESSAGE_ITEMS) throw new RangeError('Too many message items');
  const projected = [];
  for (const item of items) {
    const kind = item?.type === 2 ? 'image' : item?.type === 4 ? 'file' : item?.type === 5 ? 'video' : null;
    if (!kind) continue;
    if (projected.length >= MAX_MEDIA_ITEMS) throw new RangeError('Too many media items');
    const value = item[`${kind}_item`];
    const raw = value?.media;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Invalid media descriptor');
    const media = {};
    if (raw.encrypt_query_param !== undefined) media.encrypt_query_param = boundedString(raw.encrypt_query_param, MAX_MEDIA_PARAM_BYTES, 'query');
    if (raw.full_url !== undefined) {
      media.full_url = boundedString(raw.full_url, MAX_MEDIA_URL_BYTES, 'URL');
      let url;
      try { url = new URL(media.full_url); } catch { throw new TypeError('Invalid media URL'); }
      if (url.protocol !== 'https:' || url.hostname !== 'novac2c.cdn.weixin.qq.com'
        || url.pathname !== '/c2c/download' || url.username || url.password || url.hash
        || (url.port && url.port !== '443')) throw new TypeError('Invalid media URL');
    }
    if (!media.encrypt_query_param && !media.full_url) throw new TypeError('Missing media location');
    if (raw.encrypt_type === 0) media.encrypt_type = 0;
    else media.aes_key = boundedString(value.aeskey ?? raw.aes_key, 128, 'key');
    const clean = { media };
    if (kind === 'file' && value.file_name !== undefined) {
      const name = boundedString(value.file_name, MAX_MEDIA_NAME_BYTES, 'name');
      if (name === '.' || name === '..' || /[\\/]/.test(name)) throw new TypeError('Invalid media name');
      clean.file_name = name;
    }
    if (kind === 'file' && value.len !== undefined) {
      if (!(typeof value.len === 'number' || (typeof value.len === 'string' && /^\d{1,16}$/.test(value.len)))) throw new TypeError('Invalid media size');
      const size = Number(value.len);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_MEDIA_BYTES) throw new RangeError('Media too large');
      clean.len = size;
    }
    projected.push({ type: item.type, [`${kind}_item`]: clean });
  }
  const media = normalizeMediaItems(projected);
  if (media.length !== projected.length) throw new TypeError('Invalid media encryption key');
  if (media.reduce((total, item) => total + (item.size ?? 0), 0) > MAX_MEDIA_BYTES) throw new RangeError('Message media too large');
  // The normalizer receives only whitelisted, bounded wire fields above.
  return media;
}

function messageContent(message) {
  if (!Array.isArray(message.item_list)) return null;
  for (const item of message.item_list) {
    const text = item?.type === 1 ? item.text_item?.text : null;
    if (typeof text === 'string' && text.trim()) return { text: text.trim(), sourceKind: 'text' };
  }
  for (const item of message.item_list) {
    const text = item?.type === 3 ? item.voice_item?.text : null;
    if (typeof text === 'string' && text.trim()) return { text: text.trim(), sourceKind: 'voice' };
  }
  return null;
}

function lockError(lockPath, reason) {
  return Object.assign(new Error(`WeChat store is locked: ${reason} (${lockPath})`), { code: 'EEXIST' });
}

async function inspectLock(lockPath) {
  let handle;
  try {
    handle = await fs.open(lockPath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32) throw lockError(lockPath, 'invalid owner record; manual inspection required');
    const raw = (await handle.readFile('utf8')).trim();
    if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2147483647) {
      throw lockError(lockPath, 'invalid owner PID; manual inspection required');
    }
    const pid = Number(raw);
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return stat;
      throw lockError(lockPath, `cannot verify whether owner PID ${pid} has exited`);
    }
    throw lockError(lockPath, `owner PID ${pid} is still running`);
  } finally {
    await handle?.close();
  }
}

async function acquireLock(directory) {
  const lockPath = path.join(directory, 'store.lock');
  try {
    return await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  // Only enter recovery after proving the recorded owner is gone. Live or
  // unverifiable PIDs (including reused PIDs) must never lose their lock.
  try {
    await inspectLock(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return fs.open(lockPath, 'wx', 0o600);
  }
  const recoveryPath = path.join(directory, 'store.lock.recover');
  let recovery;
  try {
    recovery = await fs.open(recoveryPath, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw lockError(lockPath, 'another recovery is in progress; if it has exited, inspect store.lock.recover manually');
  }
  try {
    await recovery.writeFile(`${process.pid}\n`);
    // Recheck after acquiring the recovery gate. Another process may already
    // have reclaimed the old lock and started writing the queue.
    let stale;
    try {
      stale = await inspectLock(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (stale) {
      const current = await fs.stat(lockPath);
      if (current.dev !== stale.dev || current.ino !== stale.ino) {
        throw lockError(lockPath, 'owner changed during recovery; retry startup');
      }
      await fs.unlink(lockPath);
    }
    return await fs.open(lockPath, 'wx', 0o600);
  } finally {
    // A crash within this short recovery window leaves the gate for manual
    // inspection rather than allowing competing recoverers to steal a lock.
    try { await recovery.close(); } finally { await fs.unlink(recoveryPath); }
  }
}

/**
 * Single-process JSON store. store.lock contains the owning PID. A lock is
 * reclaimed only when the OS reports ESRCH for a valid recorded PID. Recovery
 * is serialized by store.lock.recover; a leftover recovery gate, invalid PID,
 * or live/reused PID requires manual inspection and is never auto-stolen.
 * update(mutator) receives a private draft and commits its mutations serially. Do not
 * modify a draft after its mutator settles. Inbox 'done'/'cancelled' and outbox
 * 'sent'/'cancelled' are terminal: they are pruned on commit, retaining seen IDs.
 * Failed pre-rename writes leave state intact. A post-rename sync failure marks the
 * store unusable until reopened and reconciled.
 */
export class Store {
  #directory;
  #lock;
  #state;
  #pending = Promise.resolve();
  #closed = false;
  #closing;
  #uncertain = false;

  constructor(directory, lock, state) {
    this.#directory = directory;
    this.#lock = lock;
    this.#state = state;
  }

  static async open(directory) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('directory is required');
    const resolved = path.resolve(directory);
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    const lockPath = path.join(resolved, 'store.lock');
    const lock = await acquireLock(resolved);
    try {
      await lock.writeFile(`${process.pid}\n`);
      await lock.sync();
      await syncDirectory(resolved);
      let state;
      try {
        const raw = await fs.readFile(path.join(resolved, 'store.json'), 'utf8');
        state = validate(JSON.parse(raw)).value;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = await persist(resolved, initialState());
      }
      return new Store(resolved, lock, state);
    } catch (error) {
      await lock.close();
      await fs.rm(lockPath, { force: true });
      throw error;
    }
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  update(mutator) {
    if (this.#closed || this.#uncertain) return Promise.reject(new Error('Store is closed or requires reopening'));
    if (typeof mutator !== 'function') return Promise.reject(new TypeError('mutator must be a function'));
    const work = this.#pending.then(async () => {
      if (this.#uncertain) throw new Error('Store requires reopening');
      const draft = this.snapshot();
      const result = await mutator(draft);
      compact(draft);
      try {
        this.#state = await persist(this.#directory, draft);
      } catch (error) {
        if (error.storeCommitUncertain) this.#uncertain = true;
        throw error;
      }
      return result;
    });
    this.#pending = work.catch(() => {});
    return work;
  }

  /** Admit owner text, voice transcription and normalized media with cursor in one commit.
   * Returns admitted count. Exceeding 1,000 pending entries rejects the full batch.
   * media is optional: [{kind,media:{encrypt_query_param?,full_url?,aes_key},name?,size?}].
   * Media-only entries use sourceKind:'media'; literal text wins over voice. Existing
   * text-only entries and persisted v1 states need no migration. Up to 16 attachments,
   * 64 total items, and 50MiB combined declared file sizes per message; names <=255
   * UTF-8 bytes, query <=8192 bytes, CDN URLs <=2048 bytes, keys <=128 bytes.
   * Invalid media descriptors produce a descriptor-free mediaError inbox entry;
   * capacity/storage failures still reject the entire batch. Download enforces actual size.
   * update() can persist later status/sessionId/requestId fields on entries.
   */
  ingest(messages, nextCursor, ownerId) {
    if (!Array.isArray(messages) || typeof nextCursor !== 'string'
      || typeof ownerId !== 'string' || !ownerId) {
      return Promise.reject(new TypeError('Invalid ingest arguments'));
    }
    return this.update((state) => {
      const known = new Set([...state.seen, ...state.inbox.map((item) => item.id)]);
      const admitted = [];
      for (const message of messages) {
        if (message?.message_type !== 1 || message.from_user_id !== ownerId
          || message.message_id === null || message.message_id === undefined) continue;
        const id = String(message.message_id).trim();
        if (!id || known.has(id)) continue;
        let media;
        let mediaError = false;
        try {
          media = boundedMediaDescriptors(message);
        } catch (error) {
          if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
          media = [];
          mediaError = true;
        }
        const extracted = messageContent(message);
        const unsupported = !mediaError && !extracted && media.length === 0 && Array.isArray(message.item_list)
          && message.item_list.some((item) => item?.type !== 1);
        if (!mediaError && !extracted && !media.length && !unsupported) continue;
        known.add(id);
        if (state.binding?.ownerId === ownerId && isContextToken(message.context_token)) {
          state.binding.context = { token: message.context_token, receivedAt: Date.now() };
        }
        admitted.push({ id, userId: ownerId,
          contextToken: typeof message.context_token === 'string' ? message.context_token : '',
          text: mediaError ? '[媒体附件无法处理]' : extracted?.text ?? (media.length ? '[收到媒体附件]' : '[收到不支持的媒体消息]'),
          sourceKind: extracted?.sourceKind ?? (mediaError || media.length ? 'media' : 'unsupported'), status: 'queued',
          ...(media.length ? { media } : {}),
          ...(mediaError ? { mediaError: true } : {}),
          ...(unsupported ? { unsupported: true } : {}) });
      }
      if (state.inbox.filter((item) => item.status !== 'done' && item.status !== 'cancelled').length + admitted.length > MAX_INBOX) {
        throw new RangeError('Inbox capacity exceeded; cursor was not advanced');
      }
      state.inbox.push(...admitted);
      state.seen.push(...admitted.map((item) => item.id));
      state.cursor = nextCursor;
      return admitted.length;
    });
  }

  /** Enqueue {id, userId, contextToken, text} with status:'queued'; returns false for duplicate IDs. */
  enqueue(entry) {
    if (!entry || typeof entry !== 'object'
      || !['id', 'userId', 'contextToken', 'text'].every((key) => typeof entry[key] === 'string')
      || !entry.id || !entry.userId || !entry.text) {
      return Promise.reject(new TypeError('Invalid outbound entry'));
    }
    return this.update((state) => {
      if (state.seen.includes(outboxSeenId(entry.id))
        || state.outbox.some((item) => item.id === entry.id)) return false;
      state.outbox.push({ id: entry.id, userId: entry.userId,
        contextToken: entry.contextToken, text: entry.text, status: 'queued' });
      return true;
    });
  }

  /** Wait for queued writes, then release the lock. Repeated calls are harmless. */
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      await this.#pending;
      await this.#lock.close();
      await fs.unlink(path.join(this.#directory, 'store.lock'));
      await syncDirectory(this.#directory);
    })();
    return this.#closing;
  }
}
