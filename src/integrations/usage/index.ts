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

/** The precise spawn time (epoch ms) the agent launched, from the `started:<ms>` label — this is
 *  sub-second and reflects real spawn order, unlike whole-second `created_at` (set at row insert).
 *  Falls back to created_at for tasks launched before this label existed. */
function startedMs(task: UsageTask): number {
  const lbl = task.labels?.find((l) => l.startsWith('started:'));
  if (lbl) { const ms = Number(lbl.slice('started:'.length)); if (Number.isFinite(ms)) return ms; }
  return parseTs(task.created_at);
}

/** The resolved CLI program + model for a task (program normalized: 'opencode' | 'claude-code' |
 *  'codex' | …). */
function execOf(task: Pick<Task, 'labels'>, fallback: AgentSpec): { program: string; model: string } {
  const e = resolveExecutor(task.labels ?? [], fallback);
  return { program: e.program.startsWith('opencode') ? 'opencode' : e.program, model: e.model };
}

/** Rank of `task` among matching agents that started at/before it within the window — i.e. how many
 *  such peers started first. A peer matches on program, and on model too when `model` is given (the
 *  opencode reader filters sessions by model, so its rank must be scoped the same way). Ordering is
 *  by real sub-second spawn time (started:<ms>), task id only as a final same-millisecond tiebreak.
 *  Maps N parallel agents in one project to the N CLI sessions in the same chronological order, so
 *  per-task usage isn't swapped. Sequential missions → rank 0. */
function concurrentRank(task: UsageTask, siblings: UsageTask[], fallback: AgentSpec, program: string, since: number, model?: string): number {
  let rank = 0;
  for (const s of siblings) {
    if (s.id === task.id) continue;
    // Only siblings that actually spawned hold a CLI session, so only they shift my rank. An open
    // (never-started) sibling has no `started:` label; counting it (via its created_at fallback)
    // would inflate the rank and mis-index the session — e.g. a closed phase showing a later,
    // still-pending phase's tokens.
    if (!s.labels?.some((l) => l.startsWith('started:'))) continue;
    const e = execOf(s, fallback);
    if (e.program !== program) continue;
    if (model !== undefined && e.model !== model) continue;
    const st = startedMs(s);
    if (st > since || since - st > SESSION_MATCH_SKEW_MS) continue; // only peers that started at/before me, within the window
    if (st < since || (st === since && s.id < task.id)) rank++;     // …and strictly ordered before me
  }
  return rank;
}

/** Token usage for a task's agent run, read from the executor CLI's local session storage.
 *  Chooses the parser by the task's resolved program, matches the session by project dir + the
 *  agent's spawn time, and disambiguates concurrent agents by start-order rank (so parallel
 *  missions attribute correctly). `siblings` are the other project tasks used to compute that rank.
 *  Returns null when no matching session is found (CLI unused or storage not persisted). */
export function readTaskUsage(task: UsageTask, siblings: UsageTask[], projectPath: string, fallback: AgentSpec, home: string = homedir()): TokenUsage | null {
  const since = startedMs(task);
  const { program, model } = execOf(task, fallback);
  switch (program) {
    // opencode records the model per session, so match by model too and rank only among same-model
    // peers (different-model concurrents — e.g. an executor next to the overseer — are split by it).
    case 'opencode': return opencodeUsage(home, projectPath, since, model, concurrentRank(task, siblings, fallback, program, since, model));
    case 'claude-code': return claudeUsage(home, projectPath, since, concurrentRank(task, siblings, fallback, program, since));
    case 'codex': return codexUsage(home, projectPath, since, concurrentRank(task, siblings, fallback, program, since));
    default: return null;
  }
}
