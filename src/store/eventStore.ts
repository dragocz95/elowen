import type { Db } from './db.js';
import type { OrcaEvent } from '../api/sse.js';

export interface ActivityEvent { id: number; ts: string; type: string; target: string; detail: string }

function toRow(e: OrcaEvent): { type: string; target: string; detail: string } {
  switch (e.type) {
    case 'task': return { type: 'task', target: e.taskId, detail: e.status };
    case 'mission': return { type: 'mission', target: e.missionId, detail: e.state };
    case 'signal': return { type: 'signal', target: e.session, detail: e.signal.type };
  }
}

export class EventStore {
  constructor(private db: Db) {}
  record(e: OrcaEvent): void {
    const r = toRow(e);
    this.db.prepare('INSERT INTO events (type, target, detail) VALUES (?, ?, ?)').run(r.type, r.target, r.detail);
  }
  /** Purge all events for a target (e.g. a deleted task) so the timeline shows no dead feed. */
  deleteForTarget(target: string): void {
    this.db.prepare('DELETE FROM events WHERE target = ?').run(target);
  }
  list(opts?: { limit?: number; type?: string }): ActivityEvent[] {
    const limit = opts?.limit ?? 200;
    if (opts?.type) {
      return this.db.prepare('SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT ?').all(opts.type, limit) as ActivityEvent[];
    }
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as ActivityEvent[];
  }
}
