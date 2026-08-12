import type { Db } from './db.js';
import type { ElowenEvent } from '../api/sse.js';
import type { EventPersistenceRow } from '../plugins/api.js';

export interface ActivityEvent { id: number; ts: string; type: string; target: string; detail: string; project_id: number | null; label: string }

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
    const r = this.toRow(e);
    if (!r) return;
    // Stamp the event with its owning project so the timeline can scope it to the right repo. The bus
    // subscriber resolves the project for EVERY event type and passes it in; a direct caller that
    // omits it falls back to the row's task lookup (rows without a labelTitleId stay null).
    let pid = projectId;
    if (pid === undefined) {
      pid = r.labelTitleId
        ? (this.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(r.labelTitleId) as { project_id: number } | undefined)?.project_id ?? null
        : null;
    }
    // Snapshot a human label now so the event still reads as a name after its task/epic is deleted
    // (events outlive tasks). The row names the task whose title labels it (task/review → the task,
    // mission → its epic); signal/plan rows carry no title id — the target already reads as a name.
    const label = r.labelTitleId
      ? (this.db.prepare('SELECT title FROM tasks WHERE id = ?').get(r.labelTitleId) as { title: string } | undefined)?.title ?? ''
      : '';
    this.db.prepare('INSERT INTO events (type, target, detail, project_id, label) VALUES (?, ?, ?, ?, ?)').run(r.type, r.target, r.detail, pid, label);
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
    // Target-scoped: the per-task feed (decision + review for one task), read oldest-first so the
    // detail pane renders it as a chronological conversation rather than the reverse-time timeline.
    if (opts?.target) {
      const rows = opts.type
        ? this.db.prepare('SELECT * FROM events WHERE target = ? AND type = ? ORDER BY id ASC LIMIT ?').all(opts.target, opts.type, limit)
        : this.db.prepare('SELECT * FROM events WHERE target = ? ORDER BY id ASC LIMIT ?').all(opts.target, limit);
      return rows as ActivityEvent[];
    }
    if (opts?.type) {
      return this.db.prepare('SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT ?').all(opts.type, limit) as ActivityEvent[];
    }
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as ActivityEvent[];
  }
}
