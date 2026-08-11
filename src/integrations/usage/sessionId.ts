import { homedir } from 'node:os';
import { basename } from 'node:path';
import type { Program } from '../../shared/execs.js';
import type { AgentSpec } from '../../shared/execRouting.js';
import { locateClaudeSession } from './claude.js';
import { locateCodexSession, codexSessionId } from './codex.js';
import { locateOpencodeSession } from './opencode.js';
import { concurrentRank, execOf, startedMs, type UsageTask } from './rank.js';

/** The CLI session a task's agent ran under, for resume — its program and the program-native session
 *  id (claude/codex UUID, or opencode `ses_…`). */
export interface DetectedSession { program: Program; sessionId: string }

/** Find the CLI session id a task's agent ran under, so a later re-spawn can `--resume` it instead of
 *  cold-starting. Mirrors `readTaskUsage` exactly — same spawn time (`started:<ms>`), same program
 *  resolution, same concurrent-rank — but extracts the session's id rather than its token totals, so
 *  resume and usage always index into the *same* session. Returns null when no session matches (CLI
 *  unused, storage not persisted, or an unsupported program). `siblings` are the other project tasks
 *  used to compute the concurrency rank. */
export function detectSessionId(task: UsageTask, siblings: UsageTask[], projectPath: string, fallback: AgentSpec, home: string = homedir()): DetectedSession | null {
  const since = startedMs(task);
  const { program, model } = execOf(task, fallback);
  switch (program) {
    case 'claude-code': {
      const p = locateClaudeSession(home, projectPath, since, concurrentRank(task, siblings, fallback, program, since));
      return p ? { program: 'claude-code', sessionId: basename(p, '.jsonl') } : null;
    }
    case 'codex': {
      const p = locateCodexSession(home, projectPath, since, concurrentRank(task, siblings, fallback, program, since));
      const id = p ? codexSessionId(p) : null;
      return id ? { program: 'codex', sessionId: id } : null;
    }
    case 'opencode': {
      // opencode records the model per session, so match by model too and rank only among same-model
      // peers — mirrors the usage reader so the resumed session is the one whose tokens we recorded.
      const id = locateOpencodeSession(home, projectPath, since, model, concurrentRank(task, siblings, fallback, program, since, model));
      return id ? { program: 'opencode', sessionId: id } : null;
    }
    default: return null;
  }
}
