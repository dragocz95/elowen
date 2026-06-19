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
}

const esc = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export function buildAgentCommand(spec: AgentSpec, ctx: SpawnCtx): string {
  const cd = `cd ${esc(ctx.projectPath)}`;
  const closeCommand = ctx.closeCommand ?? `orca close ${ctx.taskId}`;
  const envExport = ctx.env && Object.keys(ctx.env).length > 0
    ? Object.entries(ctx.env).map(([k, v]) => `export ${k}=${esc(v)}`).join(' && ') + ' && '
    : '';
  const extra = ctx.extraArgs && ctx.extraArgs.trim() ? ` ${ctx.extraArgs.trim()}` : '';
  const titlePart = ctx.taskTitle ? `: ${ctx.taskTitle}` : '';
  const detailsPart = ctx.taskDescription && ctx.taskDescription.trim() ? `\n\nDetails:\n${ctx.taskDescription.trim()}` : '';
  const lines = [
    `You are the orca agent "${ctx.agentName}". Work on task ${ctx.taskId}${titlePart}.${detailsPart}`,
    '',
    'First read the project context (AGENTS.md, CLAUDE.md, or README) to understand conventions, then implement the task end to end. Make the actual code changes — do not just describe them. Verify your work (build/tests if relevant).',
    `When you finish, close the task with a one-sentence summary of what you did and the result, plus the outcome:`,
    `  - success: ${closeCommand} --summary "<what you did + result>" --outcome ok`,
    `  - could not complete: ${closeCommand} --summary "<what blocked you>" --outcome fail`,
  ];
  if (ctx.epicId && ctx.epicCloseCommand) {
    // The agent owns mission completion: after closing its own phase, if it was the last
    // one, it closes the epic itself and writes the overall result summary.
    lines.push(
      '',
      `This task is a phase of epic ${ctx.epicId}. After you close your own task, run \`orca ls\` to check the epic's other phases. If every other phase of this epic is already closed (i.e. you were the final phase), close the epic yourself and write your own summary of the whole mission — what was done across all phases and anything still left to do:`,
      `  ${ctx.epicCloseCommand} --summary "<overall mission result: what happened + what's left>" --outcome ok`,
      `If any sibling phase is still open or in progress, do NOT touch the epic — that agent will handle it.`,
    );
  }
  const prompt = lines.join('\n');
  if (spec.program.startsWith('opencode')) {
    const bin = ctx.bin || 'opencode';
    // Launch the interactive TUI (UI mode) with the task preloaded into the composer
    // via --prompt. The TUI holds the prompt but does not auto-submit it, so SpawnService
    // nudges Enter a few times once the UI has mounted (Enter on an empty composer is a
    // harmless no-op, so the extra presses are safe).
    return `${cd} && ${envExport}${bin} --model ${spec.model}${extra} --prompt ${esc(prompt)}`;
  }
  if (spec.program.startsWith('codex')) {
    const bin = ctx.bin || 'codex';
    // Positional prompt + autonomous approval bypass (codex's skip-permissions equivalent).
    return `${cd} && ${envExport}${bin} --dangerously-bypass-approvals-and-sandbox --model ${spec.model}${extra} ${esc(prompt)}`;
  }
  const bin = ctx.bin || 'claude';
  return `${cd} && ${envExport}${bin} --model ${spec.model}${extra} ${esc(prompt)}`;
}
