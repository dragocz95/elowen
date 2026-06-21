import type { SpawnService } from '../spawn/spawn.js';
import type { ConfigStore } from '../store/configStore.js';
import type { ProjectStore } from '../store/projectStore.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { PlanJob, PlanJobStore } from './planJob.js';
import { render } from '../prompts/index.js';
import { resolveExecutor } from './routing.js';
import { modelsBlock } from './planner.js';
import { freeAgentName } from '../daemon/uniqueName.js';

/** The planning prompt: the Pilot reads the repo, then submits a structured plan via the orca CLI.
 *  It must NOT implement anything and must NOT spawn agents — the engine owns orchestration.
 *  Note: this is a complete, self-contained agent prompt. It deliberately does NOT embed the relay
 *  planner template (`config.autopilot.prompt`) — that template is a relay-format prompt carrying
 *  `{{goal}}` placeholders and a "return ONLY a JSON array" instruction, which would both leak the
 *  raw placeholder into the agent's view and contradict the `orca plan submit` flow below. */
export function pilotPrompt(goal: string, jobId: string, projectNotes?: string, cliPath?: string, models?: string): string {
  // Inline notes block (empty when there are none) so the goal line stays flush against the rest.
  const notes = projectNotes?.trim() ? `\n\nProject context:\n${projectNotes.trim()}\n` : '';
  // Invoke the daemon's OWN CLI by absolute path via node — exactly like the worker close command.
  // A bare `orca` would 127 (`command not found`) unless the binary happens to be on the agent's
  // PATH, and even then it could be a version-skewed global install rather than this daemon's CLI.
  const submit = cliPath ? `node ${cliPath} plan submit` : 'orca plan submit';
  // Empty when auto model selection is off — render() drops the {{models}} token to nothing.
  return render('pilot', { goal, notes, submit, jobId, models: models ?? '' });
}

/** Build the Pilot spawner: launches a repo-aware planning agent for an agent-mode plan job. The
 *  agent submits its plan back through the orca CLI (`orca plan submit`); the daemon never reads its
 *  stdout. Returns a function matching the `pilot` ServerDep. */
export function makePilot(deps: { spawn: SpawnService; config: ConfigStore; projects: ProjectStore; planJobs: PlanJobStore; tmux: TmuxDriver; nameAgent: () => string; cliPath?: string }): (job: PlanJob, projectPath: string) => Promise<void> {
  return async (job, projectPath) => {
    const cfg = deps.config.get();
    const spec = resolveExecutor([`exec:${cfg.autopilot.pilotExec}`], { program: 'claude-code', model: 'sonnet' });
    const notes = deps.projects.get(job.projectId)?.notes;
    const models = job.autoModel ? modelsBlock(cfg.allowedExecs, cfg.modelNotes) : undefined;
    // Structured `pilot-` prefix so the session classifies as the planner (mirrors the overseer's
    // `overseer-` prefix), instead of being indistinguishable from a worker agent. The name is picked
    // clear of any live session so a lingering pilot can never trigger a duplicate-session crash.
    const agentName = `pilot-${await freeAgentName(deps.nameAgent, () => deps.tmux.list(), 'pilot-')}`;
    const { session } = await deps.spawn.launch({
      projectId: job.projectId, projectPath, taskId: job.id, agentName, spec,
      taskTitle: `Plan: ${job.goal}`,
      rawPrompt: pilotPrompt(job.goal, job.id, notes, deps.cliPath, models),
      extraEnv: { ORCA_PLAN_JOB: job.id },
    });
    // Expose the live tmux session so the client can preview the planner's pane while it works.
    deps.planJobs.setSession(job.id, session);
  };
}
