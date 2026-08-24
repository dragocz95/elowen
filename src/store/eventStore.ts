import { tolerateMissingPluginTables } from './db.js';
import type { Db } from './db.js';
import { ACTIVITY_KINDS, type ElowenEvent } from '../api/sse.js';
import type { EventPersistenceRow } from '../plugins/api.js';

export interface ActivityEvent {
  id: number; ts: string; type: string; target: string; detail: string; project_id: number | null; label: string;
  /** Attribution. `actor_user_id` is the stored fact; `actor_label` is resolved by JOIN at read time
   *  (users.name, username fallback) so a rename is reflected in the whole history at once. */
  actor_user_id: number | null;
  actor_label: string;
  /** Resolved by the same JOIN, so the feed can draw the person's face rather than a name alone. Null
   *  for an unattributable row and for one whose account is gone. */
  actor_username: string | null;
  actor_avatar: string | null;
  surface: string;
  /** How many identical events this row folds, and when the last one landed. `ts` stays the first. */
  count: number;
  last_ts: string | null;
}

/** Does this persisted row belong to the instance-wide team feed? Rows are stored with the KIND as
 *  their `type`, so this is the one place that maps stored rows back to the feed vocabulary — the read
 *  route uses it to widen tenancy for exactly these and nothing else.
 *
 *  A matching `type` is NOT enough. A plugin event-row resolver may return any type it likes, and
 *  'turn' would then buy that row instance-wide visibility past project scoping. `surface` is set by
 *  recordActivity and by nothing else, so it is the mark that cannot be claimed from outside. */
export function isTeamFeedRow(row: { type: string; surface?: string }): boolean {
  return (ACTIVITY_KINDS as readonly string[]).includes(row.type) && !!row.surface;
}

/** How long identical events keep folding into one row. Long enough that a burst of turns reads as one
 *  line, short enough that the feed still shows the shape of someone's afternoon. */
const AGGREGATION_WINDOW_MINUTES = 10;

/** The CORE persistence mapping: only the event shapes core itself owns. Everything agents-domain
 *  (mission/review/decision/message/signal) is mapped by the agents plugin's registered row resolver —
 *  with that plugin disabled those events are simply not persisted, matching the rest of the
 *  disabled-plugin degradation. Old rows are untouched either way: the resolver emits the exact same
 *  `type` strings the core mapping used to, so the persisted timeline stays one continuous format. */
function coreToRow(e: ElowenEvent): EventPersistenceRow | null {
  switch (e.type) {
    case 'task': return { type: 'task', target: e.taskId, detail: e.status, labelTitleId: e.taskId };
    case 'change': return null; // transient live-refresh ping (git is its own source of truth) — not persisted
    case 'ask': return null; // transient pending-ask nudge for the Escalations inbox — not persisted
    case 'plan': return null; // transient job-status ping — not part of the persistent timeline
    // transient "your memory counters moved" nudge — memory_events is the durable record for memories
    case 'memory': return null;
    // The target stays the external identity, because that is what an audit trail has to pin down. The
    // label carries the account name when one was resolved — a denied sign-in has no account yet, and
    // then the identity IS the only honest thing to show.
    case 'auth': return { type: e.kind, target: e.subject, detail: e.detail, label: e.label };
    // A plugin event lands in the timeline as `plugin:<name>` so the feed can filter per plugin; the
    // payload is the plugin's own JSON (rendered by its UI, opaque to the core).
    case 'plugin': return { type: `plugin:${e.plugin}`, target: e.kind, detail: JSON.stringify(e.data ?? null) };
    default: return null; // plugin-domain shapes — a registered row resolver may claim them below
  }
}

export class EventStore {
  /** `rowResolvers` is a LIVE accessor over the plugin registry (a reload swaps the set) — each
   *  resolver may claim an event core does not persist itself. First claim wins; a throwing resolver
   *  is skipped so a plugin bug never takes down the bus recorder. */
  constructor(private db: Db, private rowResolvers?: () => readonly ((e: ElowenEvent) => EventPersistenceRow | null | undefined)[]) {}
  private toRow(e: ElowenEvent): EventPersistenceRow | null {
    const core = coreToRow(e);
    if (core) return core;
    for (const resolve of this.rowResolvers?.() ?? []) {
      try {
        const row = resolve(e);
        if (row) return row;
      } catch { /* skip this resolver — persistence must never crash the recorder */ }
    }
    return null;
  }
  record(e: ElowenEvent, projectId?: number | null): void {
    // The team feed has its own write path because it AGGREGATES: an identical event inside the window
    // bumps a counter instead of adding a row. It also carries an actor, which no other event shape has.
    if (e.type === 'activity') { this.recordActivity(e, projectId ?? null); return; }
    const r = this.toRow(e);
    if (!r) return;
    // Stamp the event with its owning project so the timeline can scope it to the right repo. The bus
    // subscriber resolves the project for EVERY event type and passes it in; a direct caller that
    // omits it falls back to the row's task lookup (rows without a labelTitleId stay null).
    // `tasks` is a WORK-PLUGIN table: with that plugin disabled the timeline stays core and still
    // records the event, it merely has no task to derive a project or a label from (another plugin's
    // resolver can still name one — an agents mission event labels itself with its epic).
    const task = r.labelTitleId
      ? tolerateMissingPluginTables(
          () => this.db.prepare('SELECT project_id, title FROM tasks WHERE id = ?').get(r.labelTitleId) as { project_id: number; title: string } | undefined,
          undefined)
      : undefined;
    let pid = projectId;
    if (pid === undefined) pid = task?.project_id ?? null;
    // Snapshot a human label now so the event still reads as a name after its task/epic is deleted
    // (events outlive tasks). The row names the task whose title labels it (task/review → the task,
    // mission → its epic); signal/plan rows carry no title id — the target already reads as a name.
    // A row that set `label` itself has no task behind it at all and wins outright.
    const label = r.label ?? task?.title ?? '';
    this.db.prepare('INSERT INTO events (type, target, detail, project_id, label) VALUES (?, ?, ?, ?, ?)').run(r.type, r.target, r.detail, pid, label);
  }
  /** Write one team-feed event, folding it into an existing row when an identical one is already in
   *  the current window. Identical means the same actor, surface and kind — the target may differ (a
   *  second conversation), so the row keeps the FIRST one and the count says how many followed. Aggregation is at WRITE time deliberately: the read side is a
   *  dashboard tile that must not scan and group the whole table on every poll. */
  private recordActivity(e: Extract<ElowenEvent, { type: 'activity' }>, pid: number | null): void {
    this.bumpActivityBucket(e.actorUserId);
    const bumped = this.db.prepare(
      `UPDATE events SET count = count + 1, last_ts = datetime('now')
        WHERE id = (
          SELECT id FROM events
           WHERE type = @type AND actor_user_id IS @actor AND surface = @surface AND project_id IS @pid
             AND COALESCE(last_ts, ts) >= datetime('now', '-${AGGREGATION_WINDOW_MINUTES} minutes')
           ORDER BY id DESC LIMIT 1)`
    ).run({ type: e.kind, actor: e.actorUserId, surface: e.surface, pid }).changes;
    if (bumped > 0) return;
    this.db.prepare(
      `INSERT INTO events (type, target, detail, project_id, label, actor_user_id, surface, count, last_ts)
       VALUES (@type, @target, '', @pid, '', @actor, @surface, 1, datetime('now'))`
    ).run({ type: e.kind, target: e.target, pid, actor: e.actorUserId, surface: e.surface });
  }

  /** Bump the hourly rollup behind the heatmap. Separate from the feed row on purpose: the feed folds
   *  a burst into ONE line so it stays readable, while the heatmap wants every turn counted, so the two
   *  cannot share a counter. Written here rather than derived on read — see the table comment. */
  private bumpActivityBucket(actorUserId: number | null): void {
    this.db.prepare(
      `INSERT INTO activity_buckets (day, hour, user_id, count)
       VALUES (strftime('%Y-%m-%d','now'), CAST(strftime('%H','now') AS INTEGER), @actor, 1)
       ON CONFLICT(day, hour, user_id) DO UPDATE SET count = count + 1`
    ).run({ actor: actorUserId ?? 0 });
  }

  /** Hourly activity for the dashboard heatmap, newest `days` days, aggregated across everyone.
   *  Counts only: who did what is the feed's job, and this is read by the whole instance. */
  heatmap(days: number): { day: string; hour: number; count: number }[] {
    return this.db.prepare(
      `SELECT day, hour, SUM(count) AS count
         FROM activity_buckets
        WHERE day >= strftime('%Y-%m-%d', 'now', ?)
        GROUP BY day, hour
        ORDER BY day, hour`
    ).all(`-${Math.max(1, Math.min(90, Math.trunc(days)))} days`) as { day: string; hour: number; count: number }[];
  }

  /** Who has been active in the last `hours`, most recent first, from the feed rows themselves.
   *  Presence alone would leave the rail empty whenever nobody happens to be mid-turn, which is most of
   *  the time; this answers "who is around today" without inventing a second state table. */
  recentActors(hours: number): { userId: number; lastTs: string }[] {
    return this.db.prepare(
      `SELECT actor_user_id AS userId, MAX(COALESCE(last_ts, ts)) AS lastTs
         FROM events
        WHERE actor_user_id IS NOT NULL
          AND surface <> ''
          AND COALESCE(last_ts, ts) >= datetime('now', ?)
        GROUP BY actor_user_id
        ORDER BY lastTs DESC`
    ).all(`-${Math.max(1, Math.min(720, Math.trunc(hours)))} hours`) as { userId: number; lastTs: string }[];
  }

  /** Purge all events for a target (e.g. a deleted task) so the timeline shows no dead feed. */
  deleteForTarget(target: string): void {
    this.db.prepare('DELETE FROM events WHERE target = ?').run(target);
  }
  /** Wipe the whole activity feed (admin cleanup). Returns the number of rows removed. */
  deleteAll(): number {
    return this.db.prepare('DELETE FROM events').run().changes;
  }
  /** Retention: drop events older than `days` so a long-running daemon's timeline can't grow without
   *  bound. Returns the number of rows removed. `days` is clamped to a positive integer. */
  purgeOlderThan(days = 30): number {
    const d = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 30;
    return this.db.prepare(`DELETE FROM events WHERE ts < datetime('now', '-${d} days')`).run().changes;
  }
  list(opts?: { limit?: number; type?: string; target?: string }): ActivityEvent[] {
    const limit = opts?.limit ?? 200;
    // Every read goes through this projection so the actor's name is resolved in ONE place. It is a
    // LEFT JOIN: an event whose account was deleted keeps its history and simply loses the name.
    const select = `SELECT e.*, COALESCE(NULLIF(u.name, ''), u.username, '') AS actor_label,
                             u.username AS actor_username, u.avatar AS actor_avatar
                      FROM events e LEFT JOIN users u ON u.id = e.actor_user_id`;
    // Target-scoped: the per-task feed (decision + review for one task), read oldest-first so the
    // detail pane renders it as a chronological conversation rather than the reverse-time timeline.
    if (opts?.target) {
      const rows = opts.type
        ? this.db.prepare(`${select} WHERE e.target = ? AND e.type = ? ORDER BY e.id ASC LIMIT ?`).all(opts.target, opts.type, limit)
        : this.db.prepare(`${select} WHERE e.target = ? ORDER BY e.id ASC LIMIT ?`).all(opts.target, limit);
      return rows as ActivityEvent[];
    }
    if (opts?.type) {
      return this.db.prepare(`${select} WHERE e.type = ? ORDER BY e.id DESC LIMIT ?`).all(opts.type, limit) as ActivityEvent[];
    }
    return this.db.prepare(`${select} ORDER BY e.id DESC LIMIT ?`).all(limit) as ActivityEvent[];
  }
}
