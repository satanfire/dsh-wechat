const PATH = '/api/dsh-wechat';
const MAX_BODY_BYTES = 4096;
const ACTIONS = new Set(['login', 'start', 'stop', 'logout']);

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function publicStatus(controller) {
  const state = await controller.status();
  return { ...state, error: state.error ? 'service-error' : null };
}

function failure() {
  // Provider errors can include bot tokens or signed URLs.
  return response({ error: 'operation-failed' }, 500);
}

/** Register on Connection's authenticated, Host/Origin-checked /api carrier. */
export function registerHttp(ctx, controller) {
  if (!ctx?.connection?.fetch?.register) throw new TypeError('connection.fetch is required');
  if (!controller || typeof controller.status !== 'function' || typeof controller.action !== 'function') {
    throw new TypeError('controller must implement status() and action(name)');
  }
  return ctx.connection.fetch.register({
    path: PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method === 'GET') {
        try { return response(await publicStatus(controller)); }
        catch { return failure(); }
      }
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return response({ error: 'content-type-must-be-json' }, 415);
      }
      const declared = request.headers.get('content-length');
      if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
        return response({ error: 'request-too-large' }, 413);
      }
      let body;
      try {
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength > MAX_BODY_BYTES) return response({ error: 'request-too-large' }, 413);
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        return response({ error: 'invalid-json' }, 400);
      }
      if (!body || Array.isArray(body) || typeof body !== 'object'
        || Object.keys(body).length !== 1 || !ACTIONS.has(body.action)) {
        return response({ error: 'invalid-action' }, 400);
      }
      try {
        await controller.action(body.action);
        return response(await publicStatus(controller));
      } catch {
        return failure();
      }
    },
  });
}
