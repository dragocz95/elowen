import type { SpawnService } from '../spawn/spawn.js';
import type { ConfigStore } from '../store/configStore.js';
import type { ProjectStore } from '../store/projectStore.js';
import type { PlanJob } from './planJob.js';
import { resolveExecutor } from './routing.js';

/** The planning prompt: the Pilot reads the repo, then submits a structured plan via the orca CLI.
 *  It must NOT implement anything and must NOT spawn agents — the engine owns orchestration. */
export function pilotPrompt(goal: string, jobId: string, projectNotes?: string, template?: string): string {
  const notes = projectNotes?.trim() ? `\nProject context:\n${projectNotes.trim()}\n` : '';
  const guide = template?.trim() ? `\nPlanning guidance:\n${template.trim()}\n` : '';
  return [
    'You are the orca Pilot. Produce an implementation PLAN — do not write any code.',
    'First explore the repository (read the files relevant to the goal, AGENTS.md / CLAUDE.md / README for conventions) so the plan fits the actual codebase.',
    `Goal: ${goal}`,
    notes,
    guide,
    'Decompose the goal into 3 to 7 ordered phases. Each phase: a short title, a type (task|feature|bug|chore), optionally an agent name and a one-line details string.',
    'When the plan is ready, submit it ONCE with a single command (do NOT implement, do NOT spawn agents, do NOT close anything):',
    `  orca plan submit --phases '[{"title":"...","type":"feature","details":"..."}]'`,
    `(Job ${jobId} is set in your ORCA_PLAN_JOB env — the command picks it up automatically.)`,
    'After submitting, stop. The orca engine will create and run the phases.',
  ].filter(Boolean).join('\n');
}

/** Build the Pilot spawner: launches a repo-aware planning agent for an agent-mode plan job. The
 *  agent submits its plan back through the orca CLI (`orca plan submit`); the daemon never reads its
 *  stdout. Returns a function matching the `pilot` ServerDep. */
export function makePilot(deps: { spawn: SpawnService; config: ConfigStore; projects: ProjectStore; nameAgent: () => string }): (job: PlanJob, projectPath: string) => Promise<void> {
  return async (job, projectPath) => {
    const cfg = deps.config.get();
    const spec = resolveExecutor([`exec:${cfg.autopilot.pilotExec}`], { program: 'claude-code', model: 'sonnet' });
    const notes = deps.projects.get(job.projectId)?.notes;
    // Structured `pilot-` prefix so the session classifies as the planner (mirrors the overseer's
    // `overseer-` prefix), instead of being indistinguishable from a worker agent.
    const agentName = `pilot-${deps.nameAgent()}`;
    await deps.spawn.launch({
      projectId: job.projectId, projectPath, taskId: job.id, agentName, spec,
      taskTitle: `Plan: ${job.goal}`,
      rawPrompt: pilotPrompt(job.goal, job.id, notes, cfg.autopilot.prompt),
      extraEnv: { ORCA_PLAN_JOB: job.id },
    });
  };
}
