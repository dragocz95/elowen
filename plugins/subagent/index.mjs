// Subagent plugin: `delegate` spawns a fresh, isolated sub-agent conversation for one self-contained
// task and returns its final answer. It reuses the platform channel path — the host runs the sub-prompt
// as its own brain session (its own context window, its own tools) and hands back the reply. The child
// inherits EXACTLY the caller's access (ctx.currentAccess), so a scoped session can't widen its reach
// by delegating. Each call gets a unique channel id → a clean-slate agent every time.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });

export function register(ctx) {
  let run = null; // the host's channel handler, captured on connect

  ctx.registerPlatform({
    name: 'subagent',
    listen: (onMessage) => { run = onMessage; },
    connect: async () => { /* nothing to connect — we only borrow the handler */ },
    send: async () => { /* replies are returned synchronously from the handler */ },
  });

  ctx.registerTool(defineTool({
    name: 'delegate', label: 'Delegate to sub-agent',
    description: 'Hand a self-contained task to a fresh sub-agent with its own clean context, and get back '
      + 'its result. Use for focused side-quests (research a file, draft a section, run a check) so your '
      + 'main conversation stays uncluttered. The sub-agent has the same tools and access as you.',
    parameters: Type.Object({
      task: Type.String({ description: 'The complete, self-contained instruction for the sub-agent — it does not see this conversation.' }),
    }),
    execute: async (_id, p) => {
      if (!run) return ok('Error: delegation is not wired up on this server.');
      const access = { ...ctx.currentAccess(), prompt: 'You are a focused sub-agent. Complete the task and report the result concisely — no preamble.' };
      const channelId = `sub-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const reply = await run({ platform: 'subagent', userId: 'subagent', roleIds: [], channelId, access }, p.task)
        .catch((e) => `Error: ${e?.message ?? e}`);
      return ok(reply || '(the sub-agent returned nothing)');
    },
  }));

  ctx.logger.info('delegate tool registered');
}
