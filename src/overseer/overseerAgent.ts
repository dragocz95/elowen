import type { SpawnService } from '../spawn/spawn.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { ConfigStore } from '../store/configStore.js';
import type { DecisionQueue } from './decisionQueue.js';
import { render } from '../prompts/index.js';
import { resolveExecutor } from './routing.js';

/** The parked overseer's loop prompt: poll for a decision, judge it, answer, repeat. It reasons but
 *  never edits the repo — its only side effects are the two orca CLI verbs. */
export function overseerPrompt(missionId: string, cliPath?: string): string {
  // Invoke the daemon's OWN CLI by absolute path via node (like the worker close command). A bare
  // `orca` would 127 (`command not found`) — the binary isn't on the agent's PATH.
  const cli = cliPath ? `node ${cliPath}` : 'orca';
  return render('overseer', { missionId, cli });
}

export interface OverseerController {
  start(missionId: string, projectId: number, projectPath: string): Promise<void>;
  stop(missionId: string): Promise<void>;
}

/** Lifecycle of the parked per-mission overseer agent. When `overseerExec` is empty the controller
 *  is inert (the relay fallback in bootstrap handles decisions inline). The agent is parked: it
 *  long-polls and sits idle (0 tokens) until the engine/deriver enqueue a decision. */
export function makeOverseer(deps: { spawn: SpawnService; tmux: TmuxDriver; config: ConfigStore; queue: DecisionQueue; cliPath?: string }): OverseerController {
  return {
    async start(missionId, projectId, projectPath) {
      const exec = deps.config.get().autopilot.overseerExec;
      if (!exec) return; // relay fallback — no parked agent
      const spec = resolveExecutor([`exec:${exec}`], { program: 'claude-code', model: 'sonnet' });
      await deps.spawn.launch({
        projectId, projectPath, taskId: `overseer-${missionId}`, agentName: `overseer-${missionId}`, spec,
        rawPrompt: overseerPrompt(missionId, deps.cliPath), extraEnv: { ORCA_MISSION: missionId },
      });
    },
    async stop(missionId) {
      await deps.tmux.kill(`orca-overseer-${missionId}`).catch(() => { /* already gone — fine */ });
      deps.queue.drain(missionId); // escalate any awaiting decisions so nothing hangs
    },
  };
}
