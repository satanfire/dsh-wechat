import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const MIN_POLL_TIMEOUT_MS = 70_000; // Provider may hold getupdates for 55s.
const MEDIA_LIMIT = 50 * 1024 * 1024;
const CDN = 'https://novac2c.cdn.weixin.qq.com';

function mediaKey(value) {
  if (typeof value !== 'string') throw new ILinkError('invalid-media-key');
  if (/^[a-f\d]{32}$/i.test(value)) return Buffer.from(value, 'hex');
  if (value.length % 4 || !/^[a-z\d+/]+={0,2}$/i.test(value)) {
    throw new ILinkError('invalid-media-key');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new ILinkError('invalid-media-key');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[a-f\d]{32}$/i.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new ILinkError('invalid-media-key');
}

function cdnUrl(value, endpoint) {
  let url;
  try { url = new URL(value); } catch { throw new ILinkError('untrusted-media-url'); }
  if (url.protocol !== 'https:' || url.hostname !== 'novac2c.cdn.weixin.qq.com'
    || (url.port && url.port !== '443') || url.username || url.password
    || url.hash || url.pathname !== `/c2c/${endpoint}`) {
    throw new ILinkError('untrusted-media-url');
  }
  return url;
}

async function boundedMedia(response, maxBytes, signal) {
  const declared = response.headers?.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel?.().catch(() => {});
    throw new ILinkError('media-too-large');
  }
  if (!response.body?.getReader) throw new ILinkError('invalid-response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new ILinkError('aborted');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new ILinkError('aborted');
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ILinkError('media-too-large');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export function normalizeMediaItems(itemList) {
  if (!Array.isArray(itemList)) return [];
  const result = [];
  for (const item of itemList) {
    const kind = item?.type === 2 ? 'image' : item?.type === 4 ? 'file'
      : item?.type === 5 ? 'video' : null;
    if (!kind) continue;
    const value = item[`${kind}_item`];
    const media = value?.media;
    if (!media || typeof media !== 'object') continue;
    const param = media.encrypt_query_param;
    const fullUrl = media.full_url;
    const key = value.aeskey ?? media.aes_key;
    if (!(typeof param === 'string' && param) && !(typeof fullUrl === 'string' && fullUrl)) continue;
    const plain = media.encrypt_type === 0;
    if (!plain) { try { mediaKey(key); } catch { continue; } }
    const descriptor = { kind, media: {
      ...(typeof param === 'string' && param ? { encrypt_query_param: param } : {}),
      ...(typeof fullUrl === 'string' && fullUrl ? { full_url: fullUrl } : {}),
      ...(plain ? { encrypt_type: 0 } : { aes_key: key }),
    } };
    if (kind === 'file') {
      if (typeof value.file_name === 'string' && value.file_name) descriptor.name = value.file_name;
      const size = Number(value.len);
      if (value.len !== undefined && Number.isSafeInteger(size) && size >= 0) descriptor.size = size;
    }
    result.push(descriptor);
  }
  return result;
}

export class ILinkError extends Error {
  constructor(code, { status, providerCode, uncertain = false } = {}) {
    super(`iLink ${code}`);
    this.name = 'ILinkError';
    this.code = code;
    this.status = status;
    this.providerCode = providerCode;
    this.uncertain = uncertain;
  }
}

function trustedBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Invalid iLink base URL'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com')
    || url.hostname === '.weixin.qq.com' || (url.port && url.port !== '443')
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new TypeError('Untrusted iLink base URL');
  }
  return url.origin;
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value;
}

/** Optional context_token field: omitted sends still work as a degraded fallback. */
function contextField(contextToken) {
  if (typeof contextToken !== 'string' || !contextToken.trim()) return {};
  return { context_token: contextToken };
}

function providerCode(value) {
  return (typeof value === 'number' && Number.isSafeInteger(value))
    || (typeof value === 'string' && /^-?\d{1,12}$/.test(value)) ? String(value) : undefined;
}

async function boundedJson(response, maxBytes) {
  const declared = Number(response.headers?.get('content-length'));
  if (declared > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new ILinkError('response-too-large');
  }
  if (!response.body?.getReader) throw new ILinkError('invalid-response');
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ILinkError('response-too-large');
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(parts, size).toString('utf8')); }
  catch { throw new ILinkError('invalid-response'); }
}

// Wire fields informed by local pi iLink API and the audited community protocol reference.
// No login, persistence, or delivery logic is copied from either implementation.
export class ILinkClient {
  constructor({ fetchImpl = fetch, baseUrl = 'https://ilinkai.weixin.qq.com', token = '',
    timeoutMs = 15_000, qrStatusTimeoutMs = 40_000, pollTimeoutMs = MIN_POLL_TIMEOUT_MS,
    maxResponseBytes = 1_048_576, maxMediaBytes = MEDIA_LIMIT,
    retryAttempts = 3, retryBaseMs = 250 } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (typeof token !== 'string' || /[\r\n]/.test(token)) throw new TypeError('Invalid token');
    this.fetchImpl = fetchImpl;
    this.baseUrl = trustedBaseUrl(baseUrl);
    this.token = token;
    this.timeoutMs = integer(timeoutMs, 'timeoutMs', 1, 120_000);
    this.qrStatusTimeoutMs = integer(qrStatusTimeoutMs, 'qrStatusTimeoutMs', 1, 120_000);
    this.pollTimeoutMs = integer(pollTimeoutMs, 'pollTimeoutMs', MIN_POLL_TIMEOUT_MS, 120_000);
    this.maxResponseBytes = integer(maxResponseBytes, 'maxResponseBytes', 1, 4_194_304);
    this.maxMediaBytes = integer(maxMediaBytes, 'maxMediaBytes', 1, MEDIA_LIMIT);
    this.retryAttempts = integer(retryAttempts, 'retryAttempts', 1, 3);
    this.retryBaseMs = integer(retryBaseMs, 'retryBaseMs', 1, 10_000);
    this.typingTickets = new Map();
    this.uin = Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64');
  }

  async #request(path, { method = 'GET', body, signal, timeoutMs, authenticated = false, send = false }) {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const headers = method === 'POST' ? { 'Content-Type': 'application/json' } : {};
    if (authenticated) {
      headers.AuthorizationType = 'ilink_bot_token';
      headers.Authorization = `Bearer ${this.token}`;
      headers['X-WECHAT-UIN'] = this.uin;
    }
    try {
      if (signal?.aborted) throw new ILinkError('aborted');
      const response = await this.fetchImpl(new URL(path, `${this.baseUrl}/`), {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combined, redirect: 'error',
      });
      let payload;
      try { payload = await boundedJson(response, this.maxResponseBytes); }
      catch (error) {
        if (!response.ok && error instanceof ILinkError && error.code === 'invalid-response') {
          throw new ILinkError('http-error', {
            status: response.status, uncertain: send && response.status >= 500,
          });
        }
        throw error;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ILinkError('invalid-response');
      }
      const rejectedRet = payload.ret !== undefined && payload.ret !== 0 && payload.ret !== '0';
      const rejectedErrcode = payload.errcode !== undefined && payload.errcode !== 0 && payload.errcode !== '0';
      const code = providerCode(rejectedErrcode ? payload.errcode : payload.ret);
      if (!response.ok) throw new ILinkError('http-error', {
        status: response.status, providerCode: code, uncertain: send && response.status >= 500,
      });
      if (rejectedRet || rejectedErrcode) {
        throw new ILinkError('provider-rejected', { providerCode: code });
      }
      return payload;
    } catch (error) {
      if (signal?.aborted) throw new ILinkError('aborted', { uncertain: send });
      if (combined.aborted) throw new ILinkError('timeout', { uncertain: send });
      if (error instanceof ILinkError) {
        if (send && (error.code === 'invalid-response' || error.code === 'response-too-large')) {
          throw new ILinkError(error.code, { uncertain: true });
        }
        throw error;
      }
      throw new ILinkError('network-error', { uncertain: send });
    }
  }

  async #retry(path, options) {
    let priorUncertain = false;
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted) throw new ILinkError('aborted', { uncertain: priorUncertain });
      try { return await this.#request(path, options); }
      catch (error) {
        priorUncertain ||= error instanceof ILinkError && error.uncertain;
        if (options.send && priorUncertain) throw error;
        const transient = error instanceof ILinkError && (
          error.code === 'network-error' || error.code === 'timeout'
          || (error.code === 'http-error' && (error.status === 429 || error.status >= 500))
          || (error.code === 'provider-rejected' && error.providerCode === '-2')
        );
        if (!transient || attempt + 1 >= this.retryAttempts) {
          if (priorUncertain && !error.uncertain) {
            throw new ILinkError(error.code, {
              status: error.status, providerCode: error.providerCode, uncertain: true,
            });
          }
          throw error;
        }
        try { await delay(this.retryBaseMs * (2 ** attempt), undefined, { signal: options.signal }); }
        catch { throw new ILinkError('aborted', { uncertain: priorUncertain }); }
      }
    }
  }

  getQr(signal) {
    return this.#retry('/ilink/bot/get_bot_qrcode?bot_type=3', {
      signal, timeoutMs: this.timeoutMs,
    });
  }

  getQrStatus(qrcode, signal) {
    required(qrcode, 'qrcode');
    return this.#retry(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
      signal, timeoutMs: this.qrStatusTimeoutMs,
    });
  }

  getUpdates(cursor, signal) {
    if (typeof cursor !== 'string') throw new TypeError('cursor must be a string');
    return this.#retry('/ilink/bot/getupdates', {
      method: 'POST', authenticated: true, signal, timeoutMs: this.pollTimeoutMs,
      body: { get_updates_buf: cursor, base_info: { channel_version: '2.0.0' } },
    });
  }

  sendText({ userId, contextToken, text, clientId }, signal) {
    required(userId, 'userId');
    required(text, 'text');
    required(clientId, 'clientId');
    return this.#retry('/ilink/bot/sendmessage', {
      method: 'POST', authenticated: true, signal, timeoutMs: this.timeoutMs, send: true,
      body: {
        msg: {
          from_user_id: '', to_user_id: userId, client_id: clientId,
          message_type: 2, message_state: 2, ...contextField(contextToken),
          item_list: [{ type: 1, text_item: { text } }],
        },
        base_info: { channel_version: '2.0.0' },
      },
    });
  }

  /** Tell iLink this client started; it re-registers the bot session. */
  notifyStart(signal) {
    return this.#retry('/ilink/bot/msg/notifystart', {
      method: 'POST', authenticated: true, signal, timeoutMs: this.timeoutMs,
      body: { base_info: { channel_version: '2.0.0' } },
    });
  }

  /** Tell iLink this client stopped. */
  notifyStop(signal) {
    return this.#retry('/ilink/bot/msg/notifystop', {
      method: 'POST', authenticated: true, signal, timeoutMs: this.timeoutMs,
      body: { base_info: { channel_version: '2.0.0' } },
    });
  }

  async sendTyping({ userId, typing, contextToken }, signal) {
    required(userId, 'userId');
    required(contextToken, 'contextToken');
    if (typeof typing !== 'boolean') throw new TypeError('typing must be boolean');
    const cacheKey = JSON.stringify([userId, contextToken]);
    let ticket = this.typingTickets.get(cacheKey);
    if (!ticket) {
      const config = await this.#retry('/ilink/bot/getconfig', {
        method: 'POST', authenticated: true, signal, timeoutMs: this.timeoutMs,
        body: { ilink_user_id: userId, context_token: contextToken,
          base_info: { channel_version: '2.0.0' } },
      });
      if (typeof config.typing_ticket !== 'string' || !config.typing_ticket) throw new ILinkError('missing-typing-ticket');
      ticket = config.typing_ticket;
      if (this.typingTickets.size >= 32) this.typingTickets.delete(this.typingTickets.keys().next().value);
      this.typingTickets.set(cacheKey, ticket);
    }
    try { return await this.#request('/ilink/bot/sendtyping', {
      method: 'POST', authenticated: true, signal, timeoutMs: this.timeoutMs, send: true,
      body: { ilink_user_id: userId, typing_ticket: ticket,
        status: typing ? 1 : 2, base_info: { channel_version: '2.0.0' } },
    }); } catch (error) { this.typingTickets.delete(cacheKey); throw error; }
  }

  getUploadUrl({ userId, mediaType, bytes, aesKey, fileKey }, signal) {
    required(userId, 'userId');
    if (mediaType !== 1 && mediaType !== 3) throw new TypeError('Unsupported media type');
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('bytes required');
    integer(bytes.byteLength, 'bytes', 0, this.maxMediaBytes);
    const key = mediaKey(aesKey);
    if (typeof fileKey !== 'string' || !/^[a-f\d]{32}$/i.test(fileKey)) {
      throw new TypeError('Invalid fileKey');
    }
    return this.#retry('/ilink/bot/getuploadurl', {
      method: 'POST', authenticated: true, signal, timeoutMs: this.timeoutMs,
      body: { filekey: fileKey, media_type: mediaType, to_user_id: userId,
        rawsize: bytes.byteLength, rawfilemd5: createHash('md5').update(bytes).digest('hex'),
        filesize: Math.ceil((bytes.byteLength + 1) / 16) * 16,
        no_need_thumb: true, aeskey: key.toString('hex'),
        base_info: { channel_version: '2.0.0' } },
    });
  }

  async uploadBytes({ uploadUrl, uploadParam, fileKey, bytes, aesKey }, signal) {
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('bytes required');
    integer(bytes.byteLength, 'bytes', 0, this.maxMediaBytes);
    const key = mediaKey(aesKey);
    if (typeof fileKey !== 'string' || !/^[a-f\d]{32}$/i.test(fileKey)) {
      throw new TypeError('Invalid fileKey');
    }
    let url;
    if (typeof uploadUrl === 'string' && uploadUrl) url = cdnUrl(uploadUrl, 'upload');
    else {
      required(uploadParam, 'uploadParam');
      url = new URL('/c2c/upload', CDN);
      url.searchParams.set('encrypted_query_param', uploadParam);
      url.searchParams.set('filekey', fileKey);
    }
    if (signal?.aborted) throw new ILinkError('aborted');
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000);
    try {
      const response = await this.fetchImpl(url, { method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' }, body: encrypted,
        signal: combined, redirect: 'error' });
      const param = response.headers?.get('x-encrypted-param');
      await response.body?.cancel?.().catch(() => {});
      if (!response.ok || response.status !== 200) {
        throw new ILinkError('http-error', { status: response.status });
      }
      if (!param) throw new ILinkError('invalid-response');
      return param;
    } catch (error) {
      if (signal?.aborted) throw new ILinkError('aborted');
      if (combined.aborted) throw new ILinkError('timeout');
      if (error instanceof ILinkError) throw error;
      throw new ILinkError('network-error');
    }
  }

  async downloadMedia(descriptor, signal) {
    const media = descriptor?.media;
    if (!['image', 'file', 'video'].includes(descriptor?.kind)) {
      throw new TypeError('Unsupported media descriptor');
    }
    const key = media?.encrypt_type === 0 ? null : mediaKey(media?.aes_key);
    let url;
    if (typeof media?.encrypt_query_param === 'string' && media.encrypt_query_param) {
      url = new URL('/c2c/download', CDN);
      url.searchParams.set('encrypted_query_param', media.encrypt_query_param);
    } else url = cdnUrl(media?.full_url, 'download');
    if (descriptor.size !== undefined) integer(descriptor.size, 'size', 0, this.maxMediaBytes);
    if (signal?.aborted) throw new ILinkError('aborted');
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000);
    try {
      const response = await this.fetchImpl(url, { method: 'GET', signal: combined,
        redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw new ILinkError('http-error', { status: response.status });
      }
      const encrypted = await boundedMedia(response, this.maxMediaBytes + (key ? 16 : 0), combined);
      if (!key) return encrypted;
      if (!encrypted.length || encrypted.length % 16 !== 0) throw new ILinkError('invalid-media-ciphertext');
      let plain;
      try {
        const decipher = createDecipheriv('aes-128-ecb', key, null);
        plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      } catch { throw new ILinkError('media-decryption-failed'); }
      if (plain.length > this.maxMediaBytes) throw new ILinkError('media-too-large');
      return plain;
    } catch (error) {
      if (signal?.aborted) throw new ILinkError('aborted');
      if (combined.aborted) throw new ILinkError('timeout');
      if (error instanceof ILinkError) throw error;
      throw new ILinkError('network-error');
    }
  }

  async sendMedia({ userId, contextToken, clientId, kind, name, bytes }, signal) {
    required(userId, 'userId');
    required(clientId, 'clientId');
    if (kind !== 'image' && kind !== 'file' && kind !== 'video') {
      throw new TypeError('Unsupported media kind');
    }
    if (kind !== 'image') required(name, 'name');
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('bytes required');
    if (kind === 'image' && bytes.byteLength === 0) throw new RangeError('Empty image');
    integer(bytes.byteLength, 'bytes', 0, this.maxMediaBytes);
    const key = randomBytes(16);
    const fileKey = randomBytes(16).toString('hex');
    const response = await this.getUploadUrl({ userId, mediaType: kind === 'image' ? 1 : 3,
      bytes, aesKey: key.toString('hex'), fileKey }, signal);
    if (typeof response.upload_full_url !== 'string' && typeof response.upload_param !== 'string') {
      throw new ILinkError('invalid-response');
    }
    const param = await this.uploadBytes({ uploadUrl: response.upload_full_url,
      uploadParam: response.upload_param, fileKey, bytes, aesKey: key.toString('hex') }, signal);
    const media = { encrypt_query_param: param,
      aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 };
    const item = kind === 'image'
      ? { type: 2, image_item: { media, mid_size: Math.ceil((bytes.byteLength + 1) / 16) * 16 } }
      : { type: 4, file_item: { media, file_name: name, len: String(bytes.byteLength) } };
    return this.#retry('/ilink/bot/sendmessage', {
      method: 'POST', authenticated: true, signal, timeoutMs: this.timeoutMs, send: true,
      body: { msg: { from_user_id: '', to_user_id: userId, client_id: clientId,
        message_type: 2, message_state: 2, ...contextField(contextToken), item_list: [item] },
      base_info: { channel_version: '2.0.0' } },
    });
  }
}
