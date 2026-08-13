import { tolerateMissingPluginTables, deleteTaskSubtree, missionState as readMissionState, type WorkDb } from './db.js';
import { isGitSha } from '../lib/gitSha.js';
import type { TaskStoreContract } from '../../../../src/store/taskStoreContract.js';
import type { Task, CreateTaskInput, TaskStatus } from '../../../../src/store/types.js';
import type { CommitFileChange } from '../../../../src/integrations/projectFiles.js';

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

export class TaskStore implements TaskStoreContract {
  constructor(private db: WorkDb) {}
  create(input: CreateTaskInput): Task {
    this.db.prepare(
      `INSERT INTO tasks (id, project_id, title, type, priority, parent_id, labels, description, scheduled_at, autostart, created_by)
       VALUES (@id, @project_id, @title, @type, @priority, @parent_id, @labels, @description, @scheduled_at, @autostart, @created_by)`
    ).run({
      id: input.id, project_id: input.project_id, title: input.title,
      type: input.type ?? 'task', priority: input.priority ?? 'P2',
      parent_id: input.parent_id ?? null, labels: (input.labels ?? []).join(','),
      description: input.description ?? '', scheduled_at: input.scheduled_at ?? null,
      autostart: input.autostart ? 1 : 0, created_by: input.created_by ?? null,
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

  /** State of the mission an epic drives ('active' | 'paused' | 'stalled' | 'disengaged'), or null when
   *  there is none. The delete path reads it to refuse tearing down an epic whose mission is still live
   *  — including when the agents plugin is disabled and nothing could stop that mission's agents. */
  missionState(missionId: string): string | null {
    return readMissionState(this.db, missionId);
  }

  /** Delete an epic and its whole subtree in one go: the epic, every descendant task, all their
   *  dependency edges, and any mission those tasks drove. Used to remove a mission outright (not just
   *  disengage it). Returns how many task rows were removed. */
  deleteEpic(epicId: string): { tasks: number } {
    return this.db.transaction(() => ({ tasks: deleteTaskSubtree(this.db, epicId) }))();
  }

  /** Reparent an existing top-level task under another top-level task, promoting the target to
   *  `type: 'epic'` if it isn't already one. Used by the drag-a-card-onto-another-card "make
   *  subtask" gesture. Keeps the tree exactly 2 levels deep (epic → phases): rejects either side
   *  already being a phase, and rejects a dragged task that has children of its own (no nested
   *  epics). Re-validates everything the UI already checks — defence in depth, not trusted input. */
  reparent(taskId: string, epicId: string): { task: Task } | { error: string } {
    const task = this.get(taskId);
    const target = this.get(epicId);
    if (!task) return { error: 'task not found' };
    if (!target) return { error: 'target not found' };
    if (taskId === epicId) return { error: 'cannot reparent onto itself' };
    if (task.project_id !== target.project_id) return { error: 'cross-project reparent not allowed' };
    if (task.parent_id) return { error: 'task is already a phase' };
    if (target.parent_id) return { error: 'target is already a phase' };
    if (task.status === 'closed' || task.status === 'cancelled') return { error: 'task is already finished' };
    if (task.status === 'in_progress') return { error: 'task is currently running' };
    if (this.descendants(taskId).length > 0) return { error: 'task has its own children' };
    this.db.transaction(() => {
      if (target.type !== 'epic') this.db.prepare("UPDATE tasks SET type = 'epic' WHERE id = ?").run(epicId);
      this.db.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?').run(epicId, taskId);
    })();
    return { task: this.get(taskId)! };
  }

  /** Wipe ALL tasks, their dependency edges, every mission, its PR record and every handoff note —
   *  the operational data reset used by the admin cleanup. mission_pr has no FK cascade (same as the
   *  epic-delete cascade in cascade.ts), so it must be cleared explicitly or a wiped mission leaves an
   *  orphan PR/worktree record behind; notes all target wiped tasks, so they go too.
   *  Projects/users/config are untouched. Returns the row counts removed. */
  deleteAll(): { tasks: number; missions: number } {
    return this.db.transaction(() => {
      // missions/mission_pr/notes are AGENTS-PLUGIN tables: a fresh install with the plugin disabled
      // never created them — tolerate that shape, but always wipe them when present (cleanup must not
      // depend on the plugin being on, or orphan rows resurface on re-enable).
      const missions = tolerateMissingPluginTables(
        () => (this.db.prepare('SELECT COUNT(*) c FROM missions').get() as { c: number }).c, 0);
      this.db.prepare('DELETE FROM task_deps').run();
      tolerateMissingPluginTables(() => {
        this.db.prepare('DELETE FROM mission_pr').run();
        this.db.prepare('DELETE FROM missions').run();
      }, undefined);
      tolerateMissingPluginTables(() => { this.db.prepare('DELETE FROM notes').run(); }, undefined);
      const r = this.db.prepare('DELETE FROM tasks').run();
      return { tasks: r.changes, missions };
    })();
  }

  /** Every mission id currently in the `missions` table, in no particular order — used by the admin
   *  cleanup route to free each mission's on-disk worktree (missionGit.cleanup is a no-op for one with
   *  none) before deleteAll() wipes the row, so a paused or naturally-completed mission — which the
   *  live-only disengage sweep never reaches — doesn't leak its worktree. */
  listMissionIds(): string[] {
    return tolerateMissingPluginTables(
      () => (this.db.prepare('SELECT id FROM missions').all() as { id: string }[]).map((r) => r.id), []);
  }

  /** Run a sequence of this store's own writes as ONE atomic transaction. Not a generic repository or
   *  unit-of-work layer — it exists so a caller that composes several of THIS store's own calls (e.g.
   *  plan persistence: create the epic, create every phase, wire every dependency edge) can make the
   *  whole sequence atomic without reaching into a raw `Db` handle it was never given. Rolls back
   *  everything written inside `fn` if it throws. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Add a dependency edge task→dependsOn. Refuses (returns false, no write) a self-reference, an edge
   *  that would create a cycle, a dangling endpoint (either id doesn't exist) or a cross-project edge —
   *  readiness resolves a dep's status by joining through `tasks`, so a missing task would otherwise
   *  read as vacuously satisfied (letting the dependent start early on a typo) and a foreign project's
   *  task would drive this one's scheduling and leak its status across the tenancy boundary. Returns
   *  true once the edge exists (freshly added, or already present). */
  addDep(taskId: string, dependsOnId: string): boolean {
    if (!dependsOnId || dependsOnId === taskId) return false; // no self-reference
    const task = this.get(taskId);
    const dependsOn = this.get(dependsOnId);
    if (!task || !dependsOn || task.project_id !== dependsOn.project_id) return false;
    if (this.wouldCycle(taskId, dependsOnId)) return false; // adding dep would create a cycle
    this.db.prepare('INSERT OR IGNORE INTO task_deps (task_id, depends_on_id) VALUES (?, ?)').run(taskId, dependsOnId);
    return true;
  }

  /** Replace this task's dependencies with the given set. Self-references, cycle-forming edges (incl.
   *  mutual deps within the incoming set), a dangling id (no such task) and a cross-project id are all
   *  silently dropped — the same "best effort" contract this bulk replace already had for self/cycle
   *  now also closes the dangling/cross-project gap addDep rejects (see its doc comment for why). */
  setDeps(taskId: string, dependsOnIds: string[]): void {
    const task = this.get(taskId);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM task_deps WHERE task_id = ?').run(taskId);
      if (!task) return; // taskId itself doesn't exist — nothing valid to wire
      const stmt = this.db.prepare('INSERT OR IGNORE INTO task_deps (task_id, depends_on_id) VALUES (?, ?)');
      for (const dep of dependsOnIds) {
        if (!dep || dep === taskId) continue;
        const dependsOn = this.get(dep);
        if (!dependsOn || dependsOn.project_id !== task.project_id) continue;
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

  /** Direct children of a task, oldest first. Unlike descendants() this is a flat, non-recursive
   *  query — use it when you only need the immediate level (e.g. an epic's phases). */
  children(parentId: string): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at').all(parentId) as Row[];
    return rows.map(toTask);
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
    if (!t || !isGitSha(sha)) return;
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

  /** Increment this task's idle-nudge counter (a `nudge:<n>` label) and return the new value. Bounds how
   *  many times the liveness sweep pokes a live-but-stuck worker before escalating it to a human — the
   *  live-agent analogue of `bumpStuck` (which counts dead-agent relaunches). */
  bumpNudge(id: string): number {
    const t = this.get(id);
    if (!t) return 0;
    const cur = Number(t.labels.find((l) => l.startsWith('nudge:'))?.slice('nudge:'.length)) || 0;
    const next = cur + 1;
    const labels = t.labels.filter((l) => !l.startsWith('nudge:'));
    labels.push(`nudge:${next}`);
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
    const rows = this.db.prepare('SELECT id, labels FROM tasks WHERE parent_id = ? AND labels LIKE ?')
      .all(epicId, '%reviewfix:%') as { id: string; labels: string }[];
    if (rows.length === 0) return;
    // One prepared statement, one transaction: a re-engage can touch many phases at once, and N
    // implicit single-row commits would be N fsyncs. Each row still gets its own filtered label set
    // (the labels differ per task), so this batches the writes without changing the per-row result.
    const upd = this.db.prepare('UPDATE tasks SET labels = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const r of rows) {
        const labels = r.labels.split(',').filter((l) => l && !l.startsWith('reviewfix:'));
        upd.run(labels.join(','), r.id);
      }
    })();
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
