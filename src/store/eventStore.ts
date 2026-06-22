import type { Db } from './db.js';
import type { OrcaEvent } from '../api/sse.js';

export interface ActivityEvent { id: number; ts: string; type: string; target: string; detail: string; project_id: number | null; label: string }

function toRow(e: OrcaEvent): { type: string; target: string; detail: string } | null {
  switch (e.type) {
    case 'task': return { type: 'task', target: e.taskId, detail: e.status };
    case 'mission': return { type: 'mission', target: e.missionId, detail: e.state };
    case 'review': return { type: 'review', target: e.taskId, detail: `${e.approve ? 'approved' : 'escalated'}: ${e.rationale}` };
    case 'signal': return { type: 'signal', target: e.session, detail: e.signal.type };
    case 'plan': return null; // transient job-status ping — not part of the persistent timeline
  }
}

export class EventStore {
  constructor(private db: Db) {}
  record(e: OrcaEvent): void {
    const r = toRow(e);
    if (!r) return;
    // Task/review events point at a task → stamp the event with that task's project so the timeline
    // can scope/link it to the right repo. Mission/signal carry no task, so project stays null.
    const taskId = e.type === 'task' || e.type === 'review' ? e.taskId : null;
    const projectId = taskId
      ? (this.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: number } | undefined)?.project_id ?? null
      : null;
    // Snapshot a human label now so the event still reads as a name after its task/epic is deleted
    // (events outlive tasks). Resolve the title for task/review (the target id) and mission (the epic
    // id inside m-<epicId>); signal/plan keep the agent/job name the target already carries.
    const titleId = taskId ?? (e.type === 'mission' && e.missionId.startsWith('m-') ? e.missionId.slice(2) : null);
    const label = titleId
      ? (this.db.prepare('SELECT title FROM tasks WHERE id = ?').get(titleId) as { title: string } | undefined)?.title ?? ''
      : '';
    this.db.prepare('INSERT INTO events (type, target, detail, project_id, label) VALUES (?, ?, ?, ?, ?)').run(r.type, r.target, r.detail, projectId, label);
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
