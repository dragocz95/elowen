import { resolveExecutor } from '../../shared/execRouting.js';
import type { AgentSpec } from '../../shared/execRouting.js';
import type { Task } from '../../store/types.js';
import { SESSION_MATCH_SKEW_MS } from './types.js';
import { parseDbTs } from '../../shared/time.js';

/** The minimal task shape both the usage reader and the session-id detector rank by. */
export type UsageTask = Pick<Task, 'id' | 'labels' | 'created_at'>;

/** The precise spawn time (epoch ms) the agent launched, from the `started:<ms>` label — this is
 *  sub-second and reflects real spawn order, unlike whole-second `created_at` (set at row insert).
 *  Falls back to created_at for tasks launched before this label existed. */
export function startedMs(task: UsageTask): number {
  const lbl = task.labels?.find((l) => l.startsWith('started:'));
  if (lbl) { const ms = Number(lbl.slice('started:'.length)); if (Number.isFinite(ms)) return ms; }
  return parseDbTs(task.created_at);
}

/** The resolved CLI program + model for a task (program normalized: 'opencode' | 'claude-code' |
 *  'codex' | …). */
export function execOf(task: Pick<Task, 'labels'>, fallback: AgentSpec): { program: string; model: string } {
  const e = resolveExecutor(task.labels ?? [], fallback);
  return { program: e.program.startsWith('opencode') ? 'opencode' : e.program, model: e.model };
}

/** Rank of `task` among matching agents that started at/before it within the window — i.e. how many
 *  such peers started first. A peer matches on program, and on model too when `model` is given (the
 *  opencode reader filters sessions by model, so its rank must be scoped the same way). Ordering is
 *  by real sub-second spawn time (started:<ms>), task id only as a final same-millisecond tiebreak.
 *  Maps N parallel agents in one project to the N CLI sessions in the same chronological order, so
 *  per-task usage isn't swapped. Sequential missions → rank 0. Single source of truth shared by the
 *  usage reader and the resume session-id detector, so both index into the same session. */
export function concurrentRank(task: UsageTask, siblings: UsageTask[], fallback: AgentSpec, program: string, since: number, model?: string): number {
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
