import { homedir } from 'node:os';
import { resolveExecutor } from '../../overseer/routing.js';
import type { AgentSpec } from '../../spawn/commandBuilder.js';
import type { Task } from '../../store/types.js';
import { opencodeUsage } from './opencode.js';
import { claudeUsage } from './claude.js';
import { codexUsage } from './codex.js';
import { SESSION_MATCH_SKEW_MS, type TokenUsage } from './types.js';

export type { TokenUsage } from './types.js';

type UsageTask = Pick<Task, 'id' | 'labels' | 'created_at'>;

/** Parse a SQLite ("2026-06-19 11:13:20", UTC) or ISO timestamp to epoch ms. */
function parseTs(ts?: string | null): number {
  if (!ts) return 0;
  const ms = Date.parse(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? 0 : ms;
}

/** The resolved CLI program for a task ('opencode' | 'claude-code' | 'codex' | …). */
function programOf(task: Pick<Task, 'labels'>, fallback: AgentSpec): string {
  const p = resolveExecutor(task.labels ?? [], fallback).program;
  return p.startsWith('opencode') ? 'opencode' : p;
}

/** Rank of `task` among the agents that started concurrently (same program, start time within the
 *  match window) — i.e. how many such peers started before it. This lets N parallel agents in the
 *  same project map to the N CLI sessions deterministically (rank 0,1,2…) instead of all resolving
 *  to the earliest one. For a sequential mission there are no concurrent peers, so rank is 0. */
function concurrentRank(task: UsageTask, siblings: UsageTask[], fallback: AgentSpec, program: string, since: number): number {
  let rank = 0;
  for (const s of siblings) {
    if (s.id === task.id) continue;
    if (programOf(s, fallback) !== program) continue;
    const st = parseTs(s.created_at);
    if (Math.abs(st - since) > SESSION_MATCH_SKEW_MS) continue;
    if (st < since || (st === since && s.id < task.id)) rank++; // started before this one
  }
  return rank;
}

/** Token usage for a task's agent run, read from the executor CLI's local session storage.
 *  Chooses the parser by the task's resolved program, matches the session by project dir + start
 *  time, and disambiguates concurrent agents by start-order rank (so parallel missions attribute
 *  correctly). `siblings` are the other project tasks used to compute that rank. Returns null when
 *  no matching session is found (CLI unused or storage not persisted). */
export function readTaskUsage(task: UsageTask, siblings: UsageTask[], projectPath: string, fallback: AgentSpec, home: string = homedir()): TokenUsage | null {
  const since = parseTs(task.created_at);
  const program = programOf(task, fallback);
  const nth = concurrentRank(task, siblings, fallback, program, since);
  switch (program) {
    case 'opencode': return opencodeUsage(home, projectPath, since, nth);
    case 'claude-code': return claudeUsage(home, projectPath, since, nth);
    case 'codex': return codexUsage(home, projectPath, since, nth);
    default: return null;
  }
}
