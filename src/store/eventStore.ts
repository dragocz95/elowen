import type { Db } from './db.js';
import type { OrcaEvent } from '../api/sse.js';

export interface ActivityEvent { id: number; ts: string; type: string; target: string; detail: string }

function toRow(e: OrcaEvent): { type: string; target: string; detail: string } | null {
  switch (e.type) {
    case 'task': return { type: 'task', target: e.taskId, detail: e.status };
    case 'mission': return { type: 'mission', target: e.missionId, detail: e.state };
    case 'signal': return { type: 'signal', target: e.session, detail: e.signal.type };
    case 'plan': return null; // transient job-status ping — not part of the persistent timeline
  }
}

export class EventStore {
  constructor(private db: Db) {}
  record(e: OrcaEvent): void {
    const r = toRow(e);
    if (!r) return;
    this.db.prepare('INSERT INTO events (type, target, detail) VALUES (?, ?, ?)').run(r.type, r.target, r.detail);
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
  list(opts?: { limit?: number; type?: string }): ActivityEvent[] {
    const limit = opts?.limit ?? 200;
    if (opts?.type) {
      return this.db.prepare('SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT ?').all(opts.type, limit) as ActivityEvent[];
    }
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as ActivityEvent[];
  }
}
