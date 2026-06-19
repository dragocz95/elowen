import type { TmuxDriver } from '../tmux/types.js';
import type { AgentStore } from '../store/agentStore.js';
import { buildAgentCommand, type AgentSpec } from './commandBuilder.js';

/** How a spawned agent reaches back to the daemon to close its task. */
export interface OrcaCliConfig { cliPath: string; url: string; token: string }
/** Per-program binary override + extra args (configured in Settings → Providers). */
export type ProviderResolver = (program: string) => { bin?: string; args?: string } | undefined;

export class SpawnService {
  constructor(private d: { tmux: TmuxDriver; agents: AgentStore; orca?: OrcaCliConfig; providers?: ProviderResolver }) {}
  async launch(input: { projectId: number; projectPath: string; taskId: string; agentName: string; spec: AgentSpec; taskTitle?: string; taskDescription?: string; epicId?: string }): Promise<{ session: string }> {
    this.d.agents.upsert({ project_id: input.projectId, name: input.agentName, program: input.spec.program, model: input.spec.model });
    const session = `orca-${input.agentName}`;
    const orca = this.d.orca;
    const closeCommand = orca ? `node ${orca.cliPath} close ${input.taskId}` : undefined;
    // A phase agent gets a close command for its parent epic too, so the final phase can
    // close the epic itself with its own overall result summary.
    const epicCloseCommand = orca && input.epicId ? `node ${orca.cliPath} close ${input.epicId}` : undefined;
    const env = orca ? { ORCA_URL: orca.url, ORCA_TOKEN: orca.token } : undefined;
    const provider = this.d.providers?.(input.spec.program);
    const command = buildAgentCommand(input.spec, {
      projectPath: input.projectPath, taskId: input.taskId, agentName: input.agentName,
      taskTitle: input.taskTitle, taskDescription: input.taskDescription,
      closeCommand, epicId: input.epicId, epicCloseCommand, env, bin: provider?.bin, extraArgs: provider?.args,
    });
    await this.d.tmux.spawn(session, { cwd: input.projectPath, command });
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
