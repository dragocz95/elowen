import { queryInt } from '../validation.js';
import { isTeamFeedRow } from '../../store/eventStore.js';
import type { ElowenApp, RouteContext } from '../context.js';

/** The activity timeline, scoped to the caller's accessible projects. (The inter-agent handoff notes
 *  that used to live beside it are served by the agents plugin's root-mounted '/notes' now.) */
export function registerActivityRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d, accessibleProjects } = ctx;
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
    if (!allowed) return c.json(rows);
    // The team feed rows are the ONE deliberate exception: they are instance-wide by decision and carry
    // no content to leak — only actor, surface and counts. Everything else stays fail-closed.
    return c.json(rows.filter((r) => isTeamFeedRow(r) || (r.project_id !== null && allowed.has(r.project_id))));
  });
}
