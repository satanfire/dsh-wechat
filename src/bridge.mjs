import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const CONTROL = new Set(['/stop', '/status', '/help', '/approve', '/reject', '/answer']);
const command = text => text.trim().split(/\s+/)[0].toLowerCase();
const errorName = error => typeof error?.code === 'string' ? error.code : 'bridge-error';
const sessionFor = id => `session-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
const isAuthFailure = error => error?.providerCode === '-14' || error?.providerCode === '401'
  || error?.status === 401 || error?.status === 403;

const canConfirm = item => typeof item.contextToken === 'string' && !!item.contextToken.trim()
  && !/[\r\n\0]/.test(item.contextToken)
  && typeof item.text === 'string' && !item.text.trimStart().startsWith('/');
const boundedMs = (value, fallback) => Number.isSafeInteger(value) && value > 0 && value <= 60_000 ? value : fallback;

/** Optional feedback: bounded, serial, and never delays task admission. */
function typingFeedback(client, item, parentSignal, intervalMs, timeoutMs, state) {
  if (typeof client.sendTyping !== 'function' || !canConfirm(item)) return async () => {};
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  parentSignal.addEventListener('abort', abort, { once: true });
  if (parentSignal.aborted) abort();
  async function send(typing, signal) {
    if (state.active || signal?.aborted) return false;
    const controller = new AbortController();
    let timer, off;
    const interrupted = new Promise(resolve => {
      off = () => { controller.abort(); resolve(false); };
      signal?.addEventListener('abort', off, { once: true });
      timer = setTimeout(off, timeoutMs);
    });
    const request = Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      return client.sendTyping({ userId: item.userId, contextToken: item.contextToken, typing }, controller.signal);
    });
    state.active = request;
    const settled = request.then(() => true, () => false).finally(() => { if (state.active === request) state.active = null; });
    try { return await Promise.race([settled, interrupted]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', off); }
  }
  const loop = (async () => {
    while (!lifetime.signal.aborted) {
      await send(true, lifetime.signal);
      if (state.active || lifetime.signal.aborted) break;
      try { await delay(intervalMs, undefined, { signal: lifetime.signal }); } catch { break; }
    }
  })();
  let cleanup;
  return () => cleanup ??= (async () => {
    lifetime.abort();
    parentSignal.removeEventListener('abort', abort);
    await loop;
    if (state.active) {
      let timer;
      try {
        await Promise.race([
          state.active.catch(() => {}),
          new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
    }
    if (!state.active) await send(false);
  })();
}

/** Owns durable inbound dispatch and outbound delivery for a single bound account. */
export class Bridge {
  #store; #client; #harness; #ownerId; #interactions;
  #abort; #pollTask; #workTask; #sendTask; #timer; #controlTasks = new Set();
  #closing; #running = false; #connected = false; #error = null;
  #typingIntervalMs; #typingTimeoutMs; #typingState = { active: null };

  constructor({ store, client, harness, ownerId, interactions, media, outbound, attachments, typingIntervalMs = 8000, typingTimeoutMs = 3000 }) {
    if (!store || !client || !harness || !ownerId) throw new TypeError('Bridge dependencies required');
    this.#store = store; this.#client = client; this.#harness = harness;
    this.#ownerId = ownerId; this.#interactions = interactions;
    this.media = media;
    this.outbound = outbound;
    this.attachments = attachments;
    this.#typingIntervalMs = boundedMs(typingIntervalMs, 8000);
    this.#typingTimeoutMs = boundedMs(typingTimeoutMs, 3000);
  }
  get connected() { return this.#connected; }
  get error() { return this.#error; }
  get status() { return { running: this.#running && !this.#closing, connected: this.#connected, error: this.#error }; }
  async start() {
    if (this.#closing) throw new Error('Bridge stopping');
    if (this.#running) return;
    this.#running = true; this.#abort = new AbortController();
    try {
      await this.#store.update(state => {
        for (const row of state.outbox) {
          if (row.status === 'sending') row.status = 'uncertain';
          if (row.status === 'queued' && row.id.startsWith('wechat-received-')) row.status = 'cancelled';
        }
        for (const row of state.inbox) if (row.status === 'control-pending') row.status = 'needs-review';
      });
      this.#timer = setInterval(() => { this.#handleControls(); this.#wake(); }, 250);
      this.#timer.unref?.();
      this.#pollTask = this.#poll(this.#abort.signal);
      this.#wake(); this.#handleControls();
    } catch (error) { clearInterval(this.#timer); this.#running = false; throw error; }
  }
  async stop() {
    if (this.#closing) return this.#closing;
    if (!this.#running) return;
    this.#closing = (async () => {
      clearInterval(this.#timer);
      this.#abort.abort();
      await Promise.allSettled([this.#pollTask, this.#workTask, this.#sendTask, ...this.#controlTasks]);
      this.#running = false; this.#connected = false; this.#closing = null;
    })();
    return this.#closing;
  }
  async #poll(signal) {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const batch = await this.#client.getUpdates(this.#store.snapshot().cursor, signal);
        if (signal.aborted) break;
        if (!Array.isArray(batch?.msgs) || typeof batch.get_updates_buf !== 'string') throw Error('Invalid updates');
        await this.#store.ingest(batch.msgs, batch.get_updates_buf, this.#ownerId);
        this.#connected = true; this.#error = null; failures = 0;
        if (signal.aborted) break;
        this.#handleControls(); this.#wake();
        // Avoid a busy loop if the provider returns an empty batch immediately.
        try { await delay(100, undefined, { signal }); } catch { break; }
      } catch (error) {
        if (signal.aborted) break;
        this.#connected = false;
        if (isAuthFailure(error)) { this.#error = 'requires-login'; break; }
        this.#error = errorName(error);
        try { await delay(Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5)), undefined, { signal }); }
        catch { break; }
      }
    }
  }
  #enqueue(state, item, text) {
    if (typeof text !== 'string' || !text) return;
    const chars = Array.from(text);
    for (let offset = 0, index = 0; offset < chars.length; offset += 800, index++) {
      const id = `wechat-reply-${item.id}-${index}`;
      if (!state.outbox.some(row => row.id === id) && !state.seen.includes(`\0outbox\0${id}`)) state.outbox.push({
        id, userId: item.userId, contextToken: item.contextToken,
        text: chars.slice(offset, offset + 800).join(''), status: 'queued',
      });
    }
  }
  #handleControls() {
    for (const item of this.#store.snapshot().inbox) {
      if (item.status !== 'queued' || !CONTROL.has(command(item.text))) continue;
      const task = this.#handleControl(item).catch(error => { this.#error = errorName(error); });
      this.#controlTasks.add(task); task.finally(() => this.#controlTasks.delete(task));
    }
  }
  async #handleControl(item) {
    const claimed = await this.#store.update(state => {
      const row = state.inbox.find(r => r.id === item.id);
      if (!row || row.status !== 'queued') return false;
      row.status = 'control-pending'; return true;
    });
    if (!claimed) return;
    try {
      let text;
      if (item.sourceKind !== 'text') text = '仅文字消息可执行微信命令';
      else if (command(item.text) === '/stop') {
        const id = this.#store.snapshot().sessionId;
        if (id) await this.#harness.cancel(id);
        text = id ? '已请求停止当前任务' : '目前没有绑定的会话';
      } else if (command(item.text) === '/status') text = this.#connected ? '微信连接正常' : '微信连接中';
      else if (command(item.text) === '/help') text = '/new 新会话；/status 状态；/stop 停止；/approve、/reject、/answer 回复待处理请求';
      else {
        const result = await this.#interactions?.answer?.({ ...item, sessionId: this.#store.snapshot().sessionId });
        text = result?.message ?? '目前没有可处理的审批或追问';
      }
      await this.#store.update(state => {
        const row = state.inbox.find(r => r.id === item.id);
        if (row) { row.status = 'done'; this.#enqueue(state, row, text); }
      });
      this.#wake();
    } catch (error) {
      await this.#store.update(state => {
        const row = state.inbox.find(r => r.id === item.id);
        if (row) { row.status = 'needs-review'; row.failure = { stage: 'control', code: errorName(error) }; }
      });
      throw error;
    }
  }
  #wake() {
    if (!this.#running || this.#closing) return;
    if (!this.#workTask) {
      const task = this.#workLoop(); this.#workTask = task;
      task.catch(error => { this.#error = errorName(error); }).finally(() => { if (this.#workTask === task) this.#workTask = null; });
    }
    if (!this.#sendTask) {
      const task = this.#sendLoop(); this.#sendTask = task;
      task.catch(error => { this.#error = errorName(error); }).finally(() => { if (this.#sendTask === task) this.#sendTask = null; });
    }
  }
  async #workLoop() {
    const signal = this.#abort.signal;
    while (!signal.aborted) {
      if (signal.aborted) return;
      const item = this.#store.snapshot().inbox.find(r =>
        (r.status === 'queued' && !CONTROL.has(command(r.text))) || r.status === 'dispatching' || r.status === 'submitted');
      if (!item) return;
      if (item.unsupported || item.mediaError || (command(item.text) === '/new' && item.sourceKind !== 'text')) {
        await this.#store.update(state => {
          const r = state.inbox.find(row => row.id === item.id);
          if (r) { r.status = 'done'; this.#enqueue(state, r, item.mediaError ? '附件格式无效或超过大小限制，请重新发送较小的图片、文件或视频。' : '该消息格式暂不支持；控制命令请使用文字发送。'); }
        });
        this.#wake(); continue;
      }
      if (command(item.text) === '/new') {
        try {
          const requestedId = sessionFor(`new:${item.id}`);
          const created = await this.#harness.createSession(requestedId);
          const sessionId = typeof created === 'string' ? created : created?.sessionId;
          if (typeof sessionId !== 'string' || !sessionId) throw Error('Invalid created session');
          await this.#store.update(state => {
            state.sessionId = sessionId;
            const r = state.inbox.find(row => row.id === item.id);
            if (r) { r.status = 'done'; this.#enqueue(state, r, '已创建新会话'); }
          });
          this.#wake();
        } catch (error) {
          this.#error = errorName(error);
          await this.#store.update(state => {
            const r = state.inbox.find(row => row.id === item.id);
            if (r) { r.status = 'failed'; r.failure = { stage: 'create', code: errorName(error) }; }
          });
        }
        continue;
      }
      try { await this.#process(item, signal); }
      catch (error) {
        if (signal.aborted) return;
        if (error.code === 'observation-timeout') {
          try { await delay(1000, undefined, { signal }); } catch { return; }
          continue;
        }
        this.#error = errorName(error);
        await this.#store.update(state => {
          const r = state.inbox.find(row => row.id === item.id);
          if (r && r.status !== 'done') {
            r.status = error.beforeSubmission ? 'failed' : 'needs-review';
            r.failure = { stage: error.stage ?? 'unknown', code: errorName(error) };
            this.#enqueue(state, { ...r, id: `failure-${r.id}` }, error.beforeSubmission
              ? '任务准备失败，尚未提交给 DSH。请在 DSH 中检查微信插件后重试。'
              : '请求状态无法确认，已暂停自动处理；请在 DSH 中人工核查，避免重复执行。');
          }
        });
      }
    }
  }
  async #process(item, signal) {
    const requestId = item.requestId ?? `wechat-${item.id}`;
    let retireOutbound;
    let stage = item.status === 'queued' ? 'prepare' : 'lookup';
    const stopTyping = typingFeedback(this.#client, item, signal, this.#typingIntervalMs, this.#typingTimeoutMs, this.#typingState);
    try {
    let sessionId = item.sessionId ?? this.#store.snapshot().sessionId;
    if (!sessionId) {
      const created = await this.#harness.createSession(sessionFor(`first:${item.id}`));
      sessionId = typeof created === 'string' ? created : created?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) throw Error('Invalid created session');
      if (signal.aborted) return;
      await this.#store.update(state => { state.sessionId = sessionId; });
    }
    let content = item.text;
    if (item.status === 'queued' && item.media?.length) {
      try {
        if (!this.media) throw new Error('Media handler unavailable');
        content = await this.media.prepare(item, sessionId, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof RangeError || error instanceof TypeError)
          && !['invalid-media-key', 'untrusted-media-url', 'media-too-large',
            'invalid-media-ciphertext', 'media-decryption-failed'].includes(error.code)) throw error;
        await this.#store.update(state => {
          const row = state.inbox.find(r => r.id === item.id);
          if (row) { row.status = 'done'; this.#enqueue(state, row, '附件处理失败或超过大小限制，请重新发送较小的附件。'); }
        });
        this.#wake(); return;
      }
    }
    if (item.status === 'queued') {
      await this.#store.update(state => {
        const r = state.inbox.find(row => row.id === item.id);
        r.status = 'dispatching'; r.requestId = requestId; r.sessionId = sessionId;
      });
      if (signal.aborted) return;
      if (this.outbound) retireOutbound = await this.outbound(sessionId, requestId);
      stage = 'submit';
      await this.#harness.submit(sessionId, requestId, content, signal);
      if (signal.aborted) return;
      await this.#store.update(state => { state.inbox.find(r => r.id === item.id).status = 'submitted'; });
    } else if (item.status === 'dispatching') {
      const found = await this.#harness.lookupRequest(sessionId, requestId, signal);
      if (!['pending', 'admitted', 'completed'].includes(found?.status)) {
        await this.#store.update(state => {
          const r = state.inbox.find(row => row.id === item.id);
          r.status = 'needs-review';
          this.#enqueue(state, { ...r, id: `failure-${r.id}` }, '请求状态无法确认，已暂停自动处理；请在 DSH 中人工核查，避免重复执行。');
        });
        this.#wake();
        return; // Unknown never replays a potentially admitted prompt.
      }
      await this.#store.update(state => { state.inbox.find(r => r.id === item.id).status = 'submitted'; });
    }
    if (!retireOutbound && this.outbound) retireOutbound = await this.outbound(sessionId, requestId);
    stage = 'wait';
    const reply = await this.#harness.waitForReply(sessionId, requestId, signal);
    await stopTyping();
    if (signal.aborted) return;
    await this.#store.update(state => {
      const r = state.inbox.find(row => row.id === item.id);
      r.status = 'done'; this.#enqueue(state, r, reply);
    });
    this.#wake();
    } catch (error) {
      throw Object.assign(new Error('WeChat task failed', { cause: error }), {
        code: errorName(error), stage, beforeSubmission: stage === 'prepare',
      });
    } finally {
      try { await stopTyping(); } finally { await retireOutbound?.(); }
    }
  }
  async #sendLoop() {
    const signal = this.#abort.signal;
    while (!signal.aborted) {
      const entries = this.#store.snapshot().outbox;
      const item = entries.find(r => r.status === 'queued' && (
        !r.id.startsWith('wechat-reply-') || !entries.some(previous =>
          previous.status === 'uncertain'
          && previous.id.startsWith(r.id.slice(0, r.id.lastIndexOf('-') + 1)))));
      if (!item) return;
      try {
        await this.#store.update(state => { state.outbox.find(r => r.id === item.id).status = 'sending'; });
        if (signal.aborted) return;
        if (item.media) {
          if (!this.attachments) throw new Error('Attachment service unavailable');
          const buffers = []; let size = 0;
          for await (const chunk of this.attachments.readFileStream(item.media.attachment, signal)) {
            size += chunk.byteLength;
            if (size > 50 * 1024 * 1024) throw new RangeError('Outbound media too large');
            buffers.push(chunk);
          }
          await this.#client.sendMedia({ userId: item.userId, contextToken: item.contextToken,
            clientId: item.id, kind: item.media.kind, name: item.media.name, bytes: Buffer.concat(buffers, size) }, signal);
        } else {
          await this.#client.sendText({ userId: item.userId, contextToken: item.contextToken,
            text: item.text, clientId: item.id }, signal);
        }
        if (signal.aborted) return;
        await this.#store.update(state => { state.outbox.find(r => r.id === item.id).status = 'sent'; });
      } catch (error) {
        if (signal.aborted) return;
        const status = (item.media && error?.uncertain !== true)
          || error?.uncertain === false ? 'failed' : 'uncertain';
        await this.#store.update(state => {
          state.outbox.find(r => r.id === item.id).status = status;
          if (status === 'failed' && item.id.startsWith('wechat-reply-')) {
            const group = item.id.slice(0, item.id.lastIndexOf('-') + 1);
            for (const row of state.outbox) {
              if (row.id.startsWith(group) && row.status === 'queued') row.status = 'cancelled';
            }
          }
        });
        this.#error = status === 'failed' ? 'send-failed' : 'send-uncertain';
        return;
      }
    }
  }
}
