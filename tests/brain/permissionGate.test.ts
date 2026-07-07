import { describe, it, expect, vi } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { composeSessionTools } from '../../src/brain/session/capabilities.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { buildPermissionRuleset, sanitizePermissionSettings, type ApprovalDecision, type ApprovalRequest, type TurnPermissions } from '../../src/brain/toolPermissions.js';
import type { Policy } from '../../src/plugins/policy.js';

const POLICY: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

/** A minimal plugin tool whose execute records that it ran. */
function fakeTool(name: string): { tool: ToolDefinition; ran: () => number } {
  let runs = 0;
  const tool = {
    name, label: name, description: name, parameters: {} as never,
    execute: async (_id: string, params: unknown) => { runs++; return { content: [{ type: 'text', text: `ran ${name} ${JSON.stringify(params)}` }], details: {} }; },
  } as unknown as ToolDefinition;
  return { tool, ran: () => runs };
}

type ToolResult = { content: { type: string; text: string }[] };

function callTool(tool: ToolDefinition, params: unknown, permissions: TurnPermissions | undefined): Promise<ToolResult> {
  return runWithPolicy(POLICY, () => tool.execute('call-1', params as never, undefined, undefined, {} as never) as Promise<ToolResult>, { permissions });
}

const perms = (over: Partial<TurnPermissions> & { user?: unknown } = {}): TurnPermissions => ({
  ruleset: buildPermissionRuleset(sanitizePermissionSettings(over.user ?? {})),
  yolo: false,
  ...over,
});

const composed = (name: string) => {
  const { tool, ran } = fakeTool(name);
  const [gated] = composeSessionTools({ kind: 'owner-chat', pluginTools: [tool] });
  return { gated: gated!, ran };
};

describe('permission gate — the single tool-call choke point (composeSessionTools)', () => {
  it('no TurnPermissions scope (task workers, tests) → the gate is inert and the tool runs', async () => {
    const { gated, ran } = composed('write_file');
    const res = await callTool(gated, { path: 'x' }, undefined);
    expect(ran()).toBe(1);
    expect(res.content[0]!.text).toContain('ran write_file');
  });

  it('gates built-in (non-plugin) tools too — the orca_*/memory_* set passes the same choke point', async () => {
    const { tool, ran } = fakeTool('orca_create_task');
    const [gated] = composeSessionTools({ kind: 'owner-chat', orcaTools: () => [tool], pluginTools: [] });
    const p = perms({ user: { tools: { orca_create_task: 'deny' } } });
    const res = await callTool(gated!, {}, p);
    expect(ran()).toBe(0);
    expect(res.content[0]!.text).toContain('Denied by permission rule "orca_create_task"');
  });

  it('deny → immediate error result naming the rule, tool never runs (even under YOLO)', async () => {
    const { gated, ran } = composed('run_command');
    const p = perms({ user: { bash: { 'rm *': 'deny' } }, yolo: true });
    const res = await callTool(gated, { command: 'rm -rf /' }, p);
    expect(ran()).toBe(0);
    expect(res.content[0]!.text).toContain('Denied by permission rule "rm *"');
  });

  it('allow → runs without consulting the approval channel', async () => {
    const { gated, ran } = composed('run_command');
    const requestApproval = vi.fn();
    const p = perms({ requestApproval });
    await callTool(gated, { command: 'git status --porcelain' }, p); // default bash allow
    expect(ran()).toBe(1);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('ask + interactive: "Allow once" runs the tool without persisting anything', async () => {
    const { gated, ran } = composed('run_command');
    const persistAllow = vi.fn();
    const requestApproval = vi.fn(async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      expect(req).toMatchObject({ tool: 'run_command', scope: 'bash', command: 'npm run build', alwaysPattern: 'npm run build*' });
      return 'once';
    });
    await callTool(gated, { command: 'npm run build' }, perms({ requestApproval, persistAllow }));
    expect(ran()).toBe(1);
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(persistAllow).not.toHaveBeenCalled();
  });

  it('ask + interactive: "Always allow" persists the suggested pattern, then runs', async () => {
    const { gated, ran } = composed('write_file');
    const persistAllow = vi.fn();
    const requestApproval = vi.fn(async (): Promise<ApprovalDecision> => 'always');
    await callTool(gated, { path: 'a.txt' }, perms({ requestApproval, persistAllow }));
    expect(ran()).toBe(1);
    expect(persistAllow).toHaveBeenCalledWith('tools', 'write_file');
  });

  it('ask + interactive: "Deny" returns a refusal result and the tool never runs', async () => {
    const { gated, ran } = composed('run_command');
    const requestApproval = vi.fn(async (): Promise<ApprovalDecision> => 'deny');
    const res = await callTool(gated, { command: 'rm -rf x' }, perms({ requestApproval }));
    expect(ran()).toBe(0);
    expect(res.content[0]!.text).toContain('denied running "run_command" (rm -rf x)');
  });

  it('a cancelled approval prompt (rejected elicitation) fails closed to deny', async () => {
    const { gated, ran } = composed('write_file');
    const requestApproval = vi.fn(async (): Promise<ApprovalDecision> => { throw new Error('aborted'); });
    const res = await callTool(gated, {}, perms({ requestApproval }));
    expect(ran()).toBe(0);
    expect(res.content[0]!.text).toContain('denied');
  });

  it('YOLO: ask resolves to allow without prompting', async () => {
    const { gated, ran } = composed('run_command');
    const requestApproval = vi.fn();
    await callTool(gated, { command: 'rm -rf x' }, perms({ yolo: true, requestApproval }));
    expect(ran()).toBe(1);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('non-interactive (channel/cron/subagent — no approval channel): ask resolves to allow, deny still denies', async () => {
    const { gated, ran } = composed('run_command');
    // ask → allow (no requestApproval wired)
    await callTool(gated, { command: 'rm -rf x' }, perms());
    expect(ran()).toBe(1);
    // deny still bites
    const res = await callTool(gated, { command: 'rm -rf x' }, perms({ user: { bash: { 'rm *': 'deny' } } }));
    expect(ran()).toBe(1);
    expect(res.content[0]!.text).toContain('Denied by permission rule');
  });
});
