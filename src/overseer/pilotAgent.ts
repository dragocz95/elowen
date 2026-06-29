import type { SpawnService } from '../spawn/spawn.js';
import type { ConfigStore } from '../store/configStore.js';
import type { ProjectStore } from '../store/projectStore.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { PlanJob, PlanJobStore } from './planJob.js';
import { render } from '../prompts/index.js';
import type { RenderPrompt } from '../spawn/commandBuilder.js';
import type { PromptService } from '../prompts/promptService.js';
import { resolveExecutor } from './routing.js';
import { modelsBlock, parallelismBlock } from './planner.js';
import { resolvePrEnabled } from './prMode.js';
import { freeAgentName } from '../daemon/uniqueName.js';

/** The planning prompt: the Pilot reads the repo, then submits a structured plan via the orca CLI.
 *  It must NOT implement anything and must NOT spawn agents — the engine owns orchestration.
 *  Note: this is a complete, self-contained agent prompt. It deliberately does NOT embed the relay
 *  planner template (`config.autopilot.prompt`) — that template is a relay-format prompt carrying
 *  `{{goal}}` placeholders and a "return ONLY a JSON array" instruction, which would both leak the
 *  raw placeholder into the agent's view and contradict the `orca plan submit` flow below. */
export function pilotPrompt(goal: string, jobId: string, projectNotes?: string, cli: string = 'orca', models?: string, parallelism?: string, renderPrompt: RenderPrompt = render): string {
  // Inline notes block (empty when there are none) so the goal line stays flush against the rest.
  const notes = projectNotes?.trim() ? `\n\nProject context:\n${projectNotes.trim()}\n` : '';
  // `cli` is the resolved orca invocation (global `orca`, or `node <cliPath>` in a source checkout).
  const submit = `${cli} plan submit`;
  // Empty when auto model selection is off — render() drops the {{models}} token to nothing.
  return renderPrompt('pilot', { goal, notes, submit, jobId, models: models ?? '', parallelism: parallelism ?? '' });
}

/** Build the Pilot spawner: launches a repo-aware planning agent for an agent-mode plan job. The
 *  agent submits its plan back through the orca CLI (`orca plan submit`); the daemon never reads its
 *  stdout. Returns a function matching the `pilot` ServerDep. */
export function makePilot(deps: { spawn: SpawnService; config: ConfigStore; projects: ProjectStore; planJobs: PlanJobStore; tmux: TmuxDriver; nameAgent: () => string; cli?: string; prompts?: PromptService }): (job: PlanJob, projectPath: string) => Promise<void> {
  return async (job, projectPath) => {
    const cfg = deps.config.get();
    const spec = resolveExecutor([`exec:${cfg.autopilot.pilotExec}`], { program: 'claude-code', model: 'sonnet' });
    const project = deps.projects.get(job.projectId);
    const notes = project?.notes;
    const models = job.autoModel ? modelsBlock(cfg.allowedExecs, cfg.modelNotes) : undefined;
    // Tell the Pilot whether it may plan parallel (independent) phases: only when the mission both
    // allows >1 session AND will run in an isolated worktree (resolved the same way runtime does).
    const isolated = resolvePrEnabled(job.prEnabled ?? null, project?.pr_enabled ?? null, cfg.autopilot.prEnabled);
    // Read maxSessions from the job itself (set at plan time independent of engage), so "plan now,
    // engage later" still plans a parallel DAG. Fall back to engage's value for older callers.
    const parallelism = parallelismBlock(job.maxSessions ?? job.engage?.maxSessions ?? 1, isolated);
    // Structured `pilot-` prefix so the session classifies as the planner (mirrors the overseer's
    // `overseer-` prefix), instead of being indistinguishable from a worker agent. The name is picked
    // clear of any live session so a lingering pilot can never trigger a duplicate-session crash.
    const agentName = `pilot-${await freeAgentName(deps.nameAgent, () => deps.tmux.list(), 'pilot-')}`;
    // Render the Pilot prompt through the plan owner's overrides (else file default).
    const prompts = deps.prompts;
    const renderPrompt: RenderPrompt = prompts ? (name, vars) => prompts.render(name, vars, job.createdBy) : render;
    const { session } = await deps.spawn.launch({
      projectId: job.projectId, projectPath, taskId: job.id, agentName, spec,
      taskTitle: `Plan: ${job.goal}`,
      rawPrompt: pilotPrompt(job.goal, job.id, notes, deps.cli, models, parallelism, renderPrompt),
      extraEnv: { ORCA_PLAN_JOB: job.id },
    });
    // Expose the live tmux session so the client can preview the planner's pane while it works.
    deps.planJobs.setSession(job.id, session);
  };
}
