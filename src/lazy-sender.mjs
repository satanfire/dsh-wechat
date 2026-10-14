export const LOADER_NAME = 'load_wechat_tools';
export const LOADER_DESCRIPTION = 'Load WeChat text sending for this session. Use when the user asks to send a message or completion notification to their bound WeChat.';

/** The full sender schema is registered only for the Agent that loads it. */
export function registerLazySender(ctx, controller) {
  const loaded = new Map();
  let closed = false;
  const assertCaller = agent => {
    if (closed || !agent?.ctx || ctx.agents.get(agent.id) !== agent) {
      throw new Error('WeChat tools require the current live session.');
    }
  };
  const offLoader = ctx.tools.register({
    name: LOADER_NAME,
    description: LOADER_DESCRIPTION,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) {
        throw new TypeError('load_wechat_tools takes no parameters.');
      }
      const agent = exec.agent;
      assertCaller(agent);
      exec.signal?.throwIfAborted();
      const { sendTextDefinition } = await import('./push.mjs');
      assertCaller(agent);
      exec.signal?.throwIfAborted();
      const definition = sendTextDefinition(controller);
      if (!loaded.has(agent)) {
        const execute = definition.execute;
        definition.execute = async (args, exec) => {
          assertCaller(agent);
          if (exec.agent !== agent) throw new Error('WeChat sender belongs to another session.');
          return execute(args, exec);
        };
        const off = agent.ctx.effect(() => {
          const offTool = agent.ctx.tools.register(definition);
          return () => { offTool(); loaded.delete(agent); };
        });
        loaded.set(agent, off);
      }
      return `Loaded wechat_send_text for this session.\n${definition.description}\nParameters: ${JSON.stringify(definition.parameters)}`;
    },
  });
  return ctx.effect(() => () => {
    closed = true;
    offLoader();
    for (const off of [...loaded.values()]) off();
    loaded.clear();
  });
}
