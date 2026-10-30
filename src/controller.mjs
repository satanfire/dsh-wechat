import { setTimeout as delay } from 'node:timers/promises';
import { ILinkClient } from './ilink.mjs';
import { Bridge } from './bridge.mjs';
import { HarnessAdapter } from './harness.mjs';
import { Interactions } from './interactions.mjs';
import { MediaHandler } from './media.mjs';
import { enableOutbound } from './outbound.mjs';
import { inspectSession } from './session-inspect.mjs';
import { validatePush, enqueuePush, isContextToken } from './push.mjs';

const LOGIN_MS = 240_000;
const LOGIN_TIMEOUT = Symbol('login-timeout');
const MAX_REDIRECTS = 3;
/** The settings page polls status every second; allow one title lookup per window. */
const TITLE_CACHE_MS = 5_000;
const credentialKey = (profile) => `dsh-wechat/${profile}`;

function cleanString(value, name, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\r\n\0]/.test(value)) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value;
}

function redirectedBaseUrl(value) {
  const host = cleanString(value, 'redirect host', 256);
  // iLink sometimes supplies a hostname rather than an absolute URL. Both
  // shapes still pass ILinkClient's strict HTTPS + weixin.qq.com validation.
  return /^[a-z0-9.-]+(?::443)?$/i.test(host) ? `https://${host}` : host;
}

async function qrDataUrl(data) {
  const { default: QRCode } = await import('../vendor/qrcode.cjs');
  return QRCode.toDataURL(data, { width: 260, margin: 2 });
}

/** Serial lifecycle transitions; the independent QR poll is always aborted and joined. */
export class Controller {
  constructor(ctx, store, config, factories = {}) {
    Object.assign(this, { ctx, store, config });
    const profile = config.profile ?? process.env.DSH_PROFILE ?? 'default';
    const key = config.credentialKey === undefined
      ? credentialKey(cleanString(profile, 'profile', 256))
      : cleanString(config.credentialKey, 'credential key', 512);
    if (!/^dsh-wechat\/[a-z][a-z0-9-]*$/.test(key)) {
      throw new TypeError('Credential key must be dsh-wechat/<lowercase-profile>');
    }
    this.key = key;
    this.makeClient = factories.client ?? ((options) => new ILinkClient(options));
    this.makeBridge = factories.bridge ?? ((options) => new Bridge(options));
    this.makeHarness = factories.harness ?? ((options) => new HarnessAdapter(ctx,
      { ...options, sessionContext: () => this.serviceCtx }));
    this.makeInteractions = factories.interactions ?? (() => new Interactions(ctx, { store }));
    this.toQrDataUrl = factories.qrDataUrl ?? qrDataUrl;
    this.bridge = null;
    this.interactions = null;
    this.loginAbort = null;
    this.loginTask = null;
    this.loginTimeout = null;
    this.login = { status: 'idle' };
    this.error = null;
    this.tail = Promise.resolve();
    this.closed = false;
    this.closeTask = null;
    this.titleCache = null;
    // DSH 0.2.1 fills `sessionController.list` rows through `remoteAccess` read
    // from the caller context, so listing needs a child context that injects it.
    this.serviceCtx = ctx;
    this.#adoptRemoteAccess();
  }

  /**
   * Adopt a child context that injects `remoteAccess`, used for Session
   * listing and the bound Session title. Runtimes that predate that service
   * keep the plugin context, where `list` needs no scoped context.
   */
  #adoptRemoteAccess() {
    const { inject } = this.ctx;
    if (typeof inject !== 'function') return;
    try {
      inject.call(this.ctx, ['remoteAccess'], (scoped) => {
        this.serviceCtx = scoped;
        return () => { if (this.serviceCtx === scoped) this.serviceCtx = this.ctx; };
      });
    } catch {
      // Runtime without `remoteAccess`: listing stays on the plugin context.
    }
  }

  /**
   * Status plus the readable title of the bound Session. The settings page
   * shows that title instead of the raw Session id, so this method is async:
   * the title comes from `sessionController.list`, which walks every persisted
   * Session. `TITLE_CACHE_MS` keeps the once-per-second poll cheap.
   */
  async status() {
    const s = this.store.snapshot();
    return { connected: !!this.bridge?.connected, enabled: s.enabled, sessionId: s.sessionId,
      sessionTitle: await this.#sessionTitle(s.sessionId),
      error: this.error || this.bridge?.error || null, login: this.login, bound: !!s.binding,
      failures: this.bridge?.recentFailures ?? [] };
  }

  /** Durable title projection of the bound Session; null when absent or unknown. */
  async #sessionTitle(sessionId) {
    if (!sessionId) return null;
    const cached = this.titleCache;
    if (cached?.sessionId === sessionId && Date.now() - cached.at < TITLE_CACHE_MS) return cached.title;
    let title = null;
    const caller = this.serviceCtx ?? this.ctx;
    try {
      const { list } = caller.sessionController ?? {};
      if (typeof list === 'function') {
        // `sessionController.list` answers `{ items }`; accept a bare list too.
        const listed = await list.call(caller.sessionController, {});
        const items = Array.isArray(listed) ? listed : Array.isArray(listed?.items) ? listed.items : [];
        const summary = items.find(item => item?.sessionId === sessionId);
        const value = summary?.projections?.values?.title;
        if (typeof value === 'string' && value.trim()) title = value.trim();
      }
    } catch {
      // A failed lookup must not break the settings page; keep the last title.
      title = cached?.sessionId === sessionId ? cached.title : null;
    }
    this.titleCache = { sessionId, at: Date.now(), title };
    return title;
  }

  enqueueText(text, { sessionId, callId, signal } = {}) {
    const id = validatePush(text, { sessionId, callId });
    const next = this.tail.then(async () => {
      signal?.throwIfAborted();
      if (this.closed || !this.bridge?.status?.running || this.bridge.error === 'requires-login') {
        throw new Error('请先在 DSH 微信设置中绑定并启动微信桥。');
      }
      return this.store.update(state => enqueuePush(state, { id, text, sessionId, signal }));
    });
    this.tail = next.catch(() => {});
    return next;
  }

  action(name) {
    const next = this.tail.then(async () => {
      if (this.closed) throw new Error('微信桥已关闭');
      if (name === 'login') await this.beginLogin();
      else if (name === 'start') await this.start();
      else if (name === 'stop') {
        await this.stop();
        await this.store.update(s => { s.enabled = false; });
      } else if (name === 'logout') {
        await this.stop();
        await this.ctx.credentials.deleteRecord(this.key);
        await this.store.update(s => {
          s.enabled = false; s.binding = null; s.sessionId = null;
          s.cursor = ''; s.inbox = []; s.outbox = []; s.seen = [];
        });
        this.login = { status: 'idle' };
      } else throw new Error('未知操作');
      return this.status();
    });
    this.tail = next.catch(() => {});
    return next;
  }

  async stop() {
    this.loginAbort?.abort();
    await this.loginTask?.catch(() => {});
    clearTimeout(this.loginTimeout);
    this.loginTimeout = null;
    this.loginAbort = null;
    this.loginTask = null;
    const bridge = this.bridge;
    const interactions = this.interactions;
    // Run both disposers even if one fails; retain failed handles for retry.
    const results = await Promise.allSettled([bridge?.stop(), interactions?.dispose()]);
    if (results[0].status === 'fulfilled' && this.bridge === bridge) this.bridge = null;
    if (results[1].status === 'fulfilled' && this.interactions === interactions) this.interactions = null;
    if (this.login.status === 'waiting') this.login = { status: 'idle' };
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  async start() {
    await this.stop();
    const record = await this.ctx.credentials.readRecord(this.key);
    const p = record?.kind === 'grant' ? record.payload : null;
    if (!p || typeof p !== 'object') throw new Error('请先扫码绑定微信');
    const token = cleanString(p.token, 'bot token', 8192);
    const ownerId = cleanString(p.ownerId, 'owner id', 512);
    const baseUrl = cleanString(p.baseUrl, 'base URL', 512);
    if (this.store.snapshot().binding?.ownerId !== ownerId) {
      throw new Error('绑定状态不一致，请退出绑定后重新扫码');
    }
    const client = this.makeClient({ token, baseUrl });
    const wasEnabled = this.store.snapshot().enabled;
    try {
      this.interactions = this.makeInteractions();
      this.bridge = this.makeBridge({ store: this.store, client, ownerId,
        harness: this.makeHarness({ cwd: this.config.cwd, agentPreset: this.config.agentPreset }),
        media: this.ctx.fileUploads ? new MediaHandler({ client, fileUploads: this.ctx.fileUploads }) : undefined,
        attachments: this.ctx.attachments,
        outbound: this.ctx.attachments ? async (sessionId, requestId) => {
          const { meta } = await inspectSession(this.ctx, sessionId);
          return enableOutbound(this.ctx, { store: this.store, cwd: meta.cwd ?? this.config.cwd, sessionId, requestId });
        } : undefined,
        interactions: this.interactions });
      await this.store.update(s => {
        s.enabled = true;
        if (!isContextToken(s.binding?.context?.token)) {
          const legacy = s.inbox.findLast(row => row.userId === ownerId && isContextToken(row.contextToken));
          if (legacy) s.binding.context = { token: legacy.contextToken, receivedAt: null };
        }
      });
      await this.bridge.start();
      this.error = null;
    } catch (error) {
      try { await this.stop(); } catch { /* Keep the original startup failure. */ }
      await this.store.update(s => { s.enabled = wasEnabled; });
      throw error;
    }
  }

  async beginLogin() {
    if (this.store.snapshot().binding) throw new Error('已绑定。更换账号前请先退出绑定（会清空微信桥队列）。');
    await this.stop();
    this.error = null;
    const controller = new AbortController();
    this.loginAbort = controller;
    const signal = controller.signal;
    this.loginTimeout = setTimeout(() => controller.abort(LOGIN_TIMEOUT), LOGIN_MS);
    try {
      const client = this.makeClient({});
      const qr = await client.getQr(signal);
      signal.throwIfAborted();
      const code = cleanString(qr?.qrcode, 'QR code', 2048);
      const content = cleanString(qr?.qrcode_img_content, 'QR content', 16384);
      const url = await this.toQrDataUrl(content);
      signal.throwIfAborted();
      this.login = { status: 'waiting', qrDataUrl: url };
      const task = this.pollLogin(client, code, signal).catch(error => {
        if (signal.reason === LOGIN_TIMEOUT) this.login = { status: 'expired' };
        else if (!signal.aborted) {
          this.login = { status: 'error' };
          this.error = error?.code === 'qr-redirect-unsupported' ? 'qr-redirect-unsupported' : 'login-failed';
        }
      }).finally(() => {
        clearTimeout(this.loginTimeout);
        this.loginTimeout = null;
      });
      this.loginTask = task;
    } catch (error) {
      clearTimeout(this.loginTimeout);
      this.loginTimeout = null;
      if (this.loginAbort === controller) this.loginAbort = null;
      this.login = signal.reason === LOGIN_TIMEOUT ? { status: 'expired' } : { status: 'error' };
      this.error = 'login-failed';
      throw error;
    }
  }

  async pollLogin(initialClient, code, signal) {
    let client = initialClient;
    const redirects = new Set([client.baseUrl]);
    while (!signal.aborted) {
      const result = await client.getQrStatus(code, signal);
      signal.throwIfAborted();
      if (result?.status === 'confirmed') {
        const p = {
          token: cleanString(result.bot_token, 'bot token', 8192),
          ownerId: cleanString(result.ilink_user_id, 'owner id', 512),
          botId: result.ilink_bot_id ? cleanString(result.ilink_bot_id, 'bot id', 512) : '',
          baseUrl: result.baseurl ? cleanString(result.baseurl, 'base URL', 512) : client.baseUrl,
        };
        this.makeClient({ token: p.token, baseUrl: p.baseUrl });
        signal.throwIfAborted();
        await this.ctx.credentials.modifyRecord(this.key, async () => ({ kind: 'grant', payload: p }));
        await this.store.update(s => { s.binding = { ownerId: p.ownerId, botId: p.botId }; s.enabled = false; });
        this.login = { status: 'confirmed' };
        return;
      }
      if (result?.status === 'expired') { this.login = { status: 'expired' }; return; }
      if (result?.redirect_host) {
        const next = this.makeClient({ baseUrl: redirectedBaseUrl(result.redirect_host) });
        if (redirects.has(next.baseUrl) || redirects.size >= MAX_REDIRECTS) {
          throw Object.assign(new Error('QR redirect loop'), { code: 'qr-redirect-unsupported' });
        }
        redirects.add(next.baseUrl);
        client = next;
      }
      await delay(1000, undefined, { signal });
    }
  }

  close() {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    this.loginAbort?.abort();
    this.closeTask = (async () => {
      await this.tail;
      await this.stop();
      await this.store.close();
    })();
    return this.closeTask;
  }
}
