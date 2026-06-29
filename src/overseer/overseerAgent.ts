import type { SpawnService } from '../spawn/spawn.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { ConfigStore } from '../store/configStore.js';
import type { DecisionQueue } from './decisionQueue.js';
import { render } from '../prompts/index.js';
import type { RenderPrompt } from '../spawn/commandBuilder.js';
import type { PromptService } from '../prompts/promptService.js';
import { resolveExecutor } from './routing.js';

/** The parked overseer's loop prompt: poll for a decision, judge it, answer, repeat. It reasons but
 *  never edits the repo — its only side effects are the two orca CLI verbs. */
export function overseerPrompt(missionId: string, cli: string = 'orca', renderPrompt: RenderPrompt = render): string {
  // `cli` is the resolved orca invocation (the global `orca` command in production, or
  // `node <path-to-dist/cli/index.js>` in a source checkout) — see bootstrap's ORCA_CLI handling.
  // The code-review criteria live in their own template (separately editable per user) and are
  // injected into the overseer's review handling via the `{{codeReview}}` placeholder.
  const codeReview = renderPrompt('code-review', {});
  return renderPrompt('overseer', { missionId, cli, codeReview });
}

export interface OverseerController {
  start(missionId: string, projectId: number, projectPath: string): Promise<void>;
  /** Re-park the agent only if its session has died (idempotent). The mission tick calls this every
   *  beat so an overseer that exited mid-mission (full context / clean exit) is restored — otherwise
   *  its post-phase reviews and prompt decisions silently stop. Inert when no overseerExec is set. */
  ensure(missionId: string, projectId: number, projectPath: string): Promise<void>;
  stop(missionId: string): Promise<void>;
}

/** Lifecycle of the parked per-mission overseer agent. When `overseerExec` is empty the controller
 *  is inert (the relay fallback in bootstrap handles decisions inline). The agent is parked: it
 *  long-polls and sits idle (0 tokens) until the engine/deriver enqueue a decision. */
export function makeOverseer(deps: { spawn: SpawnService; tmux: TmuxDriver; config: ConfigStore; queue: DecisionQueue; cli?: string; missionGit?: { worktreeFor(missionId: string): string | null }; missions?: { get(id: string): { created_by: number | null } | null }; prompts?: PromptService }): OverseerController {
  // Single source for the launch — every caller (engage/resume start, the tick watchdog's ensure,
  // the reconcile sweep) routes through here, so the idempotency guard lives here too.
  const park = async (missionId: string, projectId: number, projectPath: string): Promise<void> => {
    const exec = deps.config.get().autopilot.overseerExec;
    if (!exec) return; // relay fallback — no parked agent
    // Idempotent: a live overseer session IS the desired state. If one is already parked for this
    // mission, leave it — re-launching would make `tmux new-session` throw "duplicate session" and
    // crash the caller. engage and resume call this unconditionally (the overseer can already be
    // parked from a prior engage), so the guard must be here, not only in ensure.
    if ((await deps.tmux.list()).includes(`orca-overseer-${missionId}`)) return;
    const spec = resolveExecutor([`exec:${exec}`], { program: 'claude-code', model: 'sonnet' });
    // Park the overseer in the mission's worktree when PR-native (else the project checkout). The
    // overseer judges a phase by running read-only `git diff HEAD` itself — and the agent's work lives
    // in the worktree, not the main checkout. Run it in the main checkout and every phase false-rejects
    // as "fabricated" (the checkout shows zero changes), looping the mission forever.
    const cwd = deps.missionGit?.worktreeFor(missionId) ?? projectPath;
    // Render the overseer prompt through the mission owner's overrides (else file default).
    const prompts = deps.prompts;
    const ownerId = deps.missions?.get(missionId)?.created_by ?? null;
    const renderPrompt: RenderPrompt = prompts ? (name, vars) => prompts.render(name, vars, ownerId) : render;
    await deps.spawn.launch({
      projectId, projectPath: cwd, taskId: `overseer-${missionId}`, agentName: `overseer-${missionId}`, spec,
      rawPrompt: overseerPrompt(missionId, deps.cli, renderPrompt), extraEnv: { ORCA_MISSION: missionId }, ownerId,
    });
  };
  return {
    start: park,
    // The tick watchdog: re-park only if the session has died. park is idempotent (no-ops when the
    // session is live and when overseerExec is empty), so ensure is just a semantic alias for it.
    ensure: park,
    async stop(missionId) {
      await deps.tmux.kill(`orca-overseer-${missionId}`).catch(() => { /* already gone — fine */ });
      deps.queue.drain(missionId); // escalate any awaiting decisions so nothing hangs
    },
  };
}
