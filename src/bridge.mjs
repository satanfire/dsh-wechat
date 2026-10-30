import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { outboxSeenId, outboxFailedId } from './store.mjs';
import { visibleSessions, listedSessions, formatSessionList, sessionLabel } from './session-list.mjs';

const CONTROL = new Set(['/stop', '/status', '/help', '/list', '/switch', '/approve', '/reject', '/answer']);
/** How long one `/list` numbering stays valid for `/switch`. */
const SESSION_LIST_TTL_MS = 10 * 60 * 1000;
const command = text => text.trim().split(/\s+/)[0].toLowerCase();
const errorName = error => typeof error?.code === 'string' ? error.code : 'bridge-error';
const sessionFor = id => `session-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
const isAuthFailure = error => error?.providerCode === '-14' || error?.providerCode === '401'
  || error?.status === 401 || error?.status === 403;
/** iLink refuses a stale conversation context with ret -2 ("prepare failed") or -14. */
const isSessionStale = error => error?.providerCode === '-2' || error?.providerCode === '-14';

const canConfirm = item => typeof item.contextToken === 'string' && !!item.contextToken.trim()
  && !/[\r\n\0]/.test(item.contextToken)
  && typeof item.text === 'string' && !item.text.trimStart().startsWith('/');
const boundedMs = (value, fallback) => Number.isSafeInteger(value) && value > 0 && value <= 60_000 ? value : fallback;
/** Wait before each automatic retry of a failed outbound send; one entry per retry. */
const DEFAULT_SEND_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 360_000, 900_000];
const MAX_SEND_RETRY_DELAYS = 8;
const MAX_SEND_RETRY_DELAY_MS = 3_600_000;
/** iLink blocks bot-initiated sends until the owner messages again. Hold instead of retrying. */
const HELD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_HELD = 20;
/** Extra attempts for a message that failed before submission; nothing was admitted yet. */
const DEFAULT_PREPARE_RETRY_DELAYS_MS = [1_000, 3_000];
const MAX_PREPARE_RETRY_DELAYS = 3;
/** Failures kept for the settings status; bounded so one long incident cannot grow state. */
const MAX_RECORDED_FAILURES = 5;

/** Keep one bounded retry schedule; any invalid plan falls back to the default one. */
function retryDelays(value) {
  if (!Array.isArray(value) || value.length > MAX_SEND_RETRY_DELAYS) return DEFAULT_SEND_RETRY_DELAYS_MS;
  const delays = value.filter(ms => Number.isSafeInteger(ms) && ms >= 1 && ms <= MAX_SEND_RETRY_DELAY_MS);
  return delays.length === value.length ? delays : DEFAULT_SEND_RETRY_DELAYS_MS;
}

/** Failure label kept on a row: error code plus provider code when the provider named one. */
function sendFailure(error) {
  const code = errorName(error);
  const provider = error?.providerCode === undefined ? '' : `:${String(error.providerCode).slice(0, 32)}`;
  return `${code}${provider}`.slice(0, 80);
}

/** Flatten one error's code and message chain into the bounded diagnostic line. */
function failureDetail(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth++) {
    const code = typeof current?.code === 'string' ? current.code : '';
    const message = typeof current?.message === 'string' ? current.message : String(current);
    const part = `${code === '' ? '' : `${code}: `}${message}`.trim();
    if (part !== '') parts.push(part.slice(0, 300));
    current = current?.cause;
  }
  return parts.join(' <- ').slice(0, 600);
}

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
  #typingIntervalMs; #typingTimeoutMs; #typingState = { active: null }; #sessionList = null;
  #retryDelays; #prepareRetryDelays; #failures = [];

  constructor({ store, client, harness, ownerId, interactions, media, outbound, attachments, typingIntervalMs = 8000, typingTimeoutMs = 3000, sendRetryDelaysMs, prepareRetryDelaysMs }) {
    if (!store || !client || !harness || !ownerId) throw new TypeError('Bridge dependencies required');
    this.#store = store; this.#client = client; this.#harness = harness;
    this.#ownerId = ownerId; this.#interactions = interactions;
    this.media = media;
    this.outbound = outbound;
    this.attachments = attachments;
    this.#typingIntervalMs = boundedMs(typingIntervalMs, 8000);
    this.#typingTimeoutMs = boundedMs(typingTimeoutMs, 3000);
    this.#retryDelays = retryDelays(sendRetryDelaysMs);
    const prepare = prepareRetryDelaysMs === undefined
      ? DEFAULT_PREPARE_RETRY_DELAYS_MS
      : retryDelays(prepareRetryDelaysMs);
    this.#prepareRetryDelays = prepare.length > MAX_PREPARE_RETRY_DELAYS ? prepare.slice(0, MAX_PREPARE_RETRY_DELAYS) : prepare;
  }
  get connected() { return this.#connected; }
  get error() { return this.#error; }
  /** Recent dispatch failures with their stage and cause chain, oldest first. */
  get recentFailures() { return this.#failures.map(entry => ({ ...entry })); }
  get status() { return { running: this.#running && !this.#closing && !this.#abort?.signal.aborted, connected: this.#connected, error: this.#error }; }
  async start() {
    if (this.#closing) throw new Error('Bridge stopping');
    if (this.#running) return;
    this.#running = true; this.#abort = new AbortController();
    try {
      await this.#store.update(state => {
        for (const row of state.outbox) {
          if (row.status === 'sending') row.status = 'failed';
          if (row.status === 'queued' && row.id.startsWith('wechat-received-')) row.status = 'cancelled';
          if (row.status === 'held' && Number.isSafeInteger(row.heldAt)
            && Date.now() - row.heldAt > HELD_TTL_MS) row.status = 'failed';
        }
        for (const row of state.inbox) if (row.status === 'control-pending') row.status = 'failed';
      });
      this.#timer = setInterval(() => { this.#handleControls(); this.#wake(); }, 250);
      this.#timer.unref?.();
      this.#pollTask = this.#poll(this.#abort.signal);
      this.#notifyStart(this.#abort.signal);
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
      this.#notifyStop();
      this.#connected = false;
      await this.#store.update(state => {
        for (const row of state.outbox) if (row.status === 'sending') row.status = 'failed';
        for (const row of state.inbox) if (row.status === 'control-pending') row.status = 'failed';
      });
      this.#running = false;
    })().finally(() => { this.#closing = null; });
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
        await this.#releaseHeld();
        this.#connected = true;
        if (this.#error !== 'send-held') this.#error = null;
        failures = 0;
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
      if (!state.outbox.some(row => row.id === id)
        && !state.seen.includes(outboxSeenId(id)) && !state.seen.includes(outboxFailedId(id))) state.outbox.push({
        id, userId: item.userId, contextToken: item.contextToken,
        text: chars.slice(offset, offset + 800).join(''), status: 'queued',
      });
    }
  }
  #handleControls() {
    for (const item of this.#store.snapshot().inbox) {
      if (item.status !== 'queued' || !CONTROL.has(command(item.text))) continue;
      const task = this.#handleControl(item, this.#abort.signal).catch(error => { this.#error = errorName(error); });
      this.#controlTasks.add(task); task.finally(() => this.#controlTasks.delete(task));
    }
  }
  /** Sessions with a WeChat task that is still in flight. */
  #runningSessionIds() {
    const ids = new Set();
    for (const row of this.#store.snapshot().inbox) {
      if (row.sessionId && (row.status === 'dispatching' || row.status === 'submitted')) ids.add(row.sessionId);
    }
    return ids;
  }
  async #visibleSessions(currentSessionId, signal) {
    const { items } = await this.#harness.listSessions(signal);
    const archived = this.#harness.archivedSessionIds();
    return { items: visibleSessions(items, { archived, currentSessionId }), archived };
  }
  async #stopCurrentSession() {
    const sessionId = this.#store.snapshot().sessionId;
    if (!sessionId) return '目前没有绑定的会话';
    try { await this.#harness.cancel(sessionId); }
    catch (error) { this.#error = errorName(error); return '停止请求失败，请稍后重试。'; }
    return '已请求停止当前会话的任务。';
  }
  async #stopAllSessions() {
    const targets = this.#runningSessionIds();
    if (!targets.size) return '目前没有正在运行的微信任务';
    const results = await Promise.allSettled([...targets].map(sessionId => {
      try { return this.#harness.cancel(sessionId); }
      catch (error) { return Promise.reject(error); }
    }));
    const failed = results.filter(result => result.status === 'rejected').length;
    return failed
      ? `已请求停止 ${targets.size} 个会话，其中 ${failed} 个失败。`
      : `已请求停止 ${targets.size} 个会话的任务。`;
  }
  /** `/stop` targets the bound Session; `/stop all` targets every running task. */
  async #stopCommand(text) {
    const match = /^\/stop(?:\s+(\S+))?$/i.exec(text.trim());
    const scope = match?.[1]?.toLowerCase();
    if (match && scope === undefined) return this.#stopCurrentSession();
    if (match && scope === 'all') return this.#stopAllSessions();
    return '用法：/stop 停止当前会话的任务；/stop all 停止所有正在运行的微信任务。';
  }
  async #listSessions(signal) {
    const currentSessionId = this.#store.snapshot().sessionId;
    const { items, archived } = await this.#visibleSessions(currentSessionId, signal);
    // Number exactly the rows the owner sees, so `/switch` cannot name a hidden row.
    const listed = listedSessions(items, { currentSessionId });
    this.#sessionList = { at: Date.now(), ids: listed.map(summary => summary.sessionId) };
    return formatSessionList(items, { currentSessionId, archived });
  }
  /** Switch the WeChat binding to the Session numbered by the latest `/list`. */
  async #switchSession(text, signal) {
    const match = /^\/switch\s+(\d{1,3})$/i.exec(text.trim());
    if (!match) return '用法：/switch 序号。先发送 /list 查看列表。';
    const list = this.#sessionList;
    if (!list || Date.now() - list.at > SESSION_LIST_TTL_MS) return '列表已过期，请先发送 /list。';
    const sessionId = list.ids[Number(match[1]) - 1];
    if (!sessionId) return `序号超出范围（共 ${list.ids.length} 个），请重新发送 /list。`;
    const currentSessionId = this.#store.snapshot().sessionId;
    if (sessionId === currentSessionId) return '当前已经在这个会话。';
    // Re-check against the binding that exists now: a Session hidden since the
    // list was taken (archived, or blank again after `/new`) must not be reached.
    const { items } = await this.#visibleSessions(currentSessionId, signal);
    const target = items.find(summary => summary.sessionId === sessionId);
    if (!target) return '该会话已归档、已删除或已不在列表中，请重新发送 /list。';
    await this.#store.update(state => { state.sessionId = sessionId; });
    return `已切换到：${sessionLabel(target)}\n后续消息在该会话中处理。`;
  }
  /** Answer a session command; a failure must still reply instead of going silent. */
  async #sessionCommand(name, text, signal) {
    try {
      return name === '/list' ? await this.#listSessions(signal) : await this.#switchSession(text, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      this.#error = errorName(error);
      return '会话操作失败，请稍后重试。';
    }
  }
  async #handleControl(item, signal) {
    const claimed = await this.#store.update(state => {
      const row = state.inbox.find(r => r.id === item.id);
      if (!row || row.status !== 'queued') return false;
      row.status = 'control-pending'; return true;
    });
    if (!claimed) return;
    try {
      let text;
      const name = command(item.text);
      if (item.sourceKind !== 'text') text = '仅文字消息可执行微信命令';
      else if (name === '/stop') text = await this.#stopCommand(item.text);
      else if (name === '/status') text = this.#connected ? '微信连接正常' : '微信连接中';
      else if (name === '/list' || name === '/switch') text = await this.#sessionCommand(name, item.text, signal);
      else if (name === '/help') text = '/new 新会话；/list 会话列表；/switch 序号 切换；/status 状态；/stop 停止当前任务；/stop all 停止所有任务；/approve、/reject、/answer 回复待处理请求';
      else {
        const result = await this.#interactions?.answer?.({ ...item });
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
        if (row) row.status = 'failed';
      });
      throw error;
    }
  }
  /** Best-effort session registration; a failed notice must not break startup. */
  #notifyStart(signal) {
    const notify = this.#client.notifyStart;
    if (typeof notify !== 'function') return;
    Promise.resolve().then(() => notify.call(this.#client, signal)).catch(() => {});
  }

  /** Best-effort session close notice. */
  #notifyStop() {
    const notify = this.#client.notifyStop;
    if (typeof notify !== 'function') return;
    Promise.resolve().then(() => notify.call(this.#client)).catch(() => {});
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
            if (r) { r.status = 'failed'; this.#enqueue(state, r, '新会话创建失败，消息已丢弃。请重新发送 /new。'); }
          });
        }
        continue;
      }
      try { await this.#process(item, signal); }
      catch (error) {
        if (signal.aborted) return;
        this.#error = errorName(error);
        this.#recordFailure(item, error);
        // A before-submission failure admits nothing, so the same message can be
        // re-prepared safely: transient session/resume errors then self-heal
        // instead of discarding the owner's message.
        const retryDelay = error.beforeSubmission === true
          ? this.#prepareRetryDelays[item.prepareAttempts ?? 0]
          : undefined;
        if (retryDelay !== undefined) {
          await this.#store.update(state => {
            const r = state.inbox.find(row => row.id === item.id);
            if (!r) return;
            r.status = 'queued';
            r.prepareAttempts = (item.prepareAttempts ?? 0) + 1;
            delete r.requestId;
            delete r.sessionId;
          });
          try { await delay(retryDelay, undefined, { signal }); } catch { return; }
          continue;
        }
        await this.#store.update(state => {
          const r = state.inbox.find(row => row.id === item.id);
          if (r) {
            r.status = 'failed';
            const text = error.code === 'observation-timeout'
              ? '等待回复超时，消息跟踪已丢弃。任务可能仍在运行，请在 DSH 会话中查看。'
              : error.beforeSubmission
                ? '任务准备失败，尚未提交给 DSH，消息已丢弃。请重新发送。'
                : '请求状态无法确认，消息已丢弃，不会自动重试。请在 DSH 会话中查看。';
            this.#enqueue(state, { ...r, id: `failure-${r.id}` }, text);
          }
        });
      }
    }
  }
  /**
   * Keep one bounded, inspectable record of a dispatch failure for the settings status.
   * @param {object} item - the inbox row under dispatch.
   * @param {Error} error - the decorated failure.
   * @param {'error'|'warning'} severity - fatal failure or a degraded-capability notice.
   * @param {string} [stage] - explicit stage when the error was swallowed.
   */
  #recordFailure(item, error, severity = 'error', stage) {
    this.#failures.push({
      at: Date.now(),
      messageId: item.id,
      severity,
      stage: stage ?? error.stage ?? (item.status === 'queued' ? 'prepare' : 'lookup'),
      code: error.code ?? null,
      detail: failureDetail(error),
      attempt: item.prepareAttempts ?? 0,
      media: (item.media?.length ?? 0) > 0,
      contextToken: typeof item.contextToken === 'string' && item.contextToken.trim() !== '',
      sessionId: item.sessionId ?? this.#store.snapshot().sessionId ?? null,
    });
    if (this.#failures.length > MAX_RECORDED_FAILURES) this.#failures.shift();
  }
  /**
   * Install the task-scoped media capability when the runtime offers one. The
   * capability is optional: a stale Session workspace or a resume race must not
   * discard an otherwise deliverable text message, so a failure is recorded as a
   * warning and the dispatch continues without `wechat_send_media`.
   * @param {object} item - the inbox row under dispatch.
   * @param {string} sessionId - admitted Session identity.
   * @param {string} requestId - deterministic request identity.
   * @returns the retire disposer, or undefined when the capability is unavailable.
   */
  async #installOutbound(item, sessionId, requestId) {
    if (!this.outbound) return undefined;
    try {
      return await this.outbound(sessionId, requestId);
    } catch (error) {
      this.#recordFailure(item, error, 'warning', 'outbound');
      return undefined;
    }
  }
  async #process(item, signal) {
    const requestId = item.requestId ?? `wechat-${item.id}`;
    let retireOutbound;
    let outboundAttempted = false;
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
      outboundAttempted = true;
      retireOutbound = await this.#installOutbound(item, sessionId, requestId);
      stage = 'submit';
      await this.#harness.submit(sessionId, requestId, content, signal);
      if (signal.aborted) return;
      await this.#store.update(state => { state.inbox.find(r => r.id === item.id).status = 'submitted'; });
    } else if (item.status === 'dispatching') {
      const found = await this.#harness.lookupRequest(sessionId, requestId, signal);
      // `inflight` is a resumable outcome: the runtime took the message but the
      // durable commit is still pending. Wait for it instead of discarding the
      // request; the wait is still bounded and never replays the prompt.
      if (!['pending', 'admitted', 'completed', 'inflight'].includes(found?.status)) {
        await this.#store.update(state => {
          const r = state.inbox.find(row => row.id === item.id);
          r.status = 'failed';
          this.#enqueue(state, { ...r, id: `failure-${r.id}` }, '请求状态无法确认，消息已丢弃，不会自动重试。请在 DSH 会话中查看。');
        });
        this.#wake();
        return; // Unknown never replays a potentially admitted prompt.
      }
      await this.#store.update(state => { state.inbox.find(r => r.id === item.id).status = 'submitted'; });
    }
    if (!retireOutbound && !outboundAttempted) retireOutbound = await this.#installOutbound(item, sessionId, requestId);
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
  /** Freshest bound context token for an outbox row; older rows keep a stale one. */
  #contextTokenFor(item) {
    const binding = this.#store.snapshot().binding;
    const token = binding?.context?.token;
    if (binding?.ownerId === item.userId && typeof token === 'string' && token.trim()
      && !/[\r\n\0]/.test(token)) return token;
    return item.contextToken;
  }

  /** Park one row until the owner messages the bot again, bounded by count. */
  async #hold(item) {
    const now = Date.now();
    await this.#store.update(state => {
      const row = state.outbox.find(r => r.id === item.id);
      if (!row) return;
      row.status = 'held';
      if (!Number.isSafeInteger(row.heldAt)) row.heldAt = now;
      row.attempts = 0;
      row.lastError = 'session-not-ready';
      delete row.nextAttemptAt;
      const held = state.outbox.filter(r => r.status === 'held');
      for (const old of held.slice(0, Math.max(0, held.length - MAX_HELD))) old.status = 'failed';
    });
  }

  /** After an inbound message refreshes the session, queue held rows again. */
  async #releaseHeld() {
    if (!this.#store.snapshot().outbox.some(row => row.status === 'held')) return;
    const now = Date.now();
    await this.#store.update(state => {
      for (const row of state.outbox) {
        if (row.status !== 'held') continue;
        const heldAt = Number.isSafeInteger(row.heldAt) ? row.heldAt : now;
        if (now - heldAt > HELD_TTL_MS) { row.status = 'failed'; continue; }
        row.status = 'queued';
        row.attempts = 0;
        delete row.heldAt;
        delete row.nextAttemptAt;
      }
    });
    this.#wake();
  }

  /**
   * Deliver queued rows in order. A failed send is retried on the configured
   * schedule, reusing the same client id and the newest bound context, so a
   * refreshed WeChat window can still carry the message. A session-not-ready
   * refusal is held for the owner's next inbound instead; uncertain failures
   * are dropped at once because the provider may already hold the message.
   */
  async #sendLoop() {
    const signal = this.#abort.signal;
    while (!signal.aborted) {
      const now = Date.now();
      const item = this.#store.snapshot().outbox.find(row => row.status === 'queued'
        && !(Number.isSafeInteger(row.nextAttemptAt) && row.nextAttemptAt > now));
      if (!item) return;
      const contextToken = this.#contextTokenFor(item);
      const deliver = async (token) => {
        if (item.media) {
          if (!this.attachments) throw new Error('Attachment service unavailable');
          const buffers = []; let size = 0;
          for await (const chunk of this.attachments.readFileStream(item.media.attachment, signal)) {
            size += chunk.byteLength;
            if (size > 50 * 1024 * 1024) throw new RangeError('Outbound media too large');
            buffers.push(chunk);
          }
          await this.#client.sendMedia({ userId: item.userId, contextToken: token,
            clientId: item.id, kind: item.media.kind, name: item.media.name, bytes: Buffer.concat(buffers, size) }, signal);
        } else {
          await this.#client.sendText({ userId: item.userId, contextToken: token,
            text: item.text, clientId: item.id }, signal);
        }
      };
      try {
        await this.#store.update(state => { state.outbox.find(r => r.id === item.id).status = 'sending'; });
        if (signal.aborted) return;
        try {
          await deliver(contextToken);
        } catch (error) {
          /* iLink keeps accepting a tokenless degraded send after the context
             goes stale; that is what lets a cron push reach an idle peer. */
          if (!contextToken || !isSessionStale(error)) throw error;
          await deliver('');
        }
        if (signal.aborted) return;
        await this.#store.update(state => { const row = state.outbox.find(r => r.id === item.id); if (row) row.status = 'sent'; });
        if (this.#error === 'send-held') this.#error = null;
      } catch (error) {
        if (signal.aborted) return;
        /* iLink refuses bot-initiated sends until the owner's next message; a
           tokenless retry already ran above. Keep the row and flush it after
           that inbound instead of burning attempts or the daily quota. */
        if (error?.code === 'provider-rejected' && error?.providerCode === '-2') {
          await this.#hold(item);
          this.#error = 'send-held';
          continue;
        }
        const attempts = (Number.isSafeInteger(item.attempts) ? item.attempts : 0) + 1;
        const waitMs = this.#retryDelays[attempts - 1];
        const retry = item.id.startsWith('wechat-push-') && error?.uncertain !== true
          && waitMs !== undefined;
        await this.#store.update(state => {
          const row = state.outbox.find(r => r.id === item.id);
          if (!row) return;
          row.attempts = attempts;
          row.lastError = sendFailure(error);
          if (retry) { row.status = 'queued'; row.nextAttemptAt = Date.now() + waitMs; }
          else { row.status = 'failed'; delete row.nextAttemptAt; }
        });
        if (!retry) this.#error = 'send-failed';
      }
    }
  }
}
