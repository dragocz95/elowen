import { render, type PromptVars } from '../prompts/index.js';
import { resumeProviderFor, type PendingResume } from './resume/index.js';
import { codexMcpArgs } from '../advisor/mcpConfig.js';

/** How worker preamble templates are rendered. Defaults to the file `render`; the spawn layer passes a
 *  user-aware renderer (resolves the task owner's prompt overrides) so an agent runs the right prompts. */
export type RenderPrompt = (name: string, vars?: PromptVars) => string;

export interface AgentSpec { program: string; model: string }
export interface SpawnCtx {
  projectPath: string;
  taskId: string;
  agentName: string;
  /** Task title + details, injected into the agent prompt so it knows what to do. */
  taskTitle?: string;
  taskDescription?: string;
  /** Transient input for THIS run — a review-reject rationale, or a stuck/manual relaunch reason —
   *  rendered as its own block in the prompt so the agent addresses it (distinct from the static task
   *  details). Empty/unset on a clean first run. */
  resumeNote?: string;
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
  /** Resume a prior CLI session for this task instead of cold-starting: the agent reattaches to its
   *  previous conversation (full context) and continues. Set by the spawn layer once it has confirmed
   *  the session's program still matches and the provider allows resume. When present, the prompt is a
   *  short continuation (worker-resume) rather than the full worker preamble. */
  resume?: PendingResume;
  /** When set, the spawned CLI is wired to Orca's MCP server at this URL. claude/opencode are wired by
   *  the config file `writeMcpConfig` drops into cwd; codex (which ignores project-local config) gets
   *  `-c mcp_servers.orca.*` launch flags here. Set only for the advisor spawn; unset for workers. */
  mcpUrl?: string;
}

const esc = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export function buildAgentCommand(spec: AgentSpec, ctx: SpawnCtx, renderPrompt: RenderPrompt = render): string {
  // A reasoning agent (Pilot/Overseer) carries its own complete prompt and never closes a task, so
  // it bypasses the worker preamble entirely. Returning early keeps that path obvious.
  if (ctx.rawPrompt !== undefined) {
    return buildLaunchCommand(spec, ctx, ctx.rawPrompt);
  }
  const closeCommand = ctx.closeCommand ?? `orca close ${ctx.taskId}`;
  const titlePart = ctx.taskTitle ? `: ${ctx.taskTitle}` : '';
  const detailsPart = ctx.taskDescription && ctx.taskDescription.trim() ? `\n\nDetails:\n${ctx.taskDescription.trim()}` : '';
  // A relaunch carries fresh input the agent must address (review feedback, a stuck/manual restart
  // reason). Render it as its own block — separate from the static task details — so it reads as "new
  // this run", not as part of the original brief. Empty on a clean first run.
  const resumePart = ctx.resumeNote && ctx.resumeNote.trim() ? `\n\nNew input for this run — address it:\n${ctx.resumeNote.trim()}` : '';
  // A resumed agent reattaches to its prior session — it already holds the full goal and what it did,
  // so re-injecting the whole worker preamble would make it restart from scratch. Send a short
  // continuation instead: pick up where it left off, fold in any new input, then close.
  // A phase agent (epicId, not resumed) must NOT redo earlier phases — the phase template carries the
  // "build on prior phases" framing the standalone one lacks.
  let prompt = ctx.resume
    ? renderPrompt('worker-resume', { agentName: ctx.agentName, taskId: ctx.taskId, titlePart, detailsPart, resumePart, closeCommand })
    : ctx.epicId
      ? renderPrompt('worker-phase', { agentName: ctx.agentName, taskId: ctx.taskId, titlePart, detailsPart, resumePart, epicId: ctx.epicId, closeCommand, cli: ctx.cli ?? 'orca' })
      : renderPrompt('worker', { agentName: ctx.agentName, taskId: ctx.taskId, titlePart, detailsPart, resumePart, closeCommand });
  if (ctx.epicId && ctx.epicCloseCommand) {
    // The agent owns mission completion: after closing its own phase, if it was the last
    // one, it closes the epic itself and writes the overall result summary.
    prompt += `\n\n${renderPrompt('worker-epic-close', { epicId: ctx.epicId, cli: ctx.cli ?? 'orca', epicCloseCommand: ctx.epicCloseCommand })}`;
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
  // Resume splice: a 'subcommand' (codex `resume <id>`) must precede the bypass flag; a 'flag'
  // (claude `-r <id>`, opencode `-s <id>`) follows it, alongside --model. The leading tokens are our
  // own literal flags/subcommand (safe); only the trailing session id is dynamic, so escape just that
  // one (mirrors `--model ${esc(model)}`: the flag is literal, the value is quoted).
  const plan = ctx.resume ? (resumeProviderFor(spec.program)?.resumeArgs(ctx.resume.sessionId) ?? null) : null;
  const resumeStr = plan ? ' ' + plan.args.map((a, i) => i === plan.args.length - 1 ? esc(a) : a).join(' ') : '';
  const resumeBefore = plan?.placement === 'subcommand' ? resumeStr : '';
  const resumeAfter = plan?.placement === 'flag' ? resumeStr : '';
  if (spec.program.startsWith('opencode')) {
    const bin = ctx.bin || 'opencode';
    // Launch the interactive TUI (UI mode) with the task preloaded into the composer
    // via --prompt. The TUI holds the prompt but does not auto-submit it, so SpawnService
    // nudges Enter a few times once the UI has mounted (Enter on an empty composer is a
    // harmless no-op, so the extra presses are safe). The TUI has no skip-permissions flag (that
    // lives on `opencode run`), so the bypass is delivered as a merged config via env:
    // OPENCODE_CONFIG_CONTENT sets permission "*" → allow without writing any file into the repo.
    const yolo = skip ? `export OPENCODE_CONFIG_CONTENT=${esc('{"permission":"allow"}')} && ` : '';
    // opencode bypasses via the yolo env, not a flag, so both placements land after the binary.
    return `${cd} && ${envExport}${yolo}${bin}${resumeBefore}${resumeAfter} --model ${esc(spec.model)}${extra} --prompt ${esc(prompt)}`;
  }
  if (spec.program.startsWith('codex')) {
    const bin = ctx.bin || 'codex';
    // Positional prompt + autonomous approval bypass (codex's skip-permissions equivalent).
    const bypass = skip ? ' --dangerously-bypass-approvals-and-sandbox' : '';
    // Codex ignores any project-local config, so its orca MCP server is injected via `-c` overrides
    // (token read from the exported ORCA_TOKEN env, not the command line). codexMcpArgs alternates
    // [flag, value, …]; the `-c` flags are our own literals, only the values are dynamic — quote just
    // those (mirrors `--model ${esc(model)}`), so an odd-charactered URL can't break the shell.
    const mcp = ctx.mcpUrl ? ' ' + codexMcpArgs(spec.program, ctx.mcpUrl).map((a, i) => i % 2 === 0 ? a : esc(a)).join(' ') : '';
    return `${cd} && ${envExport}${bin}${resumeBefore}${bypass}${resumeAfter}${mcp} --model ${esc(spec.model)}${extra} ${esc(prompt)}`;
  }
  if (spec.program === 'kilo') {
    const bin = ctx.bin || 'kilo';
    // Kilo Code (7.x) interactive TUI: the task is delivered via `--prompt` (a positional arg is the
    // project path, not the prompt), `--model provider/model` selects the model on a configured
    // provider, and resume (`--session <id>`) is a 'flag'. Kilo 7.x has no skip-permissions flag —
    // tool auto-approval lives in the user's kilo config (`permission: { bash: "allow", … }`), so
    // `skip` has no effect here (the Providers toggle is a no-op for kilo, same as pi/omp).
    return `${cd} && ${envExport}${bin}${resumeBefore}${resumeAfter} --model ${esc(spec.model)}${extra} --prompt ${esc(prompt)}`;
  }
  if (spec.program === 'pi') {
    const bin = ctx.bin || 'pi';
    // Pi interactive TUI: positional prompt seeds and submits the conversation. Pi has no
    // skip-permissions flag — its built-in tools run without confirmation — so `skip` has no effect
    // here (the Providers toggle is a no-op for pi). Resume (`--session <id>`) is a 'flag'.
    return `${cd} && ${envExport}${bin}${resumeBefore}${resumeAfter} --model ${esc(spec.model)}${extra} ${esc(prompt)}`;
  }
  if (spec.program === 'omp') {
    const bin = ctx.bin || 'omp';
    // oh-my-pi interactive TUI: positional prompt seeds and submits; `--auto-approve` skips all tool
    // approval prompts (its skip-permissions equivalent). Resume (`--resume <id>`) is a 'flag'. Note:
    // omp runs on the Bun runtime, so `bun` must be on the daemon's PATH for the bin to start.
    const bypass = skip ? ' --auto-approve' : '';
    return `${cd} && ${envExport}${bin}${resumeBefore}${bypass}${resumeAfter} --model ${esc(spec.model)}${extra} ${esc(prompt)}`;
  }
  const bin = ctx.bin || 'claude';
  // Autonomous approval bypass: orca-spawned agents run unattended in a tmux pane, so an
  // interactive permission prompt would hang the whole mission.
  const bypass = skip ? ' --dangerously-skip-permissions' : '';
  return `${cd} && ${envExport}${bin}${resumeBefore}${bypass}${resumeAfter} --model ${esc(spec.model)}${extra} ${esc(prompt)}`;
}
