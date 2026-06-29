import type { TmuxDriver } from '../tmux/types.js';
import type { AgentStore } from '../store/agentStore.js';
import { buildAgentCommand, type AgentSpec } from './commandBuilder.js';
import type { PendingResume } from './resume/index.js';
import type { PromptService } from '../prompts/promptService.js';
import { logger } from '../shared/logger.js';

const log = logger('spawn');

/** How a spawned agent reaches back to the daemon to close its task. `cli` is the full orca
 *  invocation: the global `orca` command in production, or `node <dist/cli/index.js>` in a checkout. */
export interface OrcaCliConfig { cli: string; url: string; token: string }
/** Per-program binary override + extra args + permission-bypass toggle + resume toggle (configured in
 *  Settings → Providers). `skipPermissions` and `resume` default to true at the config layer;
 *  undefined here means "use the built-in default" (bypass on / resume on). */
export type ProviderResolver = (program: string) => { bin?: string; args?: string; skipPermissions?: boolean; resume?: boolean } | undefined;

export class SpawnService {
  constructor(private d: { tmux: TmuxDriver; agents: AgentStore; orca?: OrcaCliConfig; providers?: ProviderResolver; prompts?: PromptService }) {}
  async launch(input: { projectId: number; projectPath: string; taskId: string; agentName: string; spec: AgentSpec; taskTitle?: string; taskDescription?: string; resumeNote?: string; epicId?: string; extraEnv?: Record<string, string>; rawPrompt?: string; resume?: PendingResume; ownerId?: number | null; mcpUrl?: string }): Promise<{ session: string }> {
    this.d.agents.upsert({ project_id: input.projectId, name: input.agentName, program: input.spec.program, model: input.spec.model });
    const session = `orca-${input.agentName}`;
    const orca = this.d.orca;
    // The agent reaches the daemon through the resolved orca CLI (`orca` globally, or `node <path>`
    // in a checkout). Shared by the close commands and the worker preamble's read-only verbs.
    const cli = orca ? orca.cli : undefined;
    const closeCommand = orca ? `${orca.cli} close ${input.taskId}` : undefined;
    // A phase agent gets a close command for its parent epic too, so the final phase can
    // close the epic itself with its own overall result summary.
    const epicCloseCommand = orca && input.epicId ? `${orca.cli} close ${input.epicId}` : undefined;
    // Merge any caller-supplied env (e.g. ORCA_PLAN_JOB / ORCA_MISSION for reasoning agents) on top
    // of the daemon-reach env. extraEnv alone still flows through when no orca config is present.
    const env = orca ? { ORCA_URL: orca.url, ORCA_TOKEN: orca.token, ...input.extraEnv } : input.extraEnv;
    const provider = this.d.providers?.(input.spec.program);
    // Resume only when the recorded session is for THIS spawn's program (the operator may have
    // switched the task's exec since) and the provider hasn't disabled resume. Otherwise cold start.
    const normalizedProgram = input.spec.program.startsWith('opencode') ? 'opencode' : input.spec.program;
    const resume = input.resume && input.resume.program === normalizedProgram && provider?.resume !== false
      ? input.resume : undefined;
    if (resume) log.info(`resuming ${resume.program} session ${resume.sessionId} for task ${input.taskId}`);
    // Render the worker preamble through the task owner's prompt overrides (else file defaults). The
    // rawPrompt path (Pilot/Overseer/Advisor) is rendered by its own caller, so this only affects workers.
    const prompts = this.d.prompts;
    const renderPrompt = prompts ? (name: string, vars?: Record<string, string>) => prompts.render(name, vars, input.ownerId) : undefined;
    const command = buildAgentCommand(input.spec, {
      projectPath: input.projectPath, taskId: input.taskId, agentName: input.agentName,
      taskTitle: input.taskTitle, taskDescription: input.taskDescription, resumeNote: input.resumeNote,
      closeCommand, epicId: input.epicId, epicCloseCommand, cli, env, bin: provider?.bin, extraArgs: provider?.args,
      skipPermissions: provider?.skipPermissions, rawPrompt: input.rawPrompt, resume, mcpUrl: input.mcpUrl,
    }, renderPrompt);
    await this.d.tmux.spawn(session, { cwd: input.projectPath, command });
    // Explicit spawn record: captures pilot/overseer launches too (they have no task row, so the
    // bus 'task → in_progress' activity line never covers them).
    log.info(`spawned ${session} (${input.spec.program}/${input.spec.model}) for task ${input.taskId}`);
    // OpenCode boots an interactive TUI that holds the --prompt in its composer without
    // submitting it; nudge Enter a few times after the UI mounts to send the task.
    // (Enter on an empty composer is a no-op, so whichever press lands first submits and
    // the rest are harmless.) Timers are unref'd so they never keep tests/process alive.
    if (input.spec.program.startsWith('opencode')) {
      for (const delay of [4000, 8000, 13000]) {
        setTimeout(() => { void this.d.tmux.sendKeys(session, ['Enter']).catch(() => {}); }, delay).unref();
      }
    }
    return { session };
  }
}
