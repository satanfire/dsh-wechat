import { randomBytes } from 'node:crypto';
import { inspectOwnedToolCall } from './ownership.mjs';
const PREFIX = 'interaction:';
const abortError = () => Object.assign(new Error('WeChat interaction cancelled or expired'), { name: 'AbortError', code: 'ASK_ABORTED' });

/** Exclusive IM answerer: owned requests do not fall through to Web UI.
 * Call answer ONLY with authenticated inbound user text; never expose as a tool.
 * Policy remains authoritative. Pending nonces are private and never recovered.
 */
export class Interactions {
  #store; #sessionController; #pending = new Map(); #all = new Set(); #off = []; #closed = false;
  #ready; #writes = new Set(); #timeout;
  constructor(ctx, { store, timeoutMs = 300_000 }) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError('Invalid timeout');
    this.#store = store;
    this.#sessionController = ctx.sessionController;
    this.#timeout = timeoutMs;
    this.#ready = this.#track(store.update(state => {
      for (const item of state.outbox) if (item.id.startsWith(PREFIX) && item.status === 'queued') item.status = 'cancelled';
    }));
    this.#off.push(ctx.on('approval/request', (req, next) => this.#claim('approval', req, next), { global: true }));
    this.#off.push(ctx.on('user-questions/request', (req, next) => this.#claim('question', req, next), { global: true }));
  }
  #track(promise) {
    this.#writes.add(promise);
    promise.then(() => this.#writes.delete(promise), () => this.#writes.delete(promise));
    return promise;
  }
  #owner(sessionId) {
    const state = this.#store.snapshot();
    if (this.#closed || !state.enabled || typeof sessionId !== 'string') return null;
    return state.inbox.find(item => item.sessionId === sessionId
      && ['dispatching', 'submitted'].includes(item.status) && item.userId && item.contextToken
      && (!state.binding?.ownerId || state.binding.ownerId === item.userId)) ?? null;
  }
  async #claim(kind, req, next) {
    const owner = this.#owner(req.agent?.id);
    if (!owner) return next();
    if (kind === 'question' && (!Array.isArray(req.questions) || !req.questions.length)) return next();
    const callId = kind === 'approval' ? req.callId : req.wait?.callId;
    const toolName = kind === 'approval' ? req.toolName : 'ask_user_question';
    if (!callId || !this.#sessionController) return next();
    let call;
    try {
      call = await inspectOwnedToolCall(this.#sessionController, req.agent.id,
        owner.requestId, callId, toolName, req.signal);
    } catch { return next(); }
    if (!call || this.#owner(req.agent.id)?.id !== owner.id) return next();
    if (kind === 'approval' && (typeof call.arguments !== 'string'
      || !call.arguments.trim() || call.arguments.length > 500)) return next();
    if (req.signal?.aborted) return kind === 'approval' ? 'cancelled' : Promise.reject(abortError());
    let resolve, reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const p = { kind, req, owner: { ...owner }, sessionId: req.agent.id,
      callId, toolName, detail: call.arguments, resolve, reject,
      index: 0, answers: [], ids: [], nonce: '', settled: false };
    this.#all.add(p);
    p.onAbort = () => this.#settle(p, false);
    req.signal?.addEventListener('abort', p.onAbort, { once: true });
    p.timer = setTimeout(p.onAbort, this.#timeout);
    p.timer.unref?.();
    this.#prompt(p);
    return result;
  }
  #prompt(p) {
    if (p.settled) return;
    p.nonce = randomBytes(16).toString('hex');
    this.#pending.set(p.nonce, p);
    const id = `${PREFIX}${p.nonce}`;
    p.ids.push(id);
    let text;
    if (p.kind === 'approval') {
      text = `需要审批（5 分钟内有效）\n工具：${p.req.toolName}\n实际操作：${p.detail}\n原因：${p.req.displayReason?.zh ?? p.req.reason ?? p.req.displayReason?.en ?? '未提供'}\n仅允许本次：/approve ${p.nonce}\n拒绝：/reject ${p.nonce}`;
    } else {
      const q = p.req.questions[p.index];
      text = `问题 ${p.index + 1}/${p.req.questions.length}（5 分钟内有效）\n${q.question}`;
      if (q.detail) text += `\n${q.detail}`;
      for (const [i, option] of (q.options ?? []).entries()) text += `\n${i + 1}. ${option.label}${option.description ? `：${option.description}` : ''}`;
      text += `\n回复：/answer ${p.nonce} <${q.multiSelect ? '选项序号，逗号分隔；或自定义文字' : '选项序号或自定义文字'}>\n数字原文请用 text: 前缀。`;
    }
    p.delivery = this.#track(this.#ready.then(async () => {
      if (!p.settled) await this.#store.enqueue({ id, userId: p.owner.userId, contextToken: p.owner.contextToken, text });
    }));
    p.delivery.catch(() => this.#settle(p, false));
  }
  #retire(p, ids) {
    return this.#track(Promise.resolve(p.delivery).catch(() => {}).then(() => this.#store.update(state => {
      for (const item of state.outbox) if (ids.includes(item.id) && item.status === 'queued') item.status = 'cancelled';
    })));
  }
  #settle(p, success, value) {
    if (p.settled) return;
    p.settled = true;
    this.#pending.delete(p.nonce);
    this.#all.delete(p);
    clearTimeout(p.timer);
    p.req.signal?.removeEventListener('abort', p.onAbort);
    this.#retire(p, [...p.ids]).then(() => {
      if (success) p.resolve(value);
      else if (p.kind === 'approval') p.resolve('cancelled');
      else p.reject(abortError());
    }, () => {
      if (p.kind === 'approval') p.resolve('cancelled');
      else p.reject(abortError());
    });
  }
  async answer(command) {
    if (!command || typeof command !== 'object' || typeof command.text !== 'string') return { handled: false, accepted: false };
    const match = /^\/(approve|reject|answer)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(command.text.trim());
    if (!match) return { handled: false, accepted: false };
    const fail = message => ({ handled: true, accepted: false, message });
    const [, action, nonce, reply = ''] = match;
    const p = this.#pending.get(nonce);
    if (!p || p.settled) return fail('请求已失效或不存在。');
    // The request belongs to the Session that created it, not to the current
    // WeChat binding: `/switch` may point elsewhere while the pending request
    // is still live. `#owner` below re-verifies the request's own Session.
    if (command.userId !== p.owner.userId) return fail('请求不属于此用户。');
    const owner = this.#owner(p.sessionId);
    if (!owner || owner.id !== p.owner.id || owner.userId !== p.owner.userId) {
      this.#settle(p, false);
      return fail('请求所属任务已结束。');
    }
    try {
      if (!await inspectOwnedToolCall(this.#sessionController, p.sessionId,
        owner.requestId, p.callId, p.toolName, p.req.signal)) {
        this.#settle(p, false);
        return fail('请求所属轮次已结束或不再属于微信。');
      }
    } catch {
      this.#settle(p, false);
      return fail('无法核实请求来源，请在网页版处理。');
    }
    if (p.settled || this.#closed || this.#owner(p.sessionId)?.id !== p.owner.id) return fail('请求已失效或不存在。');
    if (p.kind === 'approval') {
      if (!['approve', 'reject'].includes(action) || reply.trim()) return fail('使用 /approve 或 /reject 加请求码，不附加文字。');
      this.#settle(p, true, action === 'approve' ? 'allowed-once' : 'rejected');
    } else {
      if (action !== 'answer' || !reply.trim()) return fail('使用 /answer 加请求码和回答。');
      const q = p.req.questions[p.index];
      const raw = reply.trim();
      let answer;
      if (/^\d+(?:[\s,，]+\d+)*$/.test(raw) && q.options?.length) {
        const numbers = raw.split(/[\s,，]+/).map(Number);
        if (new Set(numbers).size !== numbers.length || numbers.some(n => n < 1 || n > q.options.length)
          || (!q.multiSelect && numbers.length !== 1)) return fail('选项序号无效、重复或不允许多选。');
        answer = { id: q.id, selected: numbers.map(n => q.options[n - 1].label) };
      } else {
        const custom = raw.startsWith('text:') ? raw.slice(5).trim() : raw;
        if (!custom) return fail('回答不能为空。');
        answer = { id: q.id, selected: [], custom };
      }
      this.#pending.delete(p.nonce);
      p.answers.push(answer);
      p.index++;
      if (p.index === p.req.questions.length) this.#settle(p, true, { answers: p.answers });
      else {
        try { await this.#retire(p, [...p.ids]); }
        catch { this.#settle(p, false); return fail('无法保存回答。'); }
        this.#prompt(p);
      }
    }
    return { handled: true, accepted: true, message: '已接收。' };
  }
  /** Removes listeners immediately and drains cleanup writes before resolving. */
  async dispose() {
    if (!this.#closed) {
      this.#closed = true;
      for (const off of this.#off.splice(0)) off();
      for (const p of [...this.#all]) this.#settle(p, false);
    }
    while (this.#writes.size) await Promise.allSettled([...this.#writes]);
  }
}
