import type { SpawnService } from '../spawn/spawn.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { ConfigStore } from '../store/configStore.js';
import type { DecisionQueue } from './decisionQueue.js';
import { resolveExecutor } from './routing.js';

/** The parked overseer's loop prompt: poll for a decision, judge it, answer, repeat. It reasons but
 *  never edits the repo — its only side effects are the two orca CLI verbs. */
export function overseerPrompt(missionId: string): string {
  return [
    `You are the orca Overseer for mission ${missionId}. You approve or escalate decisions for autonomous coding agents.`,
    'Loop forever:',
    '  1. Run `orca overseer poll`. It BLOCKS until a decision is needed, then prints JSON {id, kind, context} (or {} on a heartbeat — just poll again).',
    '  2. Read the context. Approve routine, safe, clearly-correct actions; escalate anything destructive, ambiguous, or beyond the stated intent.',
    '  3. Answer with exactly one command:',
    '       approve:  orca overseer decide --id <id> --approve --confidence <0..1> --rationale "<why>"',
    '       escalate: orca overseer decide --id <id> --escalate --rationale "<why>"',
    '  4. Go back to step 1. Keep your reasoning brief to stay within context as the mission runs.',
    'Never write code or run other commands. You only poll and decide.',
  ].join('\n');
}

export interface OverseerController {
  start(missionId: string, projectId: number, projectPath: string): Promise<void>;
  stop(missionId: string): Promise<void>;
}

/** Lifecycle of the parked per-mission overseer agent. When `overseerExec` is empty the controller
 *  is inert (the relay fallback in bootstrap handles decisions inline). The agent is parked: it
 *  long-polls and sits idle (0 tokens) until the engine/deriver enqueue a decision. */
export function makeOverseer(deps: { spawn: SpawnService; tmux: TmuxDriver; config: ConfigStore; queue: DecisionQueue }): OverseerController {
  return {
    async start(missionId, projectId, projectPath) {
      const exec = deps.config.get().autopilot.overseerExec;
      if (!exec) return; // relay fallback — no parked agent
      const spec = resolveExecutor([`exec:${exec}`], { program: 'claude-code', model: 'sonnet' });
      await deps.spawn.launch({
        projectId, projectPath, taskId: `overseer-${missionId}`, agentName: `overseer-${missionId}`, spec,
        rawPrompt: overseerPrompt(missionId), extraEnv: { ORCA_MISSION: missionId },
      });
    },
    async stop(missionId) {
      await deps.tmux.kill(`orca-overseer-${missionId}`).catch(() => { /* already gone — fine */ });
      deps.queue.drain(missionId); // escalate any awaiting decisions so nothing hangs
    },
  };
}
