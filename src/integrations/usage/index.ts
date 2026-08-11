import { homedir } from 'node:os';
import type { AgentSpec } from '../../shared/execRouting.js';
import { opencodeUsage } from './opencode.js';
import { claudeUsage } from './claude.js';
import { codexUsage } from './codex.js';
import { type TokenUsage } from './types.js';
import { concurrentRank, execOf, startedMs, type UsageTask } from './rank.js';

export type { TokenUsage } from './types.js';

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
