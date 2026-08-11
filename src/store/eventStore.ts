import type { Db } from './db.js';
import type { ElowenEvent } from '../api/sse.js';

export interface ActivityEvent { id: number; ts: string; type: string; target: string; detail: string; project_id: number | null; label: string }

function toRow(e: ElowenEvent): { type: string; target: string; detail: string } | null {
  switch (e.type) {
    case 'task': return { type: 'task', target: e.taskId, detail: e.status };
    case 'mission': return { type: 'mission', target: e.missionId, detail: e.state };
    case 'review': return { type: 'review', target: e.taskId, detail: `${e.approve ? 'approved' : 'escalated'}: ${e.rationale}` };
    // An autopilot decision on an agent prompt/question — the human-readable payload is JSON so the
    // task detail can render question + verdict + rationale + confidence (read back via try/catch).
    case 'decision': return { type: 'decision', target: e.taskId, detail: JSON.stringify({ kind: e.kind, question: e.question, outcome: e.outcome, rationale: e.rationale, confidence: e.confidence, optionLabel: e.optionLabel }) };
    // A worker↔autopilot conversation turn — role + text as JSON so the task detail renders chat bubbles.
    case 'message': return { type: 'message', target: e.taskId, detail: JSON.stringify({ role: e.role, text: e.text }) };
    case 'signal': return { type: 'signal', target: e.session, detail: e.signal.type };
    case 'change': return null; // transient live-refresh ping (git is its own source of truth) — not persisted
    case 'ask': return null; // transient pending-ask nudge for the Escalations inbox — not persisted
    case 'plan': return null; // transient job-status ping — not part of the persistent timeline
    // transient "your memory counters moved" nudge — memory_events is the durable record for memories
    case 'memory': return null;
    // A plugin event lands in the timeline as `plugin:<name>` so the feed can filter per plugin; the
    // payload is the plugin's own JSON (rendered by its UI, opaque to the core).
    case 'plugin': return { type: `plugin:${e.plugin}`, target: e.kind, detail: JSON.stringify(e.data ?? null) };
  }
}

export class EventStore {
  constructor(private db: Db) {}
  record(e: ElowenEvent, projectId?: number | null): void {
    const r = toRow(e);
    if (!r) return;
    // Stamp the event with its owning project so the timeline can scope it to the right repo. The bus
    // subscriber resolves the project for EVERY event type (mission/signal included) and passes it in;
    // a direct caller that omits it falls back to the task/review lookup (other types stay null).
    const taskId = e.type === 'task' || e.type === 'review' || e.type === 'decision' || e.type === 'message' ? e.taskId : null;
    let pid = projectId;
    if (pid === undefined) {
      pid = taskId
        ? (this.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: number } | undefined)?.project_id ?? null
        : null;
    }
    // Snapshot a human label now so the event still reads as a name after its task/epic is deleted
    // (events outlive tasks). Resolve the title for task/review (the target id) and mission (the epic
    // id inside m-<epicId>); signal/plan keep the agent/job name the target already carries.
    const titleId = taskId ?? (e.type === 'mission' && e.missionId.startsWith('m-') ? e.missionId.slice(2) : null);
    const label = titleId
      ? (this.db.prepare('SELECT title FROM tasks WHERE id = ?').get(titleId) as { title: string } | undefined)?.title ?? ''
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
