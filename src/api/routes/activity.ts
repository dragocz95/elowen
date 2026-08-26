import { queryInt } from '../validation.js';
import { isTeamFeedRow } from '../../store/eventStore.js';
import { isSubagentSession } from '../../brain/sessionId.js';
import type { ElowenApp, RouteContext } from '../context.js';

const HOURS_IN_DAY = 24;
/** The window the pulse ring reports on. Rolling whole days rather than the calendar month so the
 *  comparison between two people is always over the same length of time — on the 1st of a month a
 *  calendar window would divide a few hours of work and read as noise. */
const MONTH_DAYS = 30;

/** Per-person usage summed over a window, from the origin rollup alone.
 *
 *  A row without a cost is a turn nobody priced, not a free one, so null stays distinct from 0 — a
 *  confident $0.00 would understate a real bill. `cacheRead` (context served warm) and `input` (context
 *  paid for fresh) are both kept so the ratio can be weighted by context rather than averaged across
 *  rows, which is what the money actually did. */
interface UsageAcc {
  turns: number; tokens: number; cost: number | null;
  input: number; cacheRead: number; surfaces: string[];
}
function sumUsage(rows: {
  userId: number | null; turns: number; tokens: number; cost: number | null;
  input: number; cacheRead: number; origin: string | null; originKind: string | null;
}[]): Map<number, UsageAcc> {
  const out = new Map<number, UsageAcc>();
  for (const row of rows) {
    if (row.userId === null) continue;
    const acc = out.get(row.userId)
      ?? { turns: 0, tokens: 0, cost: null, input: 0, cacheRead: 0, surfaces: [] };
    acc.turns += row.turns;
    acc.tokens += row.tokens;
    acc.input += row.input;
    acc.cacheRead += row.cacheRead;
    if (row.cost !== null) acc.cost = (acc.cost ?? 0) + row.cost;
    const surface = surfaceOf(row.origin, row.originKind);
    if (surface && !acc.surfaces.includes(surface)) acc.surfaces.push(surface);
    out.set(row.userId, acc);
  }
  return out;
}

/** Warm-context share of everything that was read. Null when nothing ran: a person with no turns has
 *  no cache ratio, and "0 %" reads as a catastrophically cold cache instead of an absent measurement. */
function cachePct(acc: UsageAcc | undefined): number | null {
  const context = (acc?.cacheRead ?? 0) + (acc?.input ?? 0);
  return context > 0 ? ((acc?.cacheRead ?? 0) / context) * 100 : null;
}

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
 *  domain-specific timelines are contributed through plugin routes.) */
export function registerActivityRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d, accessibleProjects } = ctx;

  /** Tool calls are read by extracting them from message bodies, which is too expensive to repeat on
   *  every request against a synchronous database.
   *
   *  The cache is keyed on the newest message rowid rather than on a TTL, which is what makes the feed
   *  live: a timer would either serve a stale feed for its whole window or pay the read on a schedule
   *  nobody asked for, while the rowid changes exactly when new work lands and costs nothing to check.
   *  It lives on the app instance rather than the module, so tests and multiple apps never share one. */
  const TOOL_WINDOW_HOURS = 6;
  let toolCache: { stamp: number; data: Map<string, { at: string; names: string[] }[]> } | null = null;
  const toolCalls = (): Map<string, { at: string; names: string[] }[]> => {
    if (!d.brainStore) return new Map();
    const stamp = d.brainStore.lastMessageRowId();
    if (toolCache && toolCache.stamp === stamp) return toolCache.data;
    // The cap counts TOOL CALLS, not messages: SQLite does the extraction, so the whole window fits in
    // roughly the time the old row-capped read took for its first hour. It stays as a runaway guard.
    const data = d.brainStore.recentToolCalls({ sinceHours: TOOL_WINDOW_HOURS, limit: 8000 });
    toolCache = { stamp, data };
    return data;
  };

  /** Fold one feed row's tool calls into ordered `name ×count` pairs.
   *
   *  Matched by session within a generous window rather than an exact interval: a turn's messages are
   *  persisted in one batch when it settles, so a tool's `created_at` is its SAVE time and can land after
   *  the event that describes it (see the timing note in the message-cost runbook). The feed is an
   *  overview, so a little overlap between adjacent rows beats dropping the tools entirely. */
  function toolsForRow(row: { target: string; ts: string; last_ts?: string | null }): { name: string; count: number }[] {
    const entries = toolCalls().get(row.target);
    if (!entries?.length) return [];
    const from = Date.parse(`${row.ts.replace(' ', 'T')}Z`) - 60_000;
    const to = Date.parse(`${(row.last_ts || row.ts).replace(' ', 'T')}Z`) + 15 * 60_000;
    const counts = new Map<string, number>();
    for (const entry of entries) {
      const at = Date.parse(`${entry.at.replace(' ', 'T')}Z`);
      if (!Number.isFinite(at) || at < from || at > to) continue;
      for (const name of entry.names) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    // Busiest first, capped: a row that ran thirty tools should still read as one line.
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }

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
    // Live turns first, so "working" reflects the daemon's own state rather than the last recorded event.
    // One row per person: somebody with three running turns is one person on the tile, and their titles
    // are collected so the tile can say what they are on rather than picking one at random.
    const live = new Map<number, string[]>();
    let runningAgents = 0;
    for (const { userId, sessionId, title } of d.brain?.presence() ?? []) {
      // A delegated session is a sub-agent, not a person at a keyboard: counted for the "running agents"
      // headline and then skipped, so a busy delegation never draws a second row for its owner.
      if (isSubagentSession(sessionId)) { runningAgents += 1; continue; }
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
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    // The ring reports a month, the gauges above it report today. Both come from the same rollup, read
    // once each — the wider read is the cheap one, since the rollup holds a handful of rows per day.
    const monthFrom = new Date(Date.now() - (MONTH_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    const spend = sumUsage(d.usageOrigins?.topOrigins({ group: 'pair', fromIso: today, limit: 500 }) ?? []);
    const monthSpend = sumUsage(
      d.usageOrigins?.topOrigins({ group: 'pair', fromIso: monthFrom, limit: 500 }) ?? [],
    );

    // Which slot of the month a day falls in, oldest first, so the ring's hover curve is indexable
    // without the client parsing dates.
    const monthStartMs = Date.parse(`${monthFrom}T00:00:00Z`);
    const dayIndex = (day: string): number =>
      Math.round((Date.parse(`${day}T00:00:00Z`) - monthStartMs) / 86_400_000);

    // One read covers all three shapes: today's hours fill nothing else now, yesterday is the headline's
    // baseline, and the per-day counts are the ring's hover curve.
    const hours = new Map<number, number[]>();
    const monthDays = new Map<number, number[]>();
    let turnsYesterday = 0;
    for (const b of d.events?.heatmapByUser(MONTH_DAYS) ?? []) {
      const slot = dayIndex(b.day);
      if (slot >= 0 && slot < MONTH_DAYS) {
        const days = monthDays.get(b.userId) ?? Array<number>(MONTH_DAYS).fill(0);
        days[slot] = (days[slot] ?? 0) + b.count;
        monthDays.set(b.userId, days);
      }
      if (b.day === today) {
        const row = hours.get(b.userId) ?? Array<number>(HOURS_IN_DAY).fill(0);
        if (b.hour >= 0 && b.hour < HOURS_IN_DAY) row[b.hour] = (row[b.hour] ?? 0) + b.count;
        hours.set(b.userId, row);
      } else if (b.day === yesterday) {
        turnsYesterday += b.count;
      }
    }

    const recall = d.memoryStore?.recallActivityToday() ?? { byUser: [], byHour: [] };
    const recallByUser = new Map(recall.byUser.map((r) => [r.userId, r.count]));
    const monthRecall = new Map(
      (d.memoryStore?.recallCountsSince(MONTH_DAYS) ?? []).map((r) => [r.userId, r.count]),
    );
    const memoryByHour = Array<number>(HOURS_IN_DAY).fill(0);
    for (const r of recall.byHour) {
      if (r.hour >= 0 && r.hour < HOURS_IN_DAY) memoryByHour[r.hour] = r.count;
    }

    // Every trace of somebody today counts as being here today. Recalls are included because the usage
    // rollup is written when a turn SETTLES: mid-turn, a person can already have pulled memories while
    // having no spend row yet, and leaving them out would drop the very person who is working.
    const todayIds = new Set([
      ...live.keys(), ...seen.keys(), ...spend.keys(), ...hours.keys(), ...recallByUser.keys(),
    ]);
    // The ring covers a month, so somebody who worked this month but not today still belongs on the tile.
    // They must NOT count as active today, which is why each row carries that separately rather than the
    // headline deriving it from the length of this list.
    const ids = new Set([...todayIds, ...monthSpend.keys(), ...monthDays.keys(), ...monthRecall.keys()]);
    const people = [...ids].flatMap((id) => {
      const u = d.users?.get(id);
      if (!u) return [];
      const s = spend.get(id);
      const m = monthSpend.get(id);
      return [{
        userId: id,
        label: u.name || u.username,
        username: u.username,
        ...(u.avatar ? { avatar: u.avatar } : {}),
        working: live.has(id),
        activeToday: todayIds.has(id),
        title: live.get(id)?.[0] ?? '',
        lastTs: seen.get(id) ?? '',
        turns: s?.turns ?? 0,
        tokens: s?.tokens ?? 0,
        cost: s?.cost ?? null,
        cacheHitPct: cachePct(s),
        memoryHits: recallByUser.get(id) ?? 0,
        surfaces: s?.surfaces ?? [],
        hoursToday: hours.get(id) ?? Array<number>(HOURS_IN_DAY).fill(0),
        month: {
          turns: m?.turns ?? 0,
          tokens: m?.tokens ?? 0,
          cost: m?.cost ?? null,
          cacheHitPct: cachePct(m),
          memoryHits: monthRecall.get(id) ?? 0,
          surfaces: m?.surfaces ?? [],
          days: monthDays.get(id) ?? Array<number>(MONTH_DAYS).fill(0),
        },
      }];
    });
    // Biggest share of the month first, so the ring is drawn largest-slice-first and the colours follow
    // the same order the eye does. Whoever is working breaks a tie, then most recently seen.
    people.sort((a, b) =>
      b.month.tokens - a.month.tokens
      || Number(b.working) - Number(a.working)
      || b.lastTs.localeCompare(a.lastTs));

    const totals = people.reduce(
      (acc, p) => ({
        turns: acc.turns + p.turns,
        tokens: acc.tokens + p.tokens,
        cost: p.cost === null ? acc.cost : (acc.cost ?? 0) + p.cost,
      }),
      { turns: 0, tokens: 0, cost: null as number | null },
    );
    const contextTotal = [...spend.values()].reduce((n, s) => n + s.cacheRead + s.input, 0);
    const cacheReadTotal = [...spend.values()].reduce((n, s) => n + s.cacheRead, 0);
    const monthTotals = [...monthSpend.values()].reduce(
      (acc, s) => ({
        tokens: acc.tokens + s.tokens,
        cost: s.cost === null ? acc.cost : (acc.cost ?? 0) + s.cost,
      }),
      { tokens: 0, cost: null as number | null },
    );

    // Yesterday's totals, read the same way, so the tile can say "+3 vs. yesterday" without the browser
    // asking a second time. Grouped by user because only the sums are needed, not the origin breakdown.
    const priorRows = d.usageOrigins?.topOrigins(
      { group: 'user', fromIso: yesterday, toIso: yesterday, limit: 500 },
    ) ?? [];
    const prior = priorRows.reduce(
      (acc, r) => ({ people: acc.people + 1, turns: acc.turns + r.turns, tokens: acc.tokens + r.tokens }),
      { people: 0, turns: 0, tokens: 0 },
    );

    // Distinguish "nobody spent anything" from "the rollup is not there": without this the tile would
    // render a confident $0 for an instance whose usage store failed to open.
    return c.json({
      today,
      people,
      month: { from: monthFrom, days: MONTH_DAYS, tokens: monthTotals.tokens, cost: monthTotals.cost },
      totals: {
        ...totals,
        // Counted off the flag, not off `people.length`: the list now also carries people who worked
        // earlier in the month, and this gauge means "here today".
        activePeople: people.filter((p) => p.activeToday).length,
        runningAgents,
        memoryHits: recall.byUser.reduce((n, r) => n + r.count, 0),
        cacheHitPct: contextTotal > 0 ? (cacheReadTotal / contextTotal) * 100 : null,
      },
      yesterday: { people: prior.people, turns: prior.turns || turnsYesterday, tokens: prior.tokens },
      memoryByHour,
      spendAvailable: Boolean(d.usageOrigins),
    });
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
    // detail pane's plugin-owned conversation. Project-scoping below still applies (fail closed for tenants).
    const target = c.req.query('target') || undefined;
    // The team feed answers WHO worked, FROM WHERE and — now — WITH WHAT. `target` is the session id,
    // an internal handle the tile does not render, so it is resolved into the row's tool list here and
    // then dropped rather than shipped to a client that is not allowed to see it.
    const rows = d.events.list({ limit, type, target })
      .map((r) => (isTeamFeedRow(r) ? { ...r, tools: toolsForRow(r), target: '' } : r));
    // Scope the timeline to the caller's projects (admin/open mode → null → unrestricted). A row with no
    // project (legacy/unresolved) is shown only to the unrestricted caller — fail closed for tenants.
    const allowed = accessibleProjects(c);
    if (!allowed) return c.json(rows);
    // The team feed rows are the ONE deliberate exception: they are instance-wide by decision and carry
    // no content to leak — only actor, surface and counts. Everything else stays fail-closed.
    return c.json(rows.filter((r) => isTeamFeedRow(r) || (r.project_id !== null && allowed.has(r.project_id))));
  });
}
