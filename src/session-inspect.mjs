/**
 * Read one Session's header and durable event prefix without activating its Agent.
 *
 * DSH 0.2.1 exposed `sessionController.inspect`; 0.2.2 removed it and kept the
 * same observation behind `sessionQuery.observeSession`. Prefer the old call
 * when the runtime still provides one, then fall back to the query service
 * (live-preferred and cold-safe). Both branches answer the same shape, so the
 * caller keeps one code path.
 *
 * @param ctx - Host plugin context carrying `sessionController` or `sessionQuery`.
 * @param sessionId - durable Session identity.
 * @param signal - optional caller cancellation for persistence reads.
 * @returns `{ meta, inheritedEventCount, events }` with a plain events array.
 * @throws when the runtime exposes neither inspection surface.
 */
export async function inspectSession(ctx, sessionId, signal) {
  const controller = ctx?.sessionController;
  if (typeof controller?.inspect === 'function') {
    return await controller.inspect(sessionId, signal);
  }
  const query = typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined;
  if (typeof query?.observeSession !== 'function') {
    throw new Error('Session inspection is unavailable: the runtime exposes neither sessionController.inspect nor sessionQuery.observeSession');
  }
  const observation = await query.observeSession(sessionId, {
    ...(signal === undefined ? {} : { signal }),
    projectionMode: 'none',
  });
  try {
    return {
      meta: observation.header,
      inheritedEventCount: observation.inheritedEventCount,
      events: [...observation.events],
    };
  } finally {
    // The lease pins its cached entry; release it before the read settles.
    observation[Symbol.dispose]?.();
  }
}
