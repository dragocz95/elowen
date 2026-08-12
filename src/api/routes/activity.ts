import { parseBody, queryInt } from '../validation.js';
import { createNoteSchema } from '../schemas/activity.js';
import type { ElowenApp, RouteContext } from '../context.js';

/** The activity timeline and inter-agent handoff notes. Both are tenancy-scoped: the timeline to the
 *  caller's accessible projects, the notes to the target epic's project. */
export function registerActivityRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d, accessibleProjects, canAccessProject } = ctx;
  app.get('/activity', (c) => {
    if (!d.events) return c.json([]);
    const limit = queryInt(c.req.query('limit'), { min: 1, max: 500, fallback: undefined });
    const type = c.req.query('type') || undefined;
    // `target` scopes the feed to one task (its decisions + review verdicts), read oldest-first — the
    // detail pane's autopilot conversation. Project-scoping below still applies (fail closed for tenants).
    const target = c.req.query('target') || undefined;
    const rows = d.events.list({ limit, type, target });
    // Scope the timeline to the caller's projects (admin/open mode → null → unrestricted). A row with no
    // project (legacy/unresolved) is shown only to the unrestricted caller — fail closed for tenants.
    const allowed = accessibleProjects(c);
    return c.json(allowed ? rows.filter((r) => r.project_id !== null && allowed.has(r.project_id)) : rows);
  });

  // Inter-agent handoff notes. Scope defaults to 'mission'; the target is an epic id (a leading `m-`
  // from a mission id is stripped here so workers — which hold the bare epicId — and the overseer —
  // which holds ELOWEN_MISSION=m-<epicId> — both work). Access is gated by the target epic's project, so
  // an agent can only read/write notes for a mission in a project it is actively working in.
  const noteTarget = (raw: string | undefined): string => {
    const v = raw ?? '';
    // Strip a leading mission `m-` only when the remainder actually resolves to an epic. A blind strip
    // would corrupt the id in a project whose own basename is `m` (its epics are literally `m-<hex>`).
    if (v.startsWith('m-') && d.tasks.get(v.slice(2))) return v.slice(2);
    return v;
  };
  const MAX_NOTE_BODY = 8000;   // a handoff note is a hint for the next agent, not a document dump
  const MAX_NOTES_PER_TARGET = 200; // bound the per-mission log so a looping agent can't inflate the DB
  app.get('/notes', (c) => {
    const scope = c.req.query('scope') || 'mission';
    const target = noteTarget(c.req.query('target'));
    if (!target) return c.json({ error: 'target required' }, 400);
    // Fail CLOSED, mirroring POST: an unresolved target must never list notes unauthenticated. Without
    // this an orphaned note (e.g. one whose epic was deleted) would read back with no project gate at
    // all — a cross-tenant leak reachable even by an agent token. The target must resolve and be allowed.
    const epic = d.tasks.get(target);
    if (!epic) return c.json({ error: 'unknown target' }, 404);
    if (!canAccessProject(c, epic.project_id)) return c.json({ error: 'forbidden' }, 403);
    // The notes store is plugin-owned. A 200-with-[] here would silently strip a worker of its
    // handoff context — degrade EXPLICITLY, like the other agents write paths (tasks.ts).
    if (!d.notes) return c.json({ error: 'agents plugin is disabled' }, 503);
    return c.json(d.notes.list(scope, target));
  });
  app.post('/notes', async (c) => {
    const b = await parseBody(c, createNoteSchema);
    const scope = typeof b.scope === 'string' && b.scope ? b.scope : 'mission';
    const target = noteTarget(typeof b.target === 'string' ? b.target : '');
    const body = typeof b.body === 'string' ? b.body.trim() : '';
    if (!target || !body) return c.json({ error: 'target and body required' }, 400);
    // Bound the write: an agent runs with skip-permissions, so cap body size and the per-target count
    // to keep a prompt-injected loop from inflating the DB (the project's rate-limiting policy).
    if (body.length > MAX_NOTE_BODY) return c.json({ error: 'body too large' }, 400);
    const epic = d.tasks.get(target);
    if (!epic) return c.json({ error: 'unknown target' }, 404);
    if (!canAccessProject(c, epic.project_id)) return c.json({ error: 'forbidden' }, 403);
    if (!d.notes) return c.json({ error: 'agents plugin is disabled' }, 503);
    if (d.notes.count(scope, target) >= MAX_NOTES_PER_TARGET) return c.json({ error: 'too many notes' }, 429);
    const author = typeof b.author === 'string' ? b.author : '';
    return c.json(d.notes.add({ scope, target, author, body }), 201);
  });
}
