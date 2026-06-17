export interface AgentSpec { program: string; model: string }
export interface SpawnCtx { projectPath: string; taskId: string; agentName: string }

const esc = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export function buildAgentCommand(spec: AgentSpec, ctx: SpawnCtx): string {
  const cd = `cd ${esc(ctx.projectPath)}`;
  const prompt = `You are an orca agent. Work task ${ctx.taskId}. Close it with 'jt close ${ctx.taskId}' when done.`;
  if (spec.program.startsWith('opencode')) {
    return `${cd} && opencode --model ${spec.model} --prompt ${esc(prompt)}`;
  }
  if (spec.program.startsWith('codex')) {
    // Positional prompt + autonomous approval bypass (codex's skip-permissions equivalent).
    return `${cd} && codex --dangerously-bypass-approvals-and-sandbox --model ${spec.model} ${esc(prompt)}`;
  }
  const initial = `/jat:start ${ctx.agentName} ${ctx.taskId}`;
  return `${cd} && claude --model ${spec.model} ${esc(initial)}`;
}
