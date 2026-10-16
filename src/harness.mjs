/** Thrown when an incoming request cannot safely be replayed or attributed. */
export class NeedsReviewError extends Error {
  constructor(message) { super(message); this.name = 'NeedsReviewError'; this.code = 'needsReview'; }
}

const ownRequest = (message, requestId) => message?.source?.kind === 'user' && message.source.rpcId === requestId;
const textOf = (message) => (message?.content ?? [])
  .filter((block) => block?.type === 'text' && typeof block.text === 'string')
  .map((block) => block.text).join('\n').trim();

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function promptParts(input) {
  const parts = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 16) {
    throw new TypeError('prompt content must have 1-16 parts');
  }
  const content = parts.map((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) throw new TypeError('invalid prompt part');
    if (part.type === 'text' && typeof part.text === 'string' && part.text.length <= 100_000) {
      return { type: 'text', text: part.text };
    }
    if (part.type === 'image' && IMAGE_TYPES.has(part.mediaType)
      && typeof part.data === 'string' && part.data.length > 0 && part.data.length <= 16_000_000
      && /^[A-Za-z0-9+/]*={0,2}$/.test(part.data)
      && (part.name === undefined || (typeof part.name === 'string' && part.name.length <= 255))) {
      return { type: 'image', mediaType: part.mediaType, data: part.data,
        ...(part.name === undefined ? {} : { name: part.name }) };
    }
    if (part.type === 'file' && typeof part.receiptId === 'string' && part.receiptId.length > 0) {
      return { type: 'file', receiptId: part.receiptId };
    }
    throw new TypeError('invalid prompt part');
  });
  if (!content.some((part) => part.type !== 'text' || part.text.trim())) {
    throw new TypeError('prompt must contain nonempty text or an attachment');
  }
  return content;
}

/**
 * Derive a request's disposition from the durable Session log.
 *
 * Statuses: `pending` (still queued), `inflight` (taken by the runtime, commit
 * not yet durable), `admitted`, `completed`, `unknown`, `needsReview` (only for
 * states this code cannot attribute safely).
 */
export function inspectRequest(events, requestId) {
  const pending = { 'next-turn': [], 'next-step': [] };
  let queued = false;
  let removed = false;
  let cancelled = false;
  let admitted = null;
  let position = null;
  let ambiguous = false;
  for (const event of events) {
    if (event.type === 'turn/start') position = { turn: event.data.turn, step: null };
    if (event.type === 'step/start') position = { turn: event.data.turn, step: event.data.step };
    if (event.type === 'agent/inbox/spliced') {
      const { target, start, removedCount = 0, inserted = [], outcome } = event.data;
      const list = pending[target];
      if (!list || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(removedCount)
        || removedCount < 0 || start > list.length || start + removedCount > list.length
        || !Array.isArray(inserted)) return { status: 'needsReview', reason: 'invalid inbox event' };
      const taken = list.splice(start, removedCount, ...inserted);
      if (inserted.some((message) => ownRequest(message, requestId))) queued = true;
      if (taken.some((message) => ownRequest(message, requestId))) {
        removed = true;
        if (outcome === 'canceled') cancelled = true;
      }
    }
    if (event.type === 'user/message' && ownRequest(event.data, requestId)) {
      if (admitted) ambiguous = true;
      admitted = { seq: event.seq, turn: position?.turn, step: position?.step };
    }
  }
  if (ambiguous || (admitted && (!Number.isSafeInteger(admitted.turn)
    || !Number.isSafeInteger(admitted.step)))) {
    return { status: 'needsReview', reason: 'request has ambiguous turn attribution' };
  }
  if (!admitted) {
    if (pending['next-turn'].some((message) => ownRequest(message, requestId))
      || pending['next-step'].some((message) => ownRequest(message, requestId))) return { status: 'pending' };
    if (cancelled) return { status: 'completed', text: '请求已取消。', reason: 'canceled' };
    // Taken from the inbox but no durable admission yet. The runtime writes the
    // `user/message` commit a few events later, so this is a normal delivery
    // window, not an ambiguous outcome. Callers keep waiting; a bounded grace
    // caps the wait in case the commit never arrives.
    if (queued && removed) return { status: 'inflight', reason: 'request left inbox without committed admission' };
    return { status: 'unknown' };
  }
  // Multiple human requests in one turn make a combined answer unattributable.
  let turn = null;
  const scoped = [];
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn;
    if (turn === admitted.turn) scoped.push(event);
  }
  if (scoped.some((event) => event.type === 'user/message'
    && event.seq !== admitted.seq && event.data?.source?.kind === 'user')) {
    return { status: 'needsReview', reason: 'another user message shares this turn' };
  }
  const end = scoped.find((event) => event.type === 'turn/end'
    && event.data?.turn === admitted.turn && event.seq > admitted.seq);
  if (!end) return { status: 'admitted', turn: admitted.turn };
  const replies = scoped.filter((event) => event.type === 'assistant/message'
    && event.seq > admitted.seq && event.seq < end.seq
    && event.data?.turn === admitted.turn && event.data?.interrupted !== true)
    .map((event) => textOf(event.data.message)).filter(Boolean);
  const reason = end.data.reason?.kind ?? 'unknown';
  const text = reason === 'completed' ? replies.at(-1) ?? '已完成（没有文本回复）。'
    : reason === 'aborted' || reason === 'interrupted' ? '请求已中断。'
      : reason === 'error' ? `请求失败：${end.data.reason.error?.message ?? '未知错误'}`
        : reason === 'blocked' ? '请求已阻止。'
          : reason === 'max-tokens' ? '请求达到输出上限。'
            : `请求结束（${reason}）。`;
  return { status: 'completed', text, reason, turn: admitted.turn };
}

/** DSH SessionController adapter for one owner-bound WeChat conversation. */
export class HarnessAdapter {
  constructor(ctx, { cwd, agentPreset = 'standard', waitTimeoutMs = 30 * 60 * 1000,
    inflightGraceMs = 60 * 1000 }) {
    if (!ctx?.sessionController || typeof ctx.on !== 'function')
      throw new TypeError('HarnessAdapter requires sessionController and Host events');
    if (typeof cwd !== 'string' || !cwd) throw new TypeError('cwd is required');
    this.ctx = ctx;
    this.cwd = cwd;
    this.agentPreset = agentPreset;
    this.waitTimeoutMs = waitTimeoutMs;
    this.inflightGraceMs = inflightGraceMs;
  }
  createSession(sessionId) {
    return this.ctx.sessionController.create({ sessionId, cwd: this.cwd, agentPreset: this.agentPreset });
  }
  /** Read every persisted Session row for the `/list` command. */
  listSessions(signal) {
    return this.ctx.sessionController.list({}, signal);
  }
  /** Registry-global archive set; empty when the deployment mounts no workspace registry. */
  archivedSessionIds() {
    const registry = typeof this.ctx.get === 'function' ? this.ctx.get('workspaceRegistry') : undefined;
    const ids = registry?.archivedSessionIds;
    return Array.isArray(ids) ? ids.slice() : [];
  }
  submit(sessionId, requestId, content, signal) {
    const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    if (!Array.isArray(parts) || !parts.length || parts.some(part =>
      !part || (part.type === 'text' && (typeof part.text !== 'string' || !part.text.trim()))
      || (part.type === 'file' && (typeof part.receiptId !== 'string' || !part.receiptId))
      || (part.type === 'image' && (!['image/png','image/jpeg','image/webp','image/gif'].includes(part.mediaType)
        || typeof part.data !== 'string' || !part.data))
      || !['text','image','file'].includes(part.type))) throw new TypeError('Invalid prompt content');
    return this.ctx.sessionController.prompt({
      sessionId, requestId, mode: 'queue', content: parts,
    }, signal);
  }
  cancel(sessionId) { return this.ctx.sessionController.cancel({ sessionId }); }
  async lookupRequest(sessionId, requestId, signal) {
    const { events } = await this.ctx.sessionController.inspect(sessionId, signal);
    return inspectRequest(events, requestId);
  }
  waitForReply(sessionId, requestId, signal) {
    return new Promise((resolve, reject) => {
      let closed = false;
      let dirty = false;
      let checking = false;
      let timer;
      let grace;
      let off;
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        clearTimeout(grace);
        signal?.removeEventListener('abort', onAbort);
        off?.();
      };
      const fail = (error) => { close(); reject(error); };
      const onAbort = () => fail(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      const check = async () => {
        if (checking || closed) return;
        checking = true;
        do {
          dirty = false;
          try {
            const state = await this.lookupRequest(sessionId, requestId, signal);
            if (closed) break;
            if (state.status === 'completed') { close(); resolve(state.text); break; }
            if (state.status === 'needsReview') { fail(new NeedsReviewError(state.reason)); break; }
            // `inflight` means the runtime took the message but the durable
            // commit has not landed yet. That window normally closes within a
            // few events, so keep waiting. The grace bounds the wait when the
            // commit never arrives, instead of blocking the queue for the full
            // waitTimeoutMs.
            if (state.status === 'inflight') {
              if (!grace) {
                grace = setTimeout(() => fail(Object.assign(
                  new Error('request left the inbox without a durable admission'),
                  { code: 'inflight-timeout' })), this.inflightGraceMs);
              }
            } else if (grace) { clearTimeout(grace); grace = undefined; }
          } catch (error) { if (!closed) fail(error); break; }
        } while (dirty && !closed);
        checking = false;
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      // Subscribe before inspecting: no gap between the baseline and live events.
      off = this.ctx.on('session/event', (session, event) => {
        if (session.id !== sessionId) return;
        if (!['user/message', 'agent/inbox/spliced', 'turn/end'].includes(event.type)) return;
        dirty = true;
        void check();
      }, { global: true });
      timer = setTimeout(() => fail(Object.assign(new Error('timed out waiting for durable turn/end'),
        { code: 'observation-timeout' })), this.waitTimeoutMs);
      void check();
    });
  }
}
