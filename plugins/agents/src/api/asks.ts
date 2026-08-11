import { z } from 'zod';
import { createAskService } from './askService.js';
import { resolveOwnerId } from '../lib/owner.js';
import { json, canProject, agentForbidden, type ApiAuth } from './http.js';
import type { AskService } from './askService.js';
import type { PluginContext, PluginHttpResponse } from '../../../../src/plugins/api.js';
import type { AgentsRuntime } from '../runtime.js';

const askSchema = z.object({ text: z.string().min(1).max(4000) });

/** Bound the per-task conversation so a prompt-injected worker in a loop can't inflate the events
 *  table — the same guard the notes route applies (both sides of the thread count). Size is capped by
 *  askSchema.text.max(); this caps the turn count. */
const MAX_ASK_TURNS = 200;

/** The `elowen ask` worker↔autopilot exchange + the on-demand agent control guide, ROOT-mounted at the
 *  grandfathered paths (pattern mounts): POST/GET '/tasks/:id/ask[/:askId[/reply]]', GET
 *  '/tasks/:id/guide' and the humans-only '/asks/pending' inbox. Same auth mechanics as before the
 *  extraction: the core middleware allow-list admits agent tokens to exactly the ask/guide verbs, and
 *  every route is gated by the task's project. */
export function registerAsksApi(ctx: PluginContext, rt: () => AgentsRuntime): void {
  const tasks = () => ctx.host.stores().tasks;

  // ONE ask service per plugin generation — lazy beside the runtime so the runner never builds it.
  let askService: AskService | null = null;
  const asks = (): AskService => {
    askService ??= createAskService({
      tasks: tasks(),
      missions: rt().missions,
      decisionQueue: rt().decisionQueue,
      publishEvent: (e) => ctx.publishEvent(e),
      eventsRead: ctx.host.stores().eventsRead,
      config: ctx.host.config(),
      now: () => Date.now(),
    });
    return askService;
  };

  /** The task the route targets, project-gated — or the error response to return. */
  const gate = (auth: ApiAuth, id: string): { task: { id: string; parent_id: string | null } } | { err: PluginHttpResponse } => {
    const task = tasks().get(id);
    if (!task) return { err: json({ error: 'task not found' }, 404) };
    if (!canProject(auth, task.project_id)) return { err: json({ error: 'forbidden' }, 403) };
    return { task };
  };

  // `elowen ask`: a running worker posts a free-text question for the autopilot and blocks on the
  // reply. The reply is produced async (overseer → human window → sentinel), so this returns an ask id
  // the worker then long-polls; a human answers the same exchange via /reply.
  ctx.registerApiRoute({
    rootMount: '/tasks/:id/ask', path: '', method: 'POST', access: 'agent',
    handler: async (req) => {
      const id = req.params['id']!;
      const g = gate(req.auth, id);
      if ('err' in g) return g.err;
      if (req.path === '') {
        if ((ctx.host.stores().eventsRead?.list({ target: id, type: 'message' }) ?? []).length >= MAX_ASK_TURNS) {
          return json({ error: 'too many questions on this task' }, 429);
        }
        const b = askSchema.parse(await req.json());
        return json(asks().start(id, b.text));
      }
      const segs = req.path.split('/');
      if (segs.length === 2 && segs[1] === 'reply') {
        // Human reply to an agent's open question — an agent must never answer its own ask.
        if (agentForbidden(req.auth, false)) return json({ error: 'forbidden' }, 403);
        const askId = decodeURIComponent(segs[0]!);
        if (asks().taskFor(askId) !== id) return json({ error: 'no such ask' }, 404);
        const b = askSchema.parse(await req.json());
        return asks().reply(askId, b.text) ? json({ ok: true }) : json({ error: 'ask already answered' }, 409);
      }
      return json({ error: 'not found' }, 404);
    },
  });
  // Long-poll an ask's reply: `{ text }` once settled, else `{}` every ~25s so the worker re-polls.
  ctx.registerApiRoute({
    rootMount: '/tasks/:id/ask', path: '', method: 'GET', access: 'agent',
    handler: async (req) => {
      const id = req.params['id']!;
      const g = gate(req.auth, id);
      if ('err' in g) return g.err;
      if (req.path === '' || req.path.includes('/')) return json({ error: 'not found' }, 404);
      const askId = decodeURIComponent(req.path);
      if (asks().taskFor(askId) !== id) return json({ error: 'no such ask' }, 404);
      const raw = Number(req.query['timeoutMs']);
      const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 30_000) : undefined;
      const text = await asks().poll(askId, timeoutMs);
      return json(text === null ? {} : { text });
    },
  });

  // Every ask currently parked on a human, for the Escalations inbox — scoped to the caller's
  // projects. Not in the agent allow-list: this is a human surface.
  ctx.registerApiRoute({
    rootMount: '/asks/pending', path: '', method: 'GET', access: 'user',
    handler: async (req) => json(asks().pending()
      .map((a) => { const task = tasks().get(a.taskId); return task ? { ...a, title: task.title, epicId: task.parent_id, projectId: task.project_id } : null; })
      .filter((a): a is NonNullable<typeof a> => a !== null && canProject(req.auth, a.projectId))),
  });

  // `elowen help` (with ELOWEN_TASK set): the context-aware agent control guide, rendered from the
  // task's live state through the task owner's prompt overrides — the base guide plus a mission-phase
  // appendix (sibling rules, handoff notes, epic close) while the mission is ACTIVE.
  ctx.registerApiRoute({
    rootMount: '/tasks/:id/guide', path: '', method: 'GET', access: 'agent',
    handler: async (req) => {
      const id = req.params['id']!;
      const g = gate(req.auth, id);
      if ('err' in g) return g.err;
      const cli = ctx.host.elowenCli().cli;
      const ownerId = resolveOwnerId({ tasks: tasks(), missions: rt().missions, users: { list: () => ctx.host.stores().usersRead.list().map((u) => ({ id: u.id })) } }, { taskId: id });
      const render = (name: string, vars: Record<string, string>) => ctx.host.prompts().render(name, vars, ownerId ?? undefined);
      let text = render('agent-guide', { cli, closeCommand: `${cli} close ${id}` });
      // A phase belongs to an epic; the mission id is `m-<epicId>`. Only an ACTIVE mission gets the
      // phase appendix — the preamble tells a phase agent to run `elowen help` BEFORE it starts, so it
      // captures the epic-close steps while the mission is still live.
      const epicId = g.task.parent_id;
      if (epicId && rt().missions.activeForEpic(epicId)) {
        text += `\n\n${render('agent-guide-phase', { epicId, cli, epicCloseCommand: `${cli} close ${epicId}` })}`;
      }
      // Lightweight observability: surfaces whether agents actually pull the guide (vs skipping it).
      ctx.logger.info(`guide fetched for ${id}${req.auth.tokenScope === 'agent' ? ' (agent)' : ''}`);
      return json({ text });
    },
  });
}
