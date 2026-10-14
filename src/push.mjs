import { createHash } from 'node:crypto';

export const MAX_TEXT_CHARS = 800;
export const MAX_PUSH_QUEUE = 100;
export const isContextToken = value => typeof value === 'string' && !!value.trim()
  && Buffer.byteLength(value, 'utf8') <= 8192 && !/[\x00-\x1f\x7f]/.test(value);

export function validatePush(text, { sessionId, callId } = {}) {
  if (typeof text !== 'string' || !text.trim() || Array.from(text).length > MAX_TEXT_CHARS
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    throw new TypeError('微信消息须为 1–800 个字符的非空文字。');
  }
  if (typeof sessionId !== 'string' || !sessionId || typeof callId !== 'string' || !callId
    || sessionId.length > 256 || callId.length > 512) throw new TypeError('发送需要有效的会话和工具调用 ID。');
  return `wechat-push-${createHash('sha256').update(JSON.stringify([sessionId, callId])).digest('hex')}`;
}

export function enqueuePush(state, { id, text, sessionId, signal }) {
  signal?.throwIfAborted();
  const ownerId = state.binding?.ownerId;
  if (!state.enabled || typeof ownerId !== 'string' || !ownerId) throw new Error('请先在 DSH 微信设置中绑定并启动微信桥。');
  const previous = state.outbox.find(row => row.id === id);
  if (previous) {
    if (previous.sourceSessionId !== sessionId || previous.text !== text || previous.userId !== ownerId) {
      throw new Error('此调用 ID 已用于另一条消息，请核查后重试。');
    }
    return { id, status: previous.status };
  }
  if (state.seen.includes(`\u0000outbox\u0000${id}`)) return { id, status: 'sent' };
  const context = state.binding.context;
  if (!isContextToken(context?.token)) {
    throw new Error('缺少可用微信上下文，请先在手机给机器人发一条消息后再推送。');
  }
  if (state.outbox.filter(row => row.id.startsWith('wechat-push-')).length >= MAX_PUSH_QUEUE) {
    throw new Error('微信推送队列已满，请先在 DSH 核查未发送或状态不确定的消息。');
  }
  state.outbox.push({ id, text, status: 'queued', userId: ownerId,
    contextToken: context.token, sourceSessionId: sessionId });
  return { id, status: 'queued' };
}

export function sendTextDefinition(controller) {
  return {
    name: 'wechat_send_text',
    description: 'Queue text for the user’s bound WeChat from this session. Use only when the user requests a WeChat message or notification. Returns the message id and delivery state; queued means not yet delivered.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Message to send, 1–800 characters. For composed notifications use a short title, blank lines, short paragraphs and • bullets; WeChat does not render Markdown headings, bold or tables. Preserve user-supplied verbatim text. Split longer messages at paragraph boundaries.' } },
      required: ['text'], additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, status: { type: 'string', enum: ['queued', 'sending', 'sent', 'failed', 'uncertain'] },
      }, required: ['id', 'status'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).some(key => key !== 'text')) throw new TypeError('Expected {text}.');
      return controller.enqueueText(args.text, { sessionId: exec.agent.id, callId: exec.callId, signal: exec.signal });
    },
  };
}
