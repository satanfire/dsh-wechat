import { inspectRequest } from './harness.mjs';

/** A tool call belongs to this WeChat request only in its unambiguous open turn. */
export function ownedToolCall(events, requestId, callId, toolName) {
  if (!Array.isArray(events) || !requestId || !callId) return null;
  const request = inspectRequest(events, requestId);
  if (request.status !== 'admitted') return null;
  const admitted = events.find(event => event.type === 'user/message'
    && event.data?.source?.kind === 'user' && event.data.source.rpcId === requestId);
  if (!admitted) return null;
  const calls = events.filter(event => event.type === 'tool/call'
    && event.data?.callId === callId && event.data.turn === request.turn
    && event.seq > admitted.seq && (!toolName || event.data.name === toolName));
  return calls.length === 1 ? calls[0].data : null;
}

export async function inspectOwnedToolCall(controller, sessionId, requestId, callId, toolName, signal) {
  const { events } = await controller.inspect(sessionId, signal);
  return ownedToolCall(events, requestId, callId, toolName);
}
