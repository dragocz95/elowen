import type { TmuxDriver } from '../../../../src/tmux/types.js';
import type { PluginHostPrompts } from '../../../../src/plugins/api.js';
import type { AgentStore } from '../store/agentStore.js';
import { buildAgentCommand, type AgentSpec } from './commandBuilder.js';
import type { PendingResume } from './resume/index.js';
import { logger } from '../lib/logger.js';

const log = logger('spawn');

/** How a spawned agent reaches back to the daemon to close its task. `cli` is the full elowen
 *  invocation: the global `elowen` command in production, or `node <dist/cli/index.js>` in a checkout. */
export interface ElowenCliConfig {
  cli: string;
  url: string;
  /** The shared, task-unbound agent token. Used for launches whose id is not a task row (overseer,
   *  pilot) and whenever no per-task minting is wired (tests, embedded callers). */
  token: string;
  /** Mints/reuses the agent token bound to a REAL task, so the API can pin that worker to its own
   *  task. Returns undefined when the id is not a task (overseer/pilot/advisor launches). */
  tokenForTask?: (taskId: string) => string | undefined;
}
/** Per-program binary override + extra args + permission-bypass toggle + resume toggle (configured in
 *  Settings → Providers). `skipPermissions` and `resume` default to true at the config layer;
 *  undefined here means "use the built-in default" (bypass on / resume on). */
export type ProviderResolver = (program: string) => { bin?: string; args?: string; skipPermissions?: boolean; resume?: boolean } | undefined;

/** The subset of SpawnService.launch input a brain worker needs (no tmux/CLI concerns). */
export interface BrainWorkerLauncher {
  launch(input: { projectId: number; projectPath: string; taskId: string; agentName: string; spec: AgentSpec; taskTitle?: string; taskDescription?: string; resumeNote?: string; rawPrompt?: string; ownerId?: number | null; tddMode?: boolean }): Promise<{ session: string }>;
}

export class SpawnService {
  // `prompts` is REQUIRED here (unlike the core original): the plugin has no file-based render
  // fallback, so the host prompt service is the only preamble renderer.
  constructor(private d: { tmux: TmuxDriver; agents: AgentStore; elowen?: ElowenCliConfig; providers?: ProviderResolver; prompts: PluginHostPrompts; brainWorker?: BrainWorkerLauncher; tddMode?: () => boolean }) {}
  /** Late wiring: the brain worker is constructed after SpawnService in bootstrap (it shares the
   *  brain's config/auth built further down), so it attaches here instead of via the constructor. */
  attachBrainWorker(w: BrainWorkerLauncher): void { this.d.brainWorker = w; }
  async launch(input: { projectId: number; projectPath: string; taskId: string; agentName: string; spec: AgentSpec; taskTitle?: string; taskDescription?: string; resumeNote?: string; epicId?: string; extraEnv?: Record<string, string>; rawPrompt?: string; resume?: PendingResume; ownerId?: number | null; mcpUrl?: string; tddMode?: boolean }): Promise<{ session: string }> {
    // TDD mission mode resolves centrally HERE — one seam covers standalone, mission-phase AND embedded
    // (elowen:) workers, so every caller honors the flag without threading it itself. An explicit
    // per-call `input.tddMode` wins (future per-mission override); otherwise the global config resolver.
    const tddMode = input.tddMode ?? this.d.tddMode?.() ?? false;
    // `elowen:<provider>/<model>` execs run on the embedded brain — no binary, no tmux pane. The one
    // seam for every caller (scheduler, mission engine, session routes); task states flow identically.
    if (input.spec.program === 'elowen') {
      if (!this.d.brainWorker) throw new Error('elowen exec engine not available (brain not configured)');
      if (input.rawPrompt) throw new Error('elowen exec engine does not support pilot/overseer raw prompts');
      this.d.agents.upsert({ project_id: input.projectId, name: input.agentName, program: 'elowen', model: input.spec.model });
      return this.d.brainWorker.launch({ ...input, tddMode });
    }
    this.d.agents.upsert({ project_id: input.projectId, name: input.agentName, program: input.spec.program, model: input.spec.model });
    const session = `elowen-${input.agentName}`;
    const elowen = this.d.elowen;
    // The agent reaches the daemon through the resolved elowen CLI (`elowen` globally, or `node <path>`
    // in a checkout). Shared by the close commands and the worker preamble's read-only verbs.
    const cli = elowen ? elowen.cli : undefined;
    const closeCommand = elowen ? `${elowen.cli} close ${input.taskId}` : undefined;
    // A worker reaches back with a token minted for ITS task, so the daemon can refuse it on anyone
    // else's task; a launch whose id is no task row (overseer, pilot) keeps the shared service token.
    const tokenFor = (e: ElowenCliConfig): string => e.tokenForTask?.(input.taskId) ?? e.token;
    // Merge any caller-supplied env (e.g. ELOWEN_PLAN_JOB / ELOWEN_MISSION for reasoning agents) on top
    // of the daemon-reach env. ELOWEN_TASK lets a worker run `elowen ask` without passing its own id;
    // reasoning agents ignore it. extraEnv alone still flows through when no elowen config is present.
    const env = elowen ? { ELOWEN_URL: elowen.url, ELOWEN_TOKEN: tokenFor(elowen), ELOWEN_TASK: input.taskId, ...input.extraEnv } : input.extraEnv;
    const provider = this.d.providers?.(input.spec.program);
    // Resume only when the recorded session is for THIS spawn's program (the operator may have
    // switched the task's exec since) and the provider hasn't disabled resume. Otherwise cold start.
    const normalizedProgram = input.spec.program.startsWith('opencode') ? 'opencode' : input.spec.program;
    const resume = input.resume && input.resume.program === normalizedProgram && provider?.resume !== false
      ? input.resume : undefined;
    if (resume) log.info(`resuming ${resume.program} session ${resume.sessionId} for task ${input.taskId}`);
    // Render the worker preamble through the task owner's overrides (the host prompt service resolves
    // user override → plugin file → core file). The rawPrompt path (Pilot/Overseer) is rendered by its
    // own caller, so this only affects workers.
    const renderPrompt = (name: string, vars?: Record<string, string>) => this.d.prompts.render(name, vars, input.ownerId);
    // env is delivered as tmux session environment (`-e`, below), NOT an inline `export …` in the typed
    // command, so the agent token never enters the pane scrollback (readable via capturePane).
    const command = buildAgentCommand(input.spec, {
      projectPath: input.projectPath, taskId: input.taskId, agentName: input.agentName,
      taskTitle: input.taskTitle, taskDescription: input.taskDescription, resumeNote: input.resumeNote,
      closeCommand, epicId: input.epicId, cli, bin: provider?.bin, extraArgs: provider?.args,
      skipPermissions: provider?.skipPermissions, rawPrompt: input.rawPrompt, resume, mcpUrl: input.mcpUrl, tddMode,
    }, renderPrompt);
    try {
      await this.d.tmux.spawn(session, { cwd: input.projectPath, command, env });
    } catch (e) {
      // A tmux failure message embeds the argv INCLUDING `-e ELOWEN_TOKEN=<token>`; never let the raw
      // token escape into a thrown error or log (mirrors terminalService). Scrub it, then re-throw sanitized.
      const token = elowen ? tokenFor(elowen) : undefined;
      const reason = token ? String((e as Error)?.message ?? e).split(token).join('***') : String((e as Error)?.message ?? e);
      log.warn(`agent spawn failed for ${session} (task ${input.taskId}): ${reason}`);
      throw new Error('agent spawn failed');
    }
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
