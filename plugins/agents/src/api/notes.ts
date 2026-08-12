import { z } from 'zod';
import { json, canProject, type ApiAuth } from './http.js';
import type { PluginApiRequest, PluginContext, PluginHttpResponse } from '../../../../src/plugins/api.js';
import type { AgentsRuntime } from '../runtime.js';

const createNoteSchema = z.object({
  scope: z.string().optional(),
  target: z.string().optional(),
  author: z.string().optional(),
  body: z.string().optional(),
});

const MAX_NOTE_BODY = 8000;   // a handoff note is a hint for the next agent, not a document dump
const MAX_NOTES_PER_TARGET = 200; // bound the per-mission log so a looping agent can't inflate the DB

/** Inter-agent handoff notes, ROOT-mounted at the grandfathered '/notes' paths (elowen note add|ls).
 *  Scope defaults to 'mission'; the target is an epic id (a leading `m-` from a mission id is stripped
 *  so workers — which hold the bare epicId — and the overseer — which holds ELOWEN_MISSION=m-<epicId> —
 *  both work). Access is gated by the target epic's project, so an agent can only read/write notes for
 *  a mission in a project it is actively working in. Both verbs are agent-reachable by design (the old
 *  core allow-list admitted exactly GET/POST /notes); with the plugin disabled the mount answers the
 *  declared-inactive 503. */
export function registerNotesApi(ctx: PluginContext, rt: () => AgentsRuntime): void {
  const tasks = () => ctx.host.stores().tasks;

  const noteTarget = (raw: string | undefined): string => {
    const v = raw ?? '';
    // Strip a leading mission `m-` only when the remainder actually resolves to an epic. A blind strip
    // would corrupt the id in a project whose own basename is `m` (its epics are literally `m-<hex>`).
    if (v.startsWith('m-') && tasks().get(v.slice(2))) return v.slice(2);
    return v;
  };

  // Fail CLOSED on both verbs: an unresolved target must never list/accept notes — an orphaned note
  // (e.g. one whose epic was deleted) would otherwise read back with no project gate at all, a
  // cross-tenant leak reachable even by an agent token. The target must resolve and be allowed.
  const gate = (auth: ApiAuth, target: string): PluginHttpResponse | null => {
    const epic = tasks().get(target);
    if (!epic) return json({ error: 'unknown target' }, 404);
    if (!canProject(auth, epic.project_id)) return json({ error: 'forbidden' }, 403);
    return null;
  };

  ctx.registerApiRoute({
    rootMount: '/notes', path: '', method: 'GET', access: 'agent',
    handler: async (req) => {
      if (req.path !== '') return json({ error: 'not found' }, 404);
      const scope = req.query.scope || 'mission';
      const target = noteTarget(req.query.target);
      if (!target) return json({ error: 'target required' }, 400);
      return gate(req.auth, target) ?? json(rt().notes.list(scope, target));
    },
  });

  ctx.registerApiRoute({
    rootMount: '/notes', path: '', method: 'POST', access: 'agent',
    handler: async (req: PluginApiRequest) => {
      if (req.path !== '') return json({ error: 'not found' }, 404);
      const b = createNoteSchema.parse(await req.json());
      const scope = typeof b.scope === 'string' && b.scope ? b.scope : 'mission';
      const target = noteTarget(typeof b.target === 'string' ? b.target : '');
      const body = typeof b.body === 'string' ? b.body.trim() : '';
      if (!target || !body) return json({ error: 'target and body required' }, 400);
      // Bound the write: an agent runs with skip-permissions, so cap body size and the per-target count
      // to keep a prompt-injected loop from inflating the DB (the project's rate-limiting policy).
      if (body.length > MAX_NOTE_BODY) return json({ error: 'body too large' }, 400);
      const gated = gate(req.auth, target);
      if (gated) return gated;
      if (rt().notes.count(scope, target) >= MAX_NOTES_PER_TARGET) return json({ error: 'too many notes' }, 429);
      const author = typeof b.author === 'string' ? b.author : '';
      return json(rt().notes.add({ scope, target, author, body }), 201);
    },
  });
}
