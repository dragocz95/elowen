import type { Db } from './db.js';
import type { TokenUsage } from '../integrations/usage/types.js';

interface AggRow {
  exec: string;
  input: number; output: number; cache_read: number; cache_write: number; total: number;
  cost_usd: number | null;
}

/** Persisted per-task usage snapshots. A task's numbers are captured once when it settles, so the
 *  stats page aggregates straight from here — no re-scanning the CLIs' (potentially gigabyte) session
 *  stores on every request. `record` is keyed on task_id, so a re-run/re-snapshot replaces in place. */
export class TaskUsageStore {
  constructor(private db: Db) {}

  /** Snapshot a settled task's usage (insert or replace its row). */
  record(taskId: string, projectId: number, exec: string, usage: TokenUsage): void {
    this.db.prepare(
      `INSERT INTO task_usage (task_id, project_id, exec, input, output, cache_read, cache_write, total, cost_usd)
       VALUES (@task_id, @project_id, @exec, @input, @output, @cache_read, @cache_write, @total, @cost_usd)
       ON CONFLICT(task_id) DO UPDATE SET
         project_id=excluded.project_id, exec=excluded.exec, input=excluded.input, output=excluded.output,
         cache_read=excluded.cache_read, cache_write=excluded.cache_write, total=excluded.total,
         cost_usd=excluded.cost_usd, captured_at=datetime('now')`
    ).run({
      task_id: taskId, project_id: projectId, exec,
      input: usage.input, output: usage.output, cache_read: usage.cacheRead,
      cache_write: usage.cacheWrite, total: usage.total, cost_usd: usage.costUsd,
    });
  }

  /** Total usage per exec spec. When `projectIds` is given, scope to those projects (an empty array
   *  yields nothing — no accessible projects). An optional `window` narrows to `captured_at` bounds
   *  (ISO-8601 strings; SQLite's `datetime()` normalizes them to the same `YYYY-MM-DD HH:MM:SS` UTC
   *  format the column stores, so the comparison is always apples-to-apples). A bucket's cost is null
   *  only when no row in it has a cost (so claude/codex-only models read as "—" while mixed/opencode
   *  buckets sum the real costs). */
  aggregateByExec(projectIds?: number[], window?: { fromIso?: string; toIso?: string }): { exec: string; usage: TokenUsage }[] {
    if (projectIds && projectIds.length === 0) return [];
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (projectIds) { clauses.push(`project_id IN (${projectIds.map(() => '?').join(',')})`); params.push(...projectIds); }
    if (window?.fromIso) { clauses.push('captured_at >= datetime(?)'); params.push(window.fromIso); }
    if (window?.toIso) { clauses.push('captured_at <= datetime(?)'); params.push(window.toIso); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT exec,
         SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read,
         SUM(cache_write) AS cache_write, SUM(total) AS total,
         CASE WHEN COUNT(cost_usd) = 0 THEN NULL ELSE SUM(cost_usd) END AS cost_usd
       FROM task_usage ${where}
       GROUP BY exec`
    ).all(...params) as AggRow[];
    return rows.map((r) => ({
      exec: r.exec,
      usage: {
        input: r.input, output: r.output, cacheRead: r.cache_read,
        cacheWrite: r.cache_write, total: r.total, costUsd: r.cost_usd,
      },
    }));
  }

  /** Daily spend/token totals over the last `days` days (UTC, by `captured_at` date), for the
   *  dashboard's 7-day trend. Same project scoping as `aggregateByExec` (empty array → nothing).
   *  Only days that actually have settled tasks appear — the client fills the gaps with zero. A day's
   *  cost is null when no row that day carried a cost (claude/codex-only → "—"). Note the axis is the
   *  task-settlement date, so this reads as "cost of tasks closed that day", not realtime burn. */
  aggregateByDay(projectIds?: number[], days = 7): { day: string; tokens: number; cost: number | null }[] {
    if (projectIds && projectIds.length === 0) return [];
    const clauses: string[] = [`captured_at >= date('now', ?)`];
    const params: (string | number)[] = [`-${Math.max(0, Math.floor(days) - 1)} days`];
    if (projectIds) { clauses.push(`project_id IN (${projectIds.map(() => '?').join(',')})`); params.push(...projectIds); }
    const rows = this.db.prepare(
      `SELECT date(captured_at) AS day, SUM(total) AS tokens,
         CASE WHEN COUNT(cost_usd) = 0 THEN NULL ELSE SUM(cost_usd) END AS cost
       FROM task_usage
       WHERE ${clauses.join(' AND ')}
       GROUP BY day
       ORDER BY day`
    ).all(...params) as { day: string; tokens: number; cost: number | null }[];
    return rows;
  }

  /** Wipe all snapshots (the stats-page reset). Returns the number of rows removed. */
  deleteAll(): number {
    return this.db.prepare('DELETE FROM task_usage').run().changes;
  }
}
