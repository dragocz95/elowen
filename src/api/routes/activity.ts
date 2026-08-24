import { queryInt } from '../validation.js';
import { isTeamFeedRow } from '../../store/eventStore.js';
import type { ElowenApp, RouteContext } from '../context.js';

/** The activity timeline, scoped to the caller's accessible projects. (The inter-agent handoff notes
 *  that used to live beside it are served by the agents plugin's root-mounted '/notes' now.) */
export function registerActivityRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d, accessibleProjects } = ctx;

  /** Who is working at this moment, for the team feed's presence line. Instance-wide like the feed
   *  itself, and just as content-free: names only, never what anyone is working ON. Registered before
   *  the '/activity' route below so the literal path is matched first. */
  app.get('/activity/presence', (c) => {
    // One row per PERSON, not per conversation: someone with three running turns is still one person
    // on the rail. An unattributable turn (no account) is dropped rather than shown as a ghost.
    const working = new Set<number>();
    for (const { userId } of d.brain?.presence() ?? []) if (userId !== null) working.add(userId);

    // Anyone who worked recently, so the rail is not empty whenever nobody happens to be mid-turn.
    // `working` is live process state and always wins over the recorded timestamp.
    const seen = new Map<number, string>();
    for (const { userId, lastTs } of d.events?.recentActors(24) ?? []) seen.set(userId, lastTs);

    const rows = [...new Set([...working, ...seen.keys()])].flatMap((id) => {
      const u = d.users?.get(id);
      if (!u) return [];
      return [{
        userId: id,
        label: u.name || u.username,
        username: u.username,
        ...(u.avatar ? { avatar: u.avatar } : {}),
        working: working.has(id),
        lastTs: seen.get(id) ?? '',
      }];
    });
    // Whoever is working first, then by how recently they were seen.
    rows.sort((a, b) => Number(b.working) - Number(a.working) || b.lastTs.localeCompare(a.lastTs));
    return c.json(rows);
  });

  /** Hourly volume behind the dashboard heatmap. Counts only -- who did what is the feed's job -- and
   *  read from the write-time rollup, never from brain_messages. */
  app.get('/activity/heatmap', (c) => {
    if (!d.events) return c.json([]);
    return c.json(d.events.heatmap(queryInt(c.req.query('days'), { min: 1, max: 90, fallback: 14 })));
  });
  app.get('/activity', (c) => {
    if (!d.events) return c.json([]);
    const limit = queryInt(c.req.query('limit'), { min: 1, max: 500, fallback: undefined });
    const type = c.req.query('type') || undefined;
    // `target` scopes the feed to one task (its decisions + review verdicts), read oldest-first — the
    // detail pane's autopilot conversation. Project-scoping below still applies (fail closed for tenants).
    const target = c.req.query('target') || undefined;
    // The team feed answers WHO worked and FROM WHERE. `target` is the session/channel id -- an
    // internal handle the tile does not render, and the feed is read by the whole instance, so it is
    // dropped from feed rows here rather than shipped and ignored by the client.
    const rows = d.events.list({ limit, type, target })
      .map((r) => (isTeamFeedRow(r) ? { ...r, target: '' } : r));
    // Scope the timeline to the caller's projects (admin/open mode → null → unrestricted). A row with no
    // project (legacy/unresolved) is shown only to the unrestricted caller — fail closed for tenants.
    const allowed = accessibleProjects(c);
    if (!allowed) return c.json(rows);
    // The team feed rows are the ONE deliberate exception: they are instance-wide by decision and carry
    // no content to leak — only actor, surface and counts. Everything else stays fail-closed.
    return c.json(rows.filter((r) => isTeamFeedRow(r) || (r.project_id !== null && allowed.has(r.project_id))));
  });
}
