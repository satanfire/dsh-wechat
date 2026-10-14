import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { inspectOwnedToolCall } from './ownership.mjs';

const MAX_BYTES = 50 * 1024 * 1024;
const KINDS = ['image', 'file', 'video'];
const RESULT_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' }, status: { type: 'string' } },
  required: ['id', 'status'],
  additionalProperties: false,
};

function safeName(target, kind) {
  const name = basename(target.displayPath ?? '')
    .replace(/[\x00-\x1f\x7f\\/]/g, '').slice(0, 180);
  return name && name !== '.' && name !== '..' ? name : `${kind}-attachment`;
}

function messageId(sessionId, callId) {
  return `wechat-media-${createHash('sha256')
    .update(JSON.stringify([sessionId, callId])).digest('hex')}`;
}

function activeOwner(state, sessionId, requestId) {
  if (!state.enabled || typeof state.binding?.ownerId !== 'string') return null;
  return state.inbox.find((row) => row.sessionId === sessionId
    && row.requestId === requestId
    && ['dispatching', 'submitted'].includes(row.status)
    && row.userId === state.binding.ownerId
    && typeof row.contextToken === 'string' && row.contextToken.trim());
}

/**
 * Install wechat_send_media for exactly one WeChat-origin Agent request.
 * No recipient is model-selectable. The attachment is durably snapshotted
 * before the outbox references it; the Bridge owns actual network delivery.
 */
export async function enableOutbound(ctx, { store, cwd, sessionId, requestId }) {
  if (!ctx?.sessionController || !ctx?.attachments || !store
    || typeof sessionId !== 'string' || !sessionId
    || typeof requestId !== 'string' || !requestId
    || typeof cwd !== 'string' || !cwd) {
    throw new TypeError('Outbound requires a Session, attachment store, and workspace');
  }
  const resolution = await ctx.sessionController.resolveAgent(sessionId);
  if (!resolution?.agent) throw new Error('WeChat session is unavailable');
  const agent = resolution.agent;
  if (agent.id !== sessionId || !agent.ctx?.tools || !ctx.fs) {
    throw new Error('WeChat Agent is missing scoped tools or plugin filesystem');
  }
  // The Agent context does not inject fs. Use this Host plugin's explicitly
  // injected provider; all reads still enforce canonical workspace containment.
  const fs = ctx.fs;
  const root = await fs.resolve(cwd);
  const rootInfo = await fs.stat(root);
  if (rootInfo?.type !== 'directory') throw new Error('WeChat workspace is not a directory');

  // Never install a tool for a non-WeChat request, including a resumed Agent
  // whose present turn came from Web or another chat channel.
  if (!activeOwner(store.snapshot(), sessionId, requestId)) {
    throw new Error('No active WeChat task for this Agent');
  }
  const definition = {
    name: 'wechat_send_media',
    description: 'Queue a workspace image, file, or video for the current WeChat conversation. Returns the queue id; delivery may remain pending or uncertain.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File within the current workspace; symbolic links outside it are rejected.' },
        kind: { type: 'string', enum: KINDS, description: 'Media presentation: image, file, or video.' },
      },
      required: ['path', 'kind'],
      additionalProperties: false,
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `WeChat media ${value.status}: ${value.id}` }],
    },
    async execute(args, exec) {
      if (exec.agent !== agent || exec.agent?.id !== sessionId) {
        throw new Error('WeChat media access is limited to the current task');
      }
      if (!args || typeof args.path !== 'string' || !args.path.trim()
        || args.path.includes('\0') || !KINDS.includes(args.kind)) {
        throw new TypeError('Expected a workspace file path and a media kind');
      }
      const owner = activeOwner(store.snapshot(), sessionId, requestId);
      if (!owner) throw new Error('WeChat task is no longer active');
      const callId = exec.rootCallId ?? exec.callId;
      const callName = callId === exec.callId ? 'wechat_send_media' : undefined;
      if (!await inspectOwnedToolCall(ctx.sessionController, sessionId, requestId, callId, callName, exec.signal)) {
        throw new Error('Media sending is limited to the admitted WeChat turn');
      }
      const id = messageId(sessionId, exec.callId);
      const previous = store.snapshot();
      if (previous.outbox.some((row) => row.id === id)
        || previous.seen.includes(`\0outbox\0${id}`)) {
        return { id, status: 'already-queued' };
      }

      const target = await fs.resolve(args.path, { cwd, signal: exec.signal });
      if (!fs.contains(root, target)) throw new Error('File is outside the WeChat workspace');
      const info = await fs.stat(target, exec.signal);
      if (info?.type !== 'file') throw new Error('Not a regular file');
      if (info.size !== undefined && info.size > MAX_BYTES) throw new Error('File exceeds 50 MiB');
      const data = await fs.readBytes(target, exec.signal, MAX_BYTES);
      // Re-resolve after reading to narrow a symlink-swap race. The FS service
      // read contract is bounded but does not itself enforce a workspace fence.
      const fresh = await fs.resolve(args.path, { cwd, signal: exec.signal });
      if (!fs.contains(root, fresh) || fresh.targetKey !== target.targetKey) {
        throw new Error('File changed during read');
      }
      exec.signal?.throwIfAborted?.();
      if (!activeOwner(store.snapshot(), sessionId, requestId)) {
        throw new Error('WeChat task ended during file read');
      }
      if (!await inspectOwnedToolCall(ctx.sessionController, sessionId, requestId, callId, callName, exec.signal)) {
        throw new Error('WeChat turn ended during file read');
      }
      const name = safeName(target, args.kind);
      const attachment = await ctx.attachments.saveFile({ data, name });
      let queued = false;
      await store.update((state) => {
        const row = activeOwner(state, sessionId, requestId);
        if (!row) throw new Error('WeChat task ended before queuing media');
        if (state.outbox.some((item) => item.id === id)
          || state.seen.includes(`\0outbox\0${id}`)) return;
        state.outbox.push({ id, status: 'queued', text: '',
          userId: row.userId, contextToken: row.contextToken,
          media: { kind: args.kind, name, attachment } });
        queued = true;
      });
      return { id, status: queued ? 'queued' : 'already-queued' };
    },
  };
  // agent.ctx owns its registration. The returned disposer also lets the
  // caller retire the capability when this specific WeChat request settles.
  return agent.ctx.effect(() => agent.ctx.tools.register(definition));
}
