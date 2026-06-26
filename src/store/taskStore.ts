import type { Db } from './db.js';
import type { Task, CreateTaskInput, TaskStatus } from './types.js';
import type { CommitFileChange } from '../integrations/projectFiles.js';
import { deleteTasksAndDeps } from './cascade.js';

type Row = Omit<Task, 'labels' | 'changed_files'> & { labels: string; changed_files: string | null };

/** Parse the stored `changed_files` JSON blob into the typed change list. Always in try/catch — the
 *  column is plain text and a malformed/legacy value must degrade to an empty list, never throw. */
function parseChangedFiles(raw: string | null): CommitFileChange[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    // Validate element shape — a malformed-but-array value (e.g. a hand-edited DB row) must not flow
    // through as a CommitFileChange and render as `+undefined` in the UI. Keep only well-formed entries.
    return v.filter((e): e is CommitFileChange =>
      e && typeof e.path === 'string' && typeof e.added === 'number' && typeof e.deleted === 'number');
  } catch { return []; }
}

const toTask = (r: Row): Task => ({ ...r, labels: r.labels ? r.labels.split(',').filter(Boolean) : [], changed_files: parseChangedFiles(r.changed_files) });

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

  /** Close a task, stamping the agent-reported result summary, outcome and completion time. A clean
   *  ('ok') close also clears any pending resume note: the new input (review-reject/stuck/manual) has
   *  been addressed, so it must not linger to mislead a later manual restart or show on the closed
   *  task. A 'fail'/null close keeps it — the task may be re-spawned or escalated and still needs it. */
  close(id: string, opts?: { summary?: string | null; outcome?: string | null }): void {
    this.db.prepare(
      `UPDATE tasks SET status = 'closed', result_summary = @summary, outcome = @outcome,
         closed_at = datetime('now'),
         resume_note = CASE WHEN @outcome = 'ok' THEN NULL ELSE resume_note END
       WHERE id = @id`
    ).run({ id, summary: opts?.summary ?? null, outcome: opts?.outcome ?? null });
  }

  update(id: string, patch: { title?: string; type?: string; priority?: string; description?: string; scheduled_at?: string | null; autostart?: number }): Task | null {
    const sets: string[] = []; const p: Record<string, unknown> = { id };
    if (typeof patch.title === 'string') { sets.push('title = @title'); p.title = patch.title; }
    if (typeof patch.type === 'string') { sets.push('type = @type'); p.type = patch.type; }
    if (typeof patch.priority === 'string') { sets.push('priority = @priority'); p.priority = patch.priority; }
    if (typeof patch.description === 'string') { sets.push('description = @description'); p.description = patch.description; }
    // Last line of defence: only a string or explicit null may reach the column (callers pass
    // request JSON, which TS can't constrain at runtime). A bad type is dropped, not persisted.
    if (typeof patch.scheduled_at === 'string' || patch.scheduled_at === null) {
      sets.push('scheduled_at = @scheduled_at'); p.scheduled_at = patch.scheduled_at;
    }
    if (patch.autostart !== undefined) { sets.push('autostart = @autostart'); p.autostart = patch.autostart ? 1 : 0; }
    if (sets.length > 0) this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(p);
    return this.get(id);
  }

  delete(id: string): void {
    // Always remove the whole subtree: deleting a parent (epic) must never leave its children
    // (phases) orphaned. deleteEpic covers the leaf case too — a task with no descendants just
    // removes its own row, its dep edges and any mission it drove. Single source of truth for
    // delete semantics, so a plain DELETE /tasks/:id can't strand rows.
    this.deleteEpic(id);
  }

  /** Delete an epic and its whole subtree in one go: the epic, every descendant task, all their
   *  dependency edges, and any mission those tasks drove. Used to remove a mission outright (not just
   *  disengage it). Returns how many task rows were removed. */
  deleteEpic(epicId: string): { tasks: number } {
    return this.db.transaction(() => ({ tasks: deleteTasksAndDeps(this.db, 'epic', epicId) }))();
  }

  /** Wipe ALL tasks, their dependency edges and every mission — the operational data reset used by
   *  the admin cleanup. Projects/users/config are untouched. Returns the row counts removed. */
  deleteAll(): { tasks: number; missions: number } {
    return this.db.transaction(() => {
      const missions = (this.db.prepare('SELECT COUNT(*) c FROM missions').get() as { c: number }).c;
      this.db.prepare('DELETE FROM task_deps').run();
      this.db.prepare('DELETE FROM missions').run();
      const r = this.db.prepare('DELETE FROM tasks').run();
      return { tasks: r.changes, missions };
    })();
  }
  addDep(taskId: string, dependsOnId: string): void {
    if (!dependsOnId || dependsOnId === taskId) return; // no self-reference
    if (this.wouldCycle(taskId, dependsOnId)) return; // adding dep would create a cycle
    this.db.prepare('INSERT OR IGNORE INTO task_deps (task_id, depends_on_id) VALUES (?, ?)').run(taskId, dependsOnId);
  }

  /** Replace this task's dependencies with the given set. Self-references are dropped and any edge
   *  that would introduce a cycle (incl. mutual deps within the incoming set) is rejected. */
  setDeps(taskId: string, dependsOnIds: string[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM task_deps WHERE task_id = ?').run(taskId);
      const stmt = this.db.prepare('INSERT OR IGNORE INTO task_deps (task_id, depends_on_id) VALUES (?, ?)');
      for (const dep of dependsOnIds) {
        if (!dep || dep === taskId) continue;
        if (this.wouldCycle(taskId, dep)) continue;
        stmt.run(taskId, dep);
      }
    })();
  }

  /** True if adding edge task→dependsOn would create a cycle: i.e. dependsOn already (transitively)
   *  depends on task. Walks the existing task_deps graph from dependsOn looking for taskId. */
  private wouldCycle(taskId: string, dependsOnId: string): boolean {
    const edges = this.db.prepare('SELECT task_id, depends_on_id FROM task_deps').all() as { task_id: string; depends_on_id: string }[];
    const adj = new Map<string, string[]>();
    for (const e of edges) (adj.get(e.task_id) ?? adj.set(e.task_id, []).get(e.task_id)!).push(e.depends_on_id);
    const seen = new Set<string>();
    const stack = [dependsOnId];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === taskId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of adj.get(cur) ?? []) stack.push(next);
    }
    return false;
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

  /** Add a free-form label (idempotent — never duplicates). Used for ad-hoc markers such as the
   *  review gate's `gatedby:<phaseId>`, which records exactly which phase's review holds a dependent
   *  blocked so an approval releases only its own gate. */
  addLabel(id: string, label: string): void {
    const t = this.get(id);
    if (!t || t.labels.includes(label)) return;
    this.db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run([...t.labels, label].join(','), id);
  }

  /** Remove a label if present. Pair of `addLabel`. */
  removeLabel(id: string, label: string): void {
    const t = this.get(id);
    if (!t || !t.labels.includes(label)) return;
    this.db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(t.labels.filter((l) => l !== label).join(','), id);
  }

  /** Record the CLI session the agent ran under, as a `resume:<program>:<sessionId>` label, so a
   *  later re-spawn of this task can `--resume` that session (full context) instead of cold-starting.
   *  Written at close by the usage recorder; idempotent per close (re-stamping refreshes the id).
   *  The session id is validated to `[\w-]+` — it flows into the CSV-joined labels column and later a
   *  shell command, so anything with a comma or shell metacharacter is rejected, never stored. */
  setResumeLabel(id: string, program: string, sessionId: string): void {
    const t = this.get(id);
    if (!t) return;
    const labels = t.labels.filter((l) => !l.startsWith('resume:'));
    if (program && sessionId && /^[\w-]+$/.test(program) && /^[\w-]+$/.test(sessionId)) {
      labels.push(`resume:${program}:${sessionId}`);
    }
    this.db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(labels.join(','), id);
  }

  /** Pin the "resume note" — the new input a re-spawned agent should address (review feedback, a
   *  stuck/manual relaunch reason). Stored as its own column, so setting it always REPLACES the
   *  previous note (no stacking) and reading it needs no parsing. A blank note clears the field. On
   *  re-spawn the note is rendered as a dedicated block in the worker prompt. */
  setResumeNote(id: string, note: string): void {
    this.db.prepare('UPDATE tasks SET resume_note = ? WHERE id = ?').run(note.trim() || null, id);
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

  /** Record the project's git HEAD at the moment the agent spawned, as a `base:<sha>` label. At close
   *  the task's frozen change list is `git diff base..HEAD` — the delta THIS task committed. Idempotent
   *  per spawn; re-stamping (a relaunch) refreshes the baseline to the current HEAD. */
  markBase(id: string, sha: string): void {
    const t = this.get(id);
    if (!t || !/^[0-9a-f]{4,40}$/i.test(sha)) return;
    const labels = t.labels.filter((l) => !l.startsWith('base:'));
    labels.push(`base:${sha}`);
    this.db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(labels.join(','), id);
  }

  /** Persist the frozen per-task change list (JSON `CommitFileChange[]`) plus the base/head SHAs the
   *  diff was taken between, so the detail pane can lazily regenerate a single file's diff. Written once
   *  at close by the snapshot service. */
  saveChangedFiles(id: string, files: CommitFileChange[], base: string, head: string): void {
    this.db.prepare('UPDATE tasks SET changed_files = @files, base_sha = @base, head_sha = @head WHERE id = @id')
      .run({ id, files: JSON.stringify(files), base, head });
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

  /** Increment this task's review-fix counter (a `reviewfix:<n>` label) and return the new value.
   *  Bounds how many times an L3 mission auto-re-spawns a phase that the post-done review rejected
   *  before escalating to a human — the review-gate analogue of `bumpStuck`. */
  bumpReviewFix(id: string): number {
    const t = this.get(id);
    if (!t) return 0;
    const cur = Number(t.labels.find((l) => l.startsWith('reviewfix:'))?.slice('reviewfix:'.length)) || 0;
    const next = cur + 1;
    const labels = t.labels.filter((l) => !l.startsWith('reviewfix:'));
    labels.push(`reviewfix:${next}`);
    this.db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(labels.join(','), id);
    return next;
  }

  /** Clear the `reviewfix:<n>` counter on every phase of an epic. Called when a mission (re-)engages
   *  so a fresh run starts with the full self-heal budget. Without it a re-engaged mission inherits the
   *  reviewfix labels of a prior (possibly aborted or buggy) run and escalates after fewer — or zero —
   *  real retries. Only `reviewfix:` labels are touched; agent/exec/stuck labels are preserved. */
  resetReviewFix(epicId: string): void {
    const rows = this.db.prepare('SELECT id, labels FROM tasks WHERE parent_id = ?').all(epicId) as { id: string; labels: string }[];
    for (const r of rows) {
      if (!r.labels.includes('reviewfix:')) continue;
      const labels = r.labels.split(',').filter((l) => l && !l.startsWith('reviewfix:'));
      this.db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(labels.join(','), r.id);
    }
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
