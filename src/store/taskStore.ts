import type { Db } from './db.js';
import type { Task, CreateTaskInput, TaskStatus } from './types.js';

type Row = Omit<Task, 'labels'> & { labels: string };
const toTask = (r: Row): Task => ({ ...r, labels: r.labels ? r.labels.split(',').filter(Boolean) : [] });

export class TaskStore {
  constructor(private db: Db) {}
  create(input: CreateTaskInput): Task {
    this.db.prepare(
      `INSERT INTO tasks (id, project_id, title, type, priority, parent_id, labels, description, scheduled_at, autostart)
       VALUES (@id, @project_id, @title, @type, @priority, @parent_id, @labels, @description, @scheduled_at, @autostart)`
    ).run({
      id: input.id, project_id: input.project_id, title: input.title,
      type: input.type ?? 'task', priority: input.priority ?? 'P2',
      parent_id: input.parent_id ?? null, labels: (input.labels ?? []).join(','),
      description: input.description ?? '', scheduled_at: input.scheduled_at ?? null,
      autostart: input.autostart ? 1 : 0,
    });
    return this.get(input.id)!;
  }
  get(id: string): Task | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? toTask(r) : null;
  }
  list(filter?: { status?: TaskStatus; project_id?: number }): Task[] {
    const where: string[] = []; const p: Record<string, unknown> = {};
    if (filter?.status) { where.push('status = @status'); p.status = filter.status; }
    if (filter?.project_id) { where.push('project_id = @project_id'); p.project_id = filter.project_id; }
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at`;
    return (this.db.prepare(sql).all(p) as Row[]).map(toTask);
  }
  setStatus(id: string, status: TaskStatus): void {
    this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
  }

  /** Close a task, stamping the agent-reported result summary, outcome and completion time. */
  close(id: string, opts?: { summary?: string | null; outcome?: string | null }): void {
    this.db.prepare(
      `UPDATE tasks SET status = 'closed', result_summary = @summary, outcome = @outcome, closed_at = datetime('now') WHERE id = @id`
    ).run({ id, summary: opts?.summary ?? null, outcome: opts?.outcome ?? null });
  }

  update(id: string, patch: { title?: string; type?: string; priority?: string; description?: string; scheduled_at?: string | null; autostart?: number }): Task | null {
    const sets: string[] = []; const p: Record<string, unknown> = { id };
    if (typeof patch.title === 'string') { sets.push('title = @title'); p.title = patch.title; }
    if (typeof patch.type === 'string') { sets.push('type = @type'); p.type = patch.type; }
    if (typeof patch.priority === 'string') { sets.push('priority = @priority'); p.priority = patch.priority; }
    if (typeof patch.description === 'string') { sets.push('description = @description'); p.description = patch.description; }
    if (patch.scheduled_at !== undefined) { sets.push('scheduled_at = @scheduled_at'); p.scheduled_at = patch.scheduled_at; }
    if (patch.autostart !== undefined) { sets.push('autostart = @autostart'); p.autostart = patch.autostart ? 1 : 0; }
    if (sets.length > 0) this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(p);
    return this.get(id);
  }

  delete(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM task_deps WHERE task_id = ? OR depends_on_id = ?').run(id, id);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    })();
  }
  addDep(taskId: string, dependsOnId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO task_deps (task_id, depends_on_id) VALUES (?, ?)').run(taskId, dependsOnId);
  }

  /** Replace this task's dependencies with the given set (self-references ignored). */
  setDeps(taskId: string, dependsOnIds: string[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM task_deps WHERE task_id = ?').run(taskId);
      const stmt = this.db.prepare('INSERT OR IGNORE INTO task_deps (task_id, depends_on_id) VALUES (?, ?)');
      for (const dep of dependsOnIds) if (dep && dep !== taskId) stmt.run(taskId, dep);
    })();
  }

  depsFor(taskId: string): string[] {
    return (this.db.prepare('SELECT depends_on_id FROM task_deps WHERE task_id = ?').all(taskId) as { depends_on_id: string }[]).map((r) => r.depends_on_id);
  }

  allDeps(): { task_id: string; depends_on_id: string }[] {
    return this.db.prepare('SELECT task_id, depends_on_id FROM task_deps').all() as { task_id: string; depends_on_id: string }[];
  }

  descendants(rootId: string): Task[] {
    const rows = this.db.prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM tasks WHERE parent_id = @root
         UNION
         SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id
       )
       SELECT t.* FROM tasks t JOIN sub ON t.id = sub.id ORDER BY t.created_at`
    ).all({ root: rootId }) as Row[];
    return rows.map(toTask);
  }

  setExec(id: string, exec: string): void {
    const t = this.get(id);
    if (!t) return;
    const labels = t.labels.filter((l) => !l.startsWith('exec:'));
    if (exec) labels.push(`exec:${exec}`);
    this.db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(labels.join(','), id);
  }

  /** Tag the task with the agent (tmux session) running it, so task ↔ session is linkable. */
  setAgent(id: string, name: string): void {
    const t = this.get(id);
    if (!t) return;
    const labels = t.labels.filter((l) => !l.startsWith('agent:'));
    if (name) labels.push(`agent:${name}`);
    this.db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(labels.join(','), id);
  }

  /** Stamp the precise spawn time (epoch ms) the agent launched, as a `started:<ms>` label.
   *  Sub-second precision is what lets concurrent agents in one project be ordered by who
   *  actually started first (created_at is whole-second and set at row insert, not spawn). */
  markStarted(id: string, ms: number): void {
    const t = this.get(id);
    if (!t) return;
    const labels = t.labels.filter((l) => !l.startsWith('started:'));
    labels.push(`started:${ms}`);
    this.db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(labels.join(','), id);
  }

  /** Increment this task's relaunch counter (a `stuck:<n>` label) and return the new value.
   *  Used by the stuck detector to bound how many times a dead agent is re-spawned before
   *  the task is escalated to a human. */
  bumpStuck(id: string): number {
    const t = this.get(id);
    if (!t) return 0;
    const cur = Number(t.labels.find((l) => l.startsWith('stuck:'))?.slice('stuck:'.length)) || 0;
    const next = cur + 1;
    const labels = t.labels.filter((l) => !l.startsWith('stuck:'));
    labels.push(`stuck:${next}`);
    this.db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(labels.join(','), id);
    return next;
  }

  depsAmong(ids: string[]): { task_id: string; depends_on_id: string }[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT task_id, depends_on_id FROM task_deps
       WHERE task_id IN (${placeholders}) AND depends_on_id IN (${placeholders})`
    ).all(...ids, ...ids) as { task_id: string; depends_on_id: string }[];
  }
}
