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
  const prompt = [
    `You are the orca agent "${ctx.agentName}". Work on task ${ctx.taskId}${titlePart}.${detailsPart}`,
    '',
    'First read the project context (AGENTS.md, CLAUDE.md, or README) to understand conventions, then implement the task end to end. Make the actual code changes — do not just describe them. Verify your work (build/tests if relevant).',
    `When you finish, close the task with a one-sentence summary of what you did and the result, plus the outcome:`,
    `  - success: ${closeCommand} --summary "<what you did + result>" --outcome ok`,
    `  - could not complete: ${closeCommand} --summary "<what blocked you>" --outcome fail`,
  ].join('\n');
  if (spec.program.startsWith('opencode')) {
    const bin = ctx.bin || 'opencode';
    // `run` executes headless and exits when done (the interactive TUI via --prompt
    // does not reliably auto-run the prompt, leaving agents idle).
    return `${cd} && ${envExport}${bin} run --model ${spec.model}${extra} ${esc(prompt)}`;
  }
  if (spec.program.startsWith('codex')) {
    const bin = ctx.bin || 'codex';
    // Positional prompt + autonomous approval bypass (codex's skip-permissions equivalent).
    return `${cd} && ${envExport}${bin} --dangerously-bypass-approvals-and-sandbox --model ${spec.model}${extra} ${esc(prompt)}`;
  }
  const bin = ctx.bin || 'claude';
  return `${cd} && ${envExport}${bin} --model ${spec.model}${extra} ${esc(prompt)}`;
}
