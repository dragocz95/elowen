import { queryInt } from '../validation.js';
import { isTeamFeedRow } from '../../store/eventStore.js';
import type { ElowenApp, RouteContext } from '../context.js';

/** Where a turn came from, as the pulse tile labels it. The rollup stores platform turns as
 *  'platform:<name>', local CLI turns as 'local', daemon-internal work as 'internal', and web turns
 *  under the caller's IP — so the surface is already in the row and needs no second lookup.
 *  An unrecognised kind returns '' rather than a guess: a wrong badge is worse than no badge. */
function surfaceOf(origin: string | null, kind: string | null): string {
  if (kind === 'platform') return origin?.startsWith('platform:') ? origin.slice('platform:'.length) : 'platform';
  if (kind === 'local') return 'cli';
  if (kind === 'internal') return 'internal';
  if (kind === 'ip') return 'web';
  return '';
}

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

  /** Everything the dashboard's team pulse tile draws, in one request: who is around, what they are
   *  working on, today's spend, and the per-person hourly rhythm behind the ridgeline.
   *
   *  ⚠️ This route deliberately reports MORE than '/activity/presence' and '/activity/heatmap' above,
   *  which are content-free by design. Showing the open conversation's title and each person's token
   *  and dollar spend to everyone on the instance is a product decision by the instance owner
   *  (25 Aug 2026), not an oversight — a team that shares an agent budget wanted to see where it goes.
   *  Do not "restore" the older, narrower contract here without asking; equally, do not widen the two
   *  routes above to match, because the feed still leans on them staying content-free.
   *
   *  Spend is read from the `usage_by_origin` rollup ALONE, which is the only source of origin-attributed
   *  usage — never from brain_messages, whatever breakdown gets asked for next (see AGENTS.md). That
   *  rollup also carries the surface: platform turns are stored as 'platform:discord', 'platform:cron'
   *  and friends, so where somebody works needs no second table. */
  app.get('/activity/pulse', (c) => {
    const days = queryInt(c.req.query('days'), { min: 1, max: 90, fallback: 14 });

    // Live turns first, so "working" reflects the daemon's own state rather than the last recorded event.
    // One row per person: somebody with three running turns is one person on the tile, and their titles
    // are collected so the tile can say what they are on rather than picking one at random.
    const live = new Map<number, string[]>();
    for (const { userId, title } of d.brain?.presence() ?? []) {
      if (userId === null) continue;
      const titles = live.get(userId) ?? [];
      if (title) titles.push(title);
      live.set(userId, titles);
    }

    const seen = new Map<number, string>();
    for (const { userId, lastTs } of d.events?.recentActors(24) ?? []) seen.set(userId, lastTs);

    // Today on the rollup's own UTC day basis, which is how the rows are keyed — asking in local time
    // would silently drop the evening's turns for anyone east of UTC.
    const today = new Date().toISOString().slice(0, 10);
    const usage = d.usageOrigins?.topOrigins({ group: 'pair', fromIso: today, limit: 500 }) ?? [];
    const spend = new Map<number, { turns: number; tokens: number; cost: number | null; surfaces: string[] }>();
    for (const row of usage) {
      if (row.userId === null) continue;
      const acc = spend.get(row.userId) ?? { turns: 0, tokens: 0, cost: null, surfaces: [] };
      acc.turns += row.turns;
      acc.tokens += row.tokens;
      // A rollup row without a cost is a turn nobody priced, not a free one: keep null distinct from 0
      // so the tile can say "not priced" instead of quietly reporting zero dollars.
      if (row.cost !== null) acc.cost = (acc.cost ?? 0) + row.cost;
      const surface = surfaceOf(row.origin, row.originKind);
      if (surface && !acc.surfaces.includes(surface)) acc.surfaces.push(surface);
      spend.set(row.userId, acc);
    }

    const rhythm = new Map<number, { day: string; hour: number; count: number }[]>();
    for (const b of d.events?.heatmapByUser(days) ?? []) {
      const rows = rhythm.get(b.userId) ?? [];
      rows.push({ day: b.day, hour: b.hour, count: b.count });
      rhythm.set(b.userId, rows);
    }

    const ids = new Set([...live.keys(), ...seen.keys(), ...spend.keys(), ...rhythm.keys()]);
    const people = [...ids].flatMap((id) => {
      const u = d.users?.get(id);
      if (!u) return [];
      const s = spend.get(id);
      return [{
        userId: id,
        label: u.name || u.username,
        username: u.username,
        ...(u.avatar ? { avatar: u.avatar } : {}),
        working: live.has(id),
        title: live.get(id)?.[0] ?? '',
        lastTs: seen.get(id) ?? '',
        turns: s?.turns ?? 0,
        tokens: s?.tokens ?? 0,
        cost: s?.cost ?? null,
        surfaces: s?.surfaces ?? [],
        rhythm: rhythm.get(id) ?? [],
      }];
    });
    // Whoever is working, then whoever burned the most today, then most recently seen. Sorting by spend
    // rather than name keeps the tallest ridgeline layers near the top, where the eye starts.
    people.sort((a, b) =>
      Number(b.working) - Number(a.working) || b.tokens - a.tokens || b.lastTs.localeCompare(a.lastTs));

    const totals = people.reduce(
      (acc, p) => ({
        turns: acc.turns + p.turns,
        tokens: acc.tokens + p.tokens,
        cost: p.cost === null ? acc.cost : (acc.cost ?? 0) + p.cost,
      }),
      { turns: 0, tokens: 0, cost: null as number | null },
    );
    // Distinguish "nobody spent anything" from "the rollup is not there": without this the tile would
    // render a confident $0 for an instance whose usage store failed to open.
    return c.json({ days, today, people, totals, spendAvailable: Boolean(d.usageOrigins) });
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
