import { describe, it, expect, vi } from 'vitest';
import { composeSessionTools, type PluginToolResultEvent } from '../../src/brain/session/capabilities.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

const POLICY = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };
const execTool = (name: string, execute?: ToolDefinition['execute']): ToolDefinition => ({
  name, label: name, description: '', parameters: {} as never,
  execute: execute ?? (async () => ({ content: [{ type: 'text' as const, text: `ran:${name}` }], details: { ok: true } })),
}) as ToolDefinition;
const callArgs = (params: unknown) => ['id', params, undefined, undefined, {} as never] as const;

describe('composeSessionTools — onToolResult observer (tools.call.after wiring)', () => {
  it('fires after a permitted plugin tool execute resolves, with tool + params + result', async () => {
    const seen: PluginToolResultEvent[] = [];
    const tools = composeSessionTools({ kind: 'owner-chat', pluginTools: [execTool('write_file')], onToolResult: (e) => seen.push(e) });
    const res = await runWithPolicy(POLICY, () => tools[0]!.execute(...callArgs({ path: '/p/a.ts' })));
    expect((res.content[0] as { text: string }).text).toBe('ran:write_file');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ tool: 'write_file', params: { path: '/p/a.ts' }, result: res });
  });

  it('does NOT fire for a policy-denied call (the locked no-op)', async () => {
    const seen: PluginToolResultEvent[] = [];
    const tools = composeSessionTools({ kind: 'foreign-channel', pluginTools: [execTool('write_file')], onToolResult: (e) => seen.push(e) });
    const res = await runWithPolicy(POLICY, () => tools[0]!.execute(...callArgs({})), { toolPolicy: { deny: new Set(['write_file']) } });
    expect((res.content[0] as { text: string }).text).toContain('not available');
    expect(seen).toHaveLength(0);
  });

  it('does NOT fire when the tool execute throws (the error propagates unchanged)', async () => {
    const seen: PluginToolResultEvent[] = [];
    const boom = execTool('write_file', (async () => { throw new Error('disk full'); }) as ToolDefinition['execute']);
    const tools = composeSessionTools({ kind: 'owner-chat', pluginTools: [boom], onToolResult: (e) => seen.push(e) });
    await expect(runWithPolicy(POLICY, () => tools[0]!.execute(...callArgs({})))).rejects.toThrow('disk full');
    expect(seen).toHaveLength(0);
  });

  it('a throwing observer never fails the tool result (fail-soft)', async () => {
    const observer = vi.fn(() => { throw new Error('observer broke'); });
    const tools = composeSessionTools({ kind: 'owner-chat', pluginTools: [execTool('write_file')], onToolResult: observer });
    const res = await runWithPolicy(POLICY, () => tools[0]!.execute(...callArgs({})));
    expect((res.content[0] as { text: string }).text).toBe('ran:write_file');
    expect(observer).toHaveBeenCalledOnce();
  });

  it('composing without an observer keeps the plain gated behavior', async () => {
    const tools = composeSessionTools({ kind: 'owner-chat', pluginTools: [execTool('write_file')] });
    const res = await runWithPolicy(POLICY, () => tools[0]!.execute(...callArgs({})));
    expect((res.content[0] as { text: string }).text).toBe('ran:write_file');
  });
});
