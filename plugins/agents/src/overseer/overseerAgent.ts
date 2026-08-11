import type { SpawnService } from '../spawn/spawn.js';
import type { TmuxDriver } from '../../../../src/tmux/types.js';
import type { PluginHostConfig as ConfigStore, PluginHostPrompts as PromptService } from '../../../../src/plugins/api.js';
import type { DecisionQueue } from './decisionQueue.js';
import type { RenderPrompt } from '../spawn/commandBuilder.js';
import { resolveExecutor } from './routing.js';

/** The parked overseer's loop prompt: poll for a decision, judge it, answer, repeat. It reasons but
 *  never edits the repo — its only side effects are the two elowen CLI verbs. */
export function overseerPrompt(missionId: string, renderPrompt: RenderPrompt, cli: string = 'elowen'): string {
  // `cli` is the resolved elowen invocation (the global `elowen` command in production, or
  // `node <path-to-dist/cli/index.js>` in a source checkout) — see bootstrap's ELOWEN_CLI handling.
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
export function makeOverseer(deps: { spawn: SpawnService; tmux: TmuxDriver; config: ConfigStore; queue: DecisionQueue; cli?: string; missionGit?: { worktreeFor(missionId: string): string | null }; missions?: { get(id: string): { created_by: number | null; overseer_exec?: string } | null }; prompts: PromptService }): OverseerController {
  // In-flight park per mission. The guard below is a check-then-act across an await, and engage, the
  // mission tick and the watchdog all call park concurrently — without serialization both callers observe
  // the session missing and launch, and the second `tmux new-session` throws "duplicate session".
  const inflight = new Map<string, Promise<void>>();
  // Single source for the launch — every caller (engage/resume start, the tick watchdog's ensure,
  // the reconcile sweep) routes through here, so the idempotency guard lives here too.
  const parkOnce = async (missionId: string, projectId: number, projectPath: string): Promise<void> => {
    const mission = deps.missions?.get(missionId);
    const exec = mission?.overseer_exec || deps.config.get().autopilot.overseerExec;
    if (!exec) return; // relay fallback — no parked agent
    // Idempotent: a live overseer session IS the desired state. If one is already parked for this
    // mission, leave it — re-launching would make `tmux new-session` throw "duplicate session" and
    // crash the caller. engage and resume call this unconditionally (the overseer can already be
    // parked from a prior engage), so the guard must be here, not only in ensure.
    if ((await deps.tmux.list()).includes(`elowen-overseer-${missionId}`)) return;
    const spec = resolveExecutor([`exec:${exec}`], { program: 'claude-code', model: 'sonnet' });
    // Park the overseer in the mission's worktree when PR-native (else the project checkout). The
    // overseer judges a phase by running read-only `git diff HEAD` itself — and the agent's work lives
    // in the worktree, not the main checkout. Run it in the main checkout and every phase false-rejects
    // as "fabricated" (the checkout shows zero changes), looping the mission forever.
    const cwd = deps.missionGit?.worktreeFor(missionId) ?? projectPath;
    // Render the overseer prompt through the mission owner's overrides (the host prompt service
    // resolves override → plugin file → core file; prompts is required in the plugin — no file fallback).
    const ownerId = mission?.created_by ?? null;
    const renderPrompt: RenderPrompt = (name, vars) => deps.prompts.render(name, vars, ownerId);
    await deps.spawn.launch({
      projectId, projectPath: cwd, taskId: `overseer-${missionId}`, agentName: `overseer-${missionId}`, spec,
      rawPrompt: overseerPrompt(missionId, renderPrompt, deps.cli), extraEnv: { ELOWEN_MISSION: missionId }, ownerId,
    });
  };
  // Queue behind whatever park is already running for this mission, so the second caller re-reads the
  // session list AFTER the first has launched. A failed park settles the chain (the error reaches its own
  // caller) instead of poisoning the next attempt; the entry is dropped once the chain drains.
  const park = (missionId: string, projectId: number, projectPath: string): Promise<void> => {
    const queued = (inflight.get(missionId) ?? Promise.resolve())
      .catch(() => { /* a previous caller's failure is theirs to handle */ })
      .then(() => parkOnce(missionId, projectId, projectPath));
    inflight.set(missionId, queued);
    return queued.finally(() => { if (inflight.get(missionId) === queued) inflight.delete(missionId); });
  };
  return {
    start: park,
    // The tick watchdog: re-park only if the session has died. park is idempotent (no-ops when the
    // session is live and when overseerExec is empty), so ensure is just a semantic alias for it.
    ensure: park,
    async stop(missionId) {
      await deps.tmux.kill(`elowen-overseer-${missionId}`).catch(() => { /* already gone — fine */ });
      deps.queue.drain(missionId); // escalate any awaiting decisions so nothing hangs
    },
  };
}
