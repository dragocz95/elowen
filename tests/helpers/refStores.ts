import { tolerateMissingPluginTables, type Db } from '../../src/store/db.js';
import { isGitSha } from '../../src/shared/gitSha.js';
import type { ReadinessContract, TaskStoreContract, TaskUsageContract } from '../../src/store/taskStoreContract.js';
import type { AgentsMissions } from '../../src/plugins/api.js';
import type { Mission, MissionState } from '../../src/shared/agentEvents.js';
import type { Task, CreateTaskInput, TaskStatus } from '../../src/store/types.js';
import type { CommitFileChange } from '../../src/integrations/projectFiles.js';
import type { CostSource, TokenUsage } from '../../src/integrations/usage/types.js';

/** REFERENCE IMPLEMENTATIONS of the domain contracts the daemon consumes but no longer owns.
 *
 *  `tasks`, `readiness`, `taskUsage` and `missions` are declared in src/api/deps.ts as CONTRACTS
 *  (TaskStoreContract, ReadinessContract, TaskUsageContract, AgentsMissions) precisely so the daemon
 *  never depends on who implements them. In production the `work` and `agents` plugins do, installed
 *  from the plugin registry. The daemon's own suite needs an implementation it OWNS: importing the
 *  plugins' classes would make the core suite unrunnable in a checkout that does not contain them, and
 *  a bare stub that only satisfies the type would let every tenancy/teardown test pass vacuously.
 *
 *  So these are real stores, backed by the frozen DDL in tests/fixtures/pluginSchema.ts — the same table
 *  shape a standard install has. Behaviour a daemon test OBSERVES is implemented for real: label
 *  vocabulary (agent:/exec:/base:/started:/stuck:/nudge:/reviewfix:/resume:), the dependency graph with
 *  its cycle/dangling/cross-project guards, subtree deletion with its mission/note cascade, and the
 *  readiness rule that a dangling edge blocks forever rather than reading as satisfied.
 *
 *  WHAT THIS IS NOT. Not a port of the plugins and not a second source of truth for them: the plugins'
 *  own suites live in the registry and test the real classes. This is the daemon's yardstick for "a task
 *  domain is present and behaves", nothing more. Where the contract allows latitude the simplest honest
 *  behaviour is chosen — and anything a daemon suite does not observe is implemented plainly rather than
 *  reproduced clause for clause. */

type TaskRow = Omit<Task, 'labels' | 'changed_files'> & { labels: string; changed_files: string | null };

/** The stored change list, degrading to [] on anything malformed — the column is plain text and a
 *  hand-edited or legacy value must never throw into a route. */
function parseChangedFiles(raw: string | null): CommitFileChange[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((e): e is CommitFileChange =>
      !!e && typeof (e as CommitFileChange).path === 'string'
      && typeof (e as CommitFileChange).added === 'number'
      && typeof (e as CommitFileChange).deleted === 'number');
  } catch { return []; }
}

const toTask = (r: TaskRow): Task => ({
  ...r,
  labels: r.labels ? r.labels.split(',').filter(Boolean) : [],
  changed_files: parseChangedFiles(r.changed_files),
});

/** A task is ready when it is open, not an epic, and every dependency edge points at a task that both
 *  EXISTS and is finished. The inner NOT EXISTS is what makes a dangling edge block forever instead of
 *  reading as vacuously satisfied — a join would silently drop it. */
const READY_DEPS_CLEAR = `NOT EXISTS (
  SELECT 1 FROM task_deps d
  WHERE d.task_id = t.id
    AND NOT EXISTS (SELECT 1 FROM tasks dt WHERE dt.id = d.depends_on_id AND dt.status IN ('closed', 'cancelled'))
)`;

export class RefTaskStore implements TaskStoreContract {
  constructor(private db: Db) {}

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
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return r ? toTask(r) : null;
  }

  list(filter?: { status?: TaskStatus; project_id?: number }): Task[] {
    const where: string[] = []; const p: Record<string, unknown> = {};
    if (filter?.status) { where.push('status = @status'); p.status = filter.status; }
    if (filter?.project_id) { where.push('project_id = @project_id'); p.project_id = filter.project_id; }
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at`;
    return (this.db.prepare(sql).all(p) as TaskRow[]).map(toTask);
  }

  setStatus(id: string, status: TaskStatus): void {
    this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
  }

  /** A clean ('ok') close clears any pending resume note — the input it carried has been addressed, so
   *  it must not linger into a later manual restart. A failed close keeps it. */
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
    // Only a string or an explicit null may reach the column: callers pass request JSON, which the
    // type system cannot constrain at runtime.
    if (typeof patch.scheduled_at === 'string' || patch.scheduled_at === null) {
      sets.push('scheduled_at = @scheduled_at'); p.scheduled_at = patch.scheduled_at;
    }
    if (patch.autostart !== undefined) { sets.push('autostart = @autostart'); p.autostart = patch.autostart ? 1 : 0; }
    if (sets.length > 0) this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(p);
    return this.get(id);
  }

  /** Deleting a task always removes its whole subtree — a parent that left its phases behind would
   *  strand rows no route can reach. deleteEpic covers the leaf case too. */
  delete(id: string): void { this.deleteEpic(id); }

  /** State of the mission an epic drives, or null. Read straight from the row: the guard that needs it
   *  (refusing to delete an epic whose mission is live) has to hold precisely when the agents plugin is
   *  absent, and the rows outlive the plugin. */
  missionState(missionId: string): string | null {
    return tolerateMissingPluginTables(() => {
      const row = this.db.prepare('SELECT state FROM missions WHERE id = ?').get(missionId) as { state: string } | undefined;
      return row?.state ?? null;
    }, null);
  }

  /** The epic, every descendant, their dependency edges, and the missions / PR records / notes those
   *  tasks drove — in FK-safe order. The agents tables are reached tolerantly: a database without that
   *  plugin's DDL simply has nothing to purge there. */
  deleteEpic(epicId: string): { tasks: number } {
    return this.db.transaction(() => {
      const ids = [epicId, ...(this.db.prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM tasks WHERE parent_id = @root
           UNION
           SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id
         )
         SELECT id FROM sub`
      ).all({ root: epicId }) as { id: string }[]).map((r) => r.id)];
      const ph = ids.map(() => '?').join(',');
      // mission_pr FIRST, while `missions` still maps epic → mission id: there is no FK cascade, so the
      // other order strands a PR row pointing at a worktree whose mission is gone.
      tolerateMissingPluginTables(() => {
        this.db.prepare(`DELETE FROM mission_pr WHERE mission_id IN (SELECT id FROM missions WHERE epic_id IN (${ph}))`).run(...ids);
        this.db.prepare(`DELETE FROM missions WHERE epic_id IN (${ph})`).run(...ids);
      }, undefined);
      tolerateMissingPluginTables(() => { this.db.prepare(`DELETE FROM notes WHERE target IN (${ph})`).run(...ids); }, undefined);
      this.db.prepare(`DELETE FROM task_deps WHERE task_id IN (${ph}) OR depends_on_id IN (${ph})`).run(...ids, ...ids);
      return { tasks: this.db.prepare(`DELETE FROM tasks WHERE id IN (${ph})`).run(...ids).changes };
    })();
  }

  /** Promote a top-level task to a phase of another. Keeps the tree exactly two levels deep and
   *  re-validates everything the UI already checks — the checks are the behaviour, not the UI's. */
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

  /** The operational-data reset behind the admin cleanup: tasks, edges, missions, PR records, notes.
   *  Projects, users and config are untouched. */
  deleteAll(): { tasks: number; missions: number } {
    return this.db.transaction(() => {
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

  listMissionIds(): string[] {
    return tolerateMissingPluginTables(
      () => (this.db.prepare('SELECT id FROM missions').all() as { id: string }[]).map((r) => r.id), []);
  }

  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }

  /** Refuses a self-reference, a cycle, a dangling endpoint and a cross-project edge. Readiness resolves
   *  a dependency by looking the task up, so a dangling edge would let the dependent start on a typo and
   *  a foreign project's task would drive this one's scheduling across the tenancy boundary. */
  addDep(taskId: string, dependsOnId: string): boolean {
    if (!dependsOnId || dependsOnId === taskId) return false;
    const task = this.get(taskId);
    const dependsOn = this.get(dependsOnId);
    if (!task || !dependsOn || task.project_id !== dependsOn.project_id) return false;
    if (this.wouldCycle(taskId, dependsOnId)) return false;
    this.db.prepare('INSERT OR IGNORE INTO task_deps (task_id, depends_on_id) VALUES (?, ?)').run(taskId, dependsOnId);
    return true;
  }

  /** Bulk replace, best effort: every edge addDep would refuse is dropped rather than failing the set. */
  setDeps(taskId: string, dependsOnIds: string[]): void {
    const task = this.get(taskId);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM task_deps WHERE task_id = ?').run(taskId);
      if (!task) return;
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

  /** True when `dependsOnId` already (transitively) depends on `taskId`. */
  private wouldCycle(taskId: string, dependsOnId: string): boolean {
    const edges = this.db.prepare('SELECT task_id, depends_on_id FROM task_deps').all() as { task_id: string; depends_on_id: string }[];
    const adj = new Map<string, string[]>();
    for (const e of edges) {
      const list = adj.get(e.task_id);
      if (list) list.push(e.depends_on_id); else adj.set(e.task_id, [e.depends_on_id]);
    }
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

  depsAmong(ids: string[]): { task_id: string; depends_on_id: string }[] {
    if (ids.length === 0) return [];
    const ph = ids.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT task_id, depends_on_id FROM task_deps
       WHERE task_id IN (${ph}) AND depends_on_id IN (${ph})`
    ).all(...ids, ...ids) as { task_id: string; depends_on_id: string }[];
  }

  children(parentId: string): Task[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at').all(parentId) as TaskRow[]).map(toTask);
  }

  descendants(rootId: string): Task[] {
    return (this.db.prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM tasks WHERE parent_id = @root
         UNION
         SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id
       )
       SELECT t.* FROM tasks t JOIN sub ON t.id = sub.id ORDER BY t.created_at`
    ).all({ root: rootId }) as TaskRow[]).map(toTask);
  }

  /** Replace the single label carrying `prefix:` with `prefix:value`, or drop it when the value is
   *  empty. The whole label vocabulary (agent/exec/base/started/stuck/nudge/reviewfix/resume) is
   *  single-valued and lives in one comma-joined column, so every setter is this operation. */
  private setPrefixed(id: string, prefix: string, value: string): void {
    const t = this.get(id);
    if (!t) return;
    const labels = t.labels.filter((l) => !l.startsWith(`${prefix}:`));
    if (value) labels.push(`${prefix}:${value}`);
    this.db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(labels.join(','), id);
  }

  /** Increment the counter carried by `prefix:<n>` and return the new value. */
  private bump(id: string, prefix: string): number {
    const t = this.get(id);
    if (!t) return 0;
    const next = (Number(t.labels.find((l) => l.startsWith(`${prefix}:`))?.slice(prefix.length + 1)) || 0) + 1;
    this.setPrefixed(id, prefix, String(next));
    return next;
  }

  setExec(id: string, exec: string): void { this.setPrefixed(id, 'exec', exec); }
  setAgent(id: string, name: string): void { this.setPrefixed(id, 'agent', name); }
  markStarted(id: string, ms: number): void { this.setPrefixed(id, 'started', String(ms)); }

  /** Only a plain hex object name is stamped: the value flows into a CSV label column and from there
   *  into a git command line, where anything else could be read as a flag or a pathspec. */
  markBase(id: string, sha: string): void {
    if (!isGitSha(sha)) return;
    this.setPrefixed(id, 'base', sha);
  }

  /** `resume:<program>:<sessionId>` — both halves are validated to `[\w-]+` for the same reason
   *  markBase validates its SHA: the label column is CSV-joined and reaches a shell command. */
  setResumeLabel(id: string, program: string, sessionId: string): void {
    const ok = program && sessionId && /^[\w-]+$/.test(program) && /^[\w-]+$/.test(sessionId);
    this.setPrefixed(id, 'resume', ok ? `${program}:${sessionId}` : '');
  }

  addLabel(id: string, label: string): void {
    const t = this.get(id);
    if (!t || t.labels.includes(label)) return;
    this.db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run([...t.labels, label].join(','), id);
  }

  removeLabel(id: string, label: string): void {
    const t = this.get(id);
    if (!t || !t.labels.includes(label)) return;
    this.db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(t.labels.filter((l) => l !== label).join(','), id);
  }

  /** Own column, not a label: setting it always REPLACES the previous note, and a blank clears it. */
  setResumeNote(id: string, note: string): void {
    this.db.prepare('UPDATE tasks SET resume_note = ? WHERE id = ?').run(note.trim() || null, id);
  }

  saveChangedFiles(id: string, files: CommitFileChange[], base: string, head: string): void {
    this.db.prepare('UPDATE tasks SET changed_files = @files, base_sha = @base, head_sha = @head WHERE id = @id')
      .run({ id, files: JSON.stringify(files), base, head });
  }

  bumpStuck(id: string): number { return this.bump(id, 'stuck'); }
  bumpNudge(id: string): number { return this.bump(id, 'nudge'); }
  bumpReviewFix(id: string): number { return this.bump(id, 'reviewfix'); }

  /** Clear the self-heal counter across an epic's phases so a re-engaged mission starts with its full
   *  budget. Only `reviewfix:` is touched — agent/exec/stuck labels survive. */
  resetReviewFix(epicId: string): void {
    for (const child of this.children(epicId)) {
      if (child.labels.some((l) => l.startsWith('reviewfix:'))) this.setPrefixed(child.id, 'reviewfix', '');
    }
  }
}

export class RefReadiness implements ReadinessContract {
  constructor(private db: Db) {}

  ready(projectId: number): Task[] {
    return (this.db.prepare(
      `SELECT t.* FROM tasks t
       WHERE t.project_id = ? AND t.status = 'open' AND t.type != 'epic' AND ${READY_DEPS_CLEAR}
       ORDER BY t.created_at`
    ).all(projectId) as TaskRow[]).map(toTask);
  }

  readyForEpic(epicId: string): Task[] {
    return (this.db.prepare(
      `SELECT t.* FROM tasks t
       WHERE t.parent_id = ? AND t.status = 'open' AND t.type != 'epic' AND ${READY_DEPS_CLEAR}
       ORDER BY t.created_at`
    ).all(epicId) as TaskRow[]).map(toTask);
  }
}

interface UsageRow {
  exec: string;
  input: number; output: number; cache_read: number; cache_write: number; total: number;
  reasoning: number; cost_usd: number | null; currency: string | null; cost_source: CostSource | null;
  raw_usage_metadata?: string | null;
}

/** A legacy row has no cost_source: a present cost is at best 'calculated' (nothing proves the provider
 *  reported it), an absent one is 'unavailable'. */
function toUsage(r: UsageRow): TokenUsage {
  const usage: TokenUsage = {
    input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write,
    total: r.total, reasoning: r.reasoning ?? 0, costUsd: r.cost_usd, currency: r.currency ?? null,
    costSource: r.cost_source ?? (r.cost_usd != null ? 'calculated' : 'unavailable'),
  };
  if (r.raw_usage_metadata) {
    try { usage.rawUsageMetadata = JSON.parse(r.raw_usage_metadata) as Record<string, unknown>; } catch { /* corrupt blob */ }
  }
  return usage;
}

export class RefTaskUsage implements TaskUsageContract {
  constructor(private db: Db) {}

  /** Keyed on task_id, so a re-snapshot of the same task replaces in place instead of doubling. */
  record(taskId: string, projectId: number, exec: string, usage: TokenUsage): void {
    this.db.prepare(
      `INSERT INTO task_usage (task_id, project_id, exec, input, output, cache_read, cache_write, total,
                               reasoning, cost_usd, currency, cost_source, raw_usage_metadata)
       VALUES (@task_id, @project_id, @exec, @input, @output, @cache_read, @cache_write, @total,
               @reasoning, @cost_usd, @currency, @cost_source, @raw_usage_metadata)
       ON CONFLICT(task_id) DO UPDATE SET
         project_id=excluded.project_id, exec=excluded.exec, input=excluded.input, output=excluded.output,
         cache_read=excluded.cache_read, cache_write=excluded.cache_write, total=excluded.total,
         reasoning=excluded.reasoning, cost_usd=excluded.cost_usd, currency=excluded.currency,
         cost_source=excluded.cost_source, raw_usage_metadata=excluded.raw_usage_metadata,
         captured_at=datetime('now')`
    ).run({
      task_id: taskId, project_id: projectId, exec,
      input: usage.input, output: usage.output, cache_read: usage.cacheRead,
      cache_write: usage.cacheWrite, total: usage.total, reasoning: usage.reasoning ?? 0,
      cost_usd: usage.costUsd ?? null, currency: usage.currency ?? null,
      cost_source: usage.costSource ?? 'unavailable',
      raw_usage_metadata: usage.rawUsageMetadata ? JSON.stringify(usage.rawUsageMetadata) : null,
    });
  }

  get(taskId: string): TokenUsage | null {
    const r = this.db.prepare('SELECT * FROM task_usage WHERE task_id = ?').get(taskId) as UsageRow | undefined;
    return r ? toUsage(r) : null;
  }

  /** A bucket's cost is null only when NO row in it carried one, so a provider that never reports cost
   *  reads as "—" instead of as zero. Provenance rolls up conservatively: any estimate in the bucket
   *  taints the whole sum to 'calculated'. */
  aggregateByExec(projectIds?: number[], window?: { fromIso?: string; toIso?: string }): { exec: string; usage: TokenUsage }[] {
    // An EMPTY accessible-project list means "no projects at all", never "every project": the caller is
    // a tenancy gate, so widening here would leak another tenant's spend.
    if (projectIds && projectIds.length === 0) return [];
    const where: string[] = []; const args: (string | number)[] = [];
    if (projectIds) { where.push(`project_id IN (${projectIds.map(() => '?').join(',')})`); args.push(...projectIds); }
    if (window?.fromIso) { where.push('captured_at >= datetime(?)'); args.push(window.fromIso); }
    if (window?.toIso) { where.push('captured_at <= datetime(?)'); args.push(window.toIso); }
    const rows = this.db.prepare(
      `SELECT exec,
         SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read,
         SUM(cache_write) AS cache_write, SUM(total) AS total, SUM(reasoning) AS reasoning,
         CASE WHEN COUNT(cost_usd) = 0 THEN NULL ELSE SUM(cost_usd) END AS cost_usd,
         MAX(currency) AS currency,
         CASE
           WHEN COUNT(cost_usd) = 0 THEN 'unavailable'
           WHEN SUM(CASE WHEN cost_usd IS NOT NULL AND (cost_source IS NULL OR cost_source != 'provider_reported') THEN 1 ELSE 0 END) = 0 THEN 'provider_reported'
           ELSE 'calculated'
         END AS cost_source
       FROM task_usage ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY exec`
    ).all(...args) as UsageRow[];
    return rows.map((r) => ({ exec: r.exec, usage: toUsage(r) }));
  }

  /** Daily totals by settlement date (UTC). The window is INCLUSIVE of today, so `days: 7` spans today
   *  and the six before it. Only days with settled tasks appear; the client fills the gaps. */
  aggregateByDay(projectIds?: number[], days = 7): { day: string; tokens: number; cost: number | null }[] {
    if (projectIds && projectIds.length === 0) return [];
    const where = [`captured_at >= date('now', ?)`];
    const args: (string | number)[] = [`-${Math.max(0, Math.floor(days) - 1)} days`];
    if (projectIds) { where.push(`project_id IN (${projectIds.map(() => '?').join(',')})`); args.push(...projectIds); }
    return this.db.prepare(
      `SELECT date(captured_at) AS day, SUM(total) AS tokens,
         CASE WHEN COUNT(cost_usd) = 0 THEN NULL ELSE SUM(cost_usd) END AS cost
       FROM task_usage WHERE ${where.join(' AND ')}
       GROUP BY day ORDER BY day`
    ).all(...args) as { day: string; tokens: number; cost: number | null }[];
  }

  deleteAll(): number { return this.db.prepare('DELETE FROM task_usage').run().changes; }
}

const MISSION_COLS = 'id,epic_id,autonomy,max_sessions,state,created_by,pilot_exec,overseer_exec';

/** The daemon consumes missions through the READ-ONLY AgentsMissions contract — every state change goes
 *  through the engine, which is plugin-owned. `create`/`setState` exist here only as test affordances,
 *  so a daemon suite can arrange the mission rows its tenancy or teardown assertion needs. */
export class RefMissions implements AgentsMissions {
  constructor(private db: Db) {}

  create(m: { id: string; epic_id: string; autonomy: string; max_sessions: number; created_by?: number | null; pilot_exec?: string; overseer_exec?: string }): Mission {
    this.db.prepare(
      `INSERT INTO missions (id,epic_id,autonomy,max_sessions,state,created_by,pilot_exec,overseer_exec)
       VALUES (@id,@epic_id,@autonomy,@max_sessions,'active',@created_by,@pilot_exec,@overseer_exec)
       ON CONFLICT(id) DO UPDATE SET
         epic_id=excluded.epic_id, autonomy=excluded.autonomy,
         max_sessions=excluded.max_sessions, state='active',
         pilot_exec=excluded.pilot_exec, overseer_exec=excluded.overseer_exec`
    ).run({ ...m, created_by: m.created_by ?? null, pilot_exec: m.pilot_exec ?? '', overseer_exec: m.overseer_exec ?? '' });
    return this.get(m.id)!;
  }

  get(id: string): Mission | null {
    return (this.db.prepare(`SELECT ${MISSION_COLS} FROM missions WHERE id=?`).get(id) as Mission | undefined) ?? null;
  }

  active(): Mission[] {
    return this.db.prepare(`SELECT ${MISSION_COLS} FROM missions WHERE state='active'`).all() as Mission[];
  }

  /** Active plus stalled — the set a human still cares about, and the one the self-update gate refuses
   *  to kill. A stalled mission returns to 'active' once its blocker clears. */
  live(): Mission[] {
    return this.db.prepare(`SELECT ${MISSION_COLS} FROM missions WHERE state IN ('active','stalled')`).all() as Mission[];
  }

  activeForEpic(epicId: string): Mission | null {
    return (this.db.prepare(`SELECT ${MISSION_COLS} FROM missions WHERE state='active' AND epic_id=?`).get(epicId) as Mission | undefined) ?? null;
  }

  setState(id: string, state: MissionState): void {
    this.db.prepare('UPDATE missions SET state=? WHERE id=?').run(state, id);
  }
}

/** Reference implementation of the daemon's `AgentsAdvisorHooks` contract (src/plugins/api.ts).
 *
 *  The advisor SERVICE is the agents plugin's — a tmux-hosted agent CLI per user. What the daemon
 *  consumes is these two hooks, and what its own routes are responsible for is calling them at the
 *  right moment: `ensureOnLogin` after a successful login, `stop` BEFORE the user row goes, because
 *  stop has to persist `advisor_autostart=false` and cannot do that against a deleted row. This mirrors
 *  the real service's core-visible effects — the session named `elowen-advisor-<id>` is killed and the
 *  autostart flag is cleared — so a route that skips the call, or makes it too late, is still caught. */
export class RefAdvisorHooks {
  /** Users seen by `stop()` whose row was ALREADY gone — every entry is an ordering violation. */
  readonly stoppedAfterDelete: number[] = [];
  constructor(private tmux: { list(): Promise<string[]>; kill(name: string): Promise<void> }, private users: { get(id: number): unknown; setAdvisorAutostart(id: number, on: boolean): unknown }) {}
  static session(userId: number): string { return `elowen-advisor-${userId}`; }

  async ensureOnLogin(_userId: number): Promise<void> { /* autostart is not what the delete path measures */ }

  async stop(userId: number): Promise<void> {
    if (!this.users.get(userId)) { this.stoppedAfterDelete.push(userId); return; }
    this.users.setAdvisorAutostart(userId, false);
    const session = RefAdvisorHooks.session(userId);
    if ((await this.tmux.list()).includes(session)) await this.tmux.kill(session);
  }
}

/** Reference implementation of a `PluginEventRowResolver` (src/plugins/api.ts) for the plugin-domain
 *  event shapes the daemon DECLARES but does not persist itself.
 *
 *  `ElowenEvent` is core's wire contract (src/api/sse.ts) and carries mission/review/decision/message/
 *  signal variants, but core's EventStore deliberately maps none of them: a registered resolver claims
 *  them, and with no plugin loaded they are simply not recorded. Every core behaviour around that —
 *  first-claim-wins, a throwing resolver being skipped, the project stamp, the label snapshot, the
 *  tenancy filter over recorded rows — needs SOME resolver present to be observable at all, and it must
 *  be one the daemon's own suite owns. The byte format the agents plugin actually persists is pinned
 *  beside that plugin (tests/agents-eventRows.test.ts in the plugin registry); this one only has to
 *  claim the same event types. */
export function refEventRow(e: { type: string } & Record<string, unknown>): { type: string; target: string; detail: string; labelTitleId?: string | null } | undefined {
  switch (e.type) {
    case 'mission': {
      const id = e.missionId as string;
      return { type: 'mission', target: id, detail: e.state as string, labelTitleId: id.startsWith('m-') ? id.slice(2) : null };
    }
    case 'review':
      return { type: 'review', target: e.taskId as string, detail: `${e.approve ? 'approved' : 'escalated'}: ${e.rationale as string}`, labelTitleId: e.taskId as string };
    case 'decision':
      return { type: 'decision', target: e.taskId as string, detail: JSON.stringify({ kind: e.kind, question: e.question, outcome: e.outcome, rationale: e.rationale, confidence: e.confidence, optionLabel: e.optionLabel }), labelTitleId: e.taskId as string };
    case 'message':
      return { type: 'message', target: e.taskId as string, detail: JSON.stringify({ role: e.role, text: e.text }), labelTitleId: e.taskId as string };
    case 'signal':
      return { type: 'signal', target: e.session as string, detail: (e.signal as { type: string }).type };
    default:
      return undefined; // core persists this one itself, or nobody does
  }
}
