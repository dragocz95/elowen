import { render } from '../prompts/index.js';

export interface AgentSpec { program: string; model: string }
export interface SpawnCtx {
  projectPath: string;
  taskId: string;
  agentName: string;
  /** Task title + details, injected into the agent prompt so it knows what to do. */
  taskTitle?: string;
  taskDescription?: string;
  /** Shell command the agent runs to close its task when done. Defaults to `orca close <id>`. */
  closeCommand?: string;
  /** The parent epic's id, when this task is a mission phase. Lets the final-phase agent close the epic itself. */
  epicId?: string;
  /** Shell command the agent runs to close the parent epic (mirrors closeCommand but targets the epic). */
  epicCloseCommand?: string;
  /** Env vars exported before the agent starts (e.g. ORCA_URL/ORCA_TOKEN so the close command reaches the daemon). */
  env?: Record<string, string>;
  /** Override the provider binary (e.g. an absolute path); defaults to the program's conventional name. */
  bin?: string;
  /** Extra CLI args inserted after the model flag (configured per provider in Settings). */
  extraArgs?: string;
  /** Whether to bypass the agent's interactive permission prompts (Settings → Providers, default on).
   *  Undefined means "use the built-in default" (bypass). orca agents run unattended in a tmux pane,
   *  so a prompt would hang the mission; the overseer enforces autonomy above the agent. */
  skipPermissions?: boolean;
  /** When set, used verbatim as the agent prompt instead of the assembled worker preamble. Used by
   *  reasoning agents (Pilot/Overseer) that own their own instructions and close nothing. */
  rawPrompt?: string;
  /** How the agent invokes the orca CLI for read-only verbs (e.g. `orca ls`) — the global `orca`
   *  command in production, or `node <dist/cli/index.js>` in a source checkout. Defaults to `orca`. */
  cli?: string;
}

const esc = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export function buildAgentCommand(spec: AgentSpec, ctx: SpawnCtx): string {
  // A reasoning agent (Pilot/Overseer) carries its own complete prompt and never closes a task, so
  // it bypasses the worker preamble entirely. Returning early keeps that path obvious.
  if (ctx.rawPrompt !== undefined) {
    return buildLaunchCommand(spec, ctx, ctx.rawPrompt);
  }
  const closeCommand = ctx.closeCommand ?? `orca close ${ctx.taskId}`;
  const titlePart = ctx.taskTitle ? `: ${ctx.taskTitle}` : '';
  const detailsPart = ctx.taskDescription && ctx.taskDescription.trim() ? `\n\nDetails:\n${ctx.taskDescription.trim()}` : '';
  // A phase agent must NOT redo earlier phases. Without this it sees the whole goal in its details
  // and re-implements/re-verifies everything, only gradually discovering prior phases are done.
  // The phase template carries the "build on prior phases" framing; the standalone one does not.
  let prompt = ctx.epicId
    ? render('worker-phase', { agentName: ctx.agentName, taskId: ctx.taskId, titlePart, detailsPart, epicId: ctx.epicId, closeCommand })
    : render('worker', { agentName: ctx.agentName, taskId: ctx.taskId, titlePart, detailsPart, closeCommand });
  if (ctx.epicId && ctx.epicCloseCommand) {
    // The agent owns mission completion: after closing its own phase, if it was the last
    // one, it closes the epic itself and writes the overall result summary.
    prompt += `\n\n${render('worker-epic-close', { epicId: ctx.epicId, cli: ctx.cli ?? 'orca', epicCloseCommand: ctx.epicCloseCommand })}`;
  }
  return buildLaunchCommand(spec, ctx, prompt);
}

/** Assemble the actual `cd && export … && <bin> … <prompt>` shell command for a given prompt. Shared
 *  by the worker path (assembled preamble) and the reasoning path (rawPrompt). */
function buildLaunchCommand(spec: AgentSpec, ctx: SpawnCtx, prompt: string): string {
  const cd = `cd ${esc(ctx.projectPath)}`;
  const envExport = ctx.env && Object.keys(ctx.env).length > 0
    ? Object.entries(ctx.env).map(([k, v]) => `export ${k}=${esc(v)}`).join(' && ') + ' && '
    : '';
  const extra = ctx.extraArgs && ctx.extraArgs.trim() ? ` ${ctx.extraArgs.trim()}` : '';
  // Bypass interactive permission prompts unless the operator turned it off for this provider
  // (Settings → Providers). Each agent has its own mechanism; undefined defaults to on.
  const skip = ctx.skipPermissions !== false;
  if (spec.program.startsWith('opencode')) {
    const bin = ctx.bin || 'opencode';
    // Launch the interactive TUI (UI mode) with the task preloaded into the composer
    // via --prompt. The TUI holds the prompt but does not auto-submit it, so SpawnService
    // nudges Enter a few times once the UI has mounted (Enter on an empty composer is a
    // harmless no-op, so the extra presses are safe). The TUI has no skip-permissions flag (that
    // lives on `opencode run`), so the bypass is delivered as a merged config via env:
    // OPENCODE_CONFIG_CONTENT sets permission "*" → allow without writing any file into the repo.
    const yolo = skip ? `export OPENCODE_CONFIG_CONTENT=${esc('{"permission":"allow"}')} && ` : '';
    return `${cd} && ${envExport}${yolo}${bin} --model ${spec.model}${extra} --prompt ${esc(prompt)}`;
  }
  if (spec.program.startsWith('codex')) {
    const bin = ctx.bin || 'codex';
    // Positional prompt + autonomous approval bypass (codex's skip-permissions equivalent).
    const bypass = skip ? ' --dangerously-bypass-approvals-and-sandbox' : '';
    return `${cd} && ${envExport}${bin}${bypass} --model ${spec.model}${extra} ${esc(prompt)}`;
  }
  const bin = ctx.bin || 'claude';
  // Autonomous approval bypass: orca-spawned agents run unattended in a tmux pane, so an
  // interactive permission prompt would hang the whole mission.
  const bypass = skip ? ' --dangerously-skip-permissions' : '';
  return `${cd} && ${envExport}${bin}${bypass} --model ${spec.model}${extra} ${esc(prompt)}`;
}
