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
    const tools = composeSessionTools({ kind: 'owner-chat', pluginTools: [execTool('Write')], onToolResult: (e) => seen.push(e) });
    const res = await runWithPolicy(POLICY, () => tools[0]!.execute(...callArgs({ path: '/p/a.ts' })));
    expect((res.content[0] as { text: string }).text).toBe('ran:Write');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ tool: 'Write', params: { path: '/p/a.ts' }, result: res });
  });

  it('does NOT fire for a policy-denied call (the locked no-op)', async () => {
    const seen: PluginToolResultEvent[] = [];
    const tools = composeSessionTools({ kind: 'foreign-channel', pluginTools: [execTool('Write')], onToolResult: (e) => seen.push(e) });
    const res = await runWithPolicy(POLICY, () => tools[0]!.execute(...callArgs({})), { toolPolicy: { deny: new Set(['Write']) } });
    expect((res.content[0] as { text: string }).text).toContain('not available');
    expect(seen).toHaveLength(0);
  });

  it('does NOT fire when the tool execute throws (the error propagates unchanged)', async () => {
    const seen: PluginToolResultEvent[] = [];
    const boom = execTool('Write', (async () => { throw new Error('disk full'); }) as ToolDefinition['execute']);
    const tools = composeSessionTools({ kind: 'owner-chat', pluginTools: [boom], onToolResult: (e) => seen.push(e) });
    await expect(runWithPolicy(POLICY, () => tools[0]!.execute(...callArgs({})))).rejects.toThrow('disk full');
    expect(seen).toHaveLength(0);
  });

  it('a throwing observer never fails the tool result (fail-soft)', async () => {
    const observer = vi.fn(() => { throw new Error('observer broke'); });
    const tools = composeSessionTools({ kind: 'owner-chat', pluginTools: [execTool('Write')], onToolResult: observer });
    const res = await runWithPolicy(POLICY, () => tools[0]!.execute(...callArgs({})));
    expect((res.content[0] as { text: string }).text).toBe('ran:Write');
    expect(observer).toHaveBeenCalledOnce();
  });

  it('a REJECTING async observer never fails the tool result either (the await is guarded)', async () => {
    const observer = vi.fn(async () => { await Promise.resolve(); throw new Error('async observer broke'); });
    const tools = composeSessionTools({ kind: 'owner-chat', pluginTools: [execTool('Write')], onToolResult: observer });
    const res = await runWithPolicy(POLICY, () => tools[0]!.execute(...callArgs({})));
    expect((res.content[0] as { text: string }).text).toBe('ran:Write');
    expect(observer).toHaveBeenCalledOnce();
  });

  it('the observer is AWAITED: an async hook finishes before the wrapped execute resolves', async () => {
    // Models the formatters flow: the hook rewrites the just-written "file" asynchronously; because the
    // gate awaits it, a caller reading right after the tool call must see the formatted content.
    let fileContent = '';
    const write = execTool('Write', (async () => {
      fileContent = 'const x=1';
      return { content: [{ type: 'text' as const, text: 'wrote' }], details: { ok: true } };
    }) as ToolDefinition['execute']);
    const observer = async () => {
      await new Promise((r) => setTimeout(r, 10)); // real async gap — a fire-and-forget would lose the race
      fileContent = 'const x = 1;\n';
    };
    const tools = composeSessionTools({ kind: 'owner-chat', pluginTools: [write], onToolResult: observer });
    await runWithPolicy(POLICY, () => tools[0]!.execute(...callArgs({ path: '/p/a.ts' })));
    expect(fileContent).toBe('const x = 1;\n'); // the subsequent "read" sees the formatted file
  });

  it('an observer may annotate the result (details.notes) and the annotation travels with it', async () => {
    const observer = async (e: PluginToolResultEvent) => {
      const details = (e.result as { details: Record<string, unknown> }).details;
      const notes = Array.isArray(details.notes) ? (details.notes as string[]) : (details.notes = [] as string[]);
      notes.push('formatted a.ts with prettier');
    };
    const tools = composeSessionTools({ kind: 'owner-chat', pluginTools: [execTool('Write')], onToolResult: observer });
    const res = await runWithPolicy(POLICY, () => tools[0]!.execute(...callArgs({ path: '/p/a.ts' })));
    expect((res as { details: { notes?: string[] } }).details.notes).toEqual(['formatted a.ts with prettier']);
  });

  it('composing without an observer keeps the plain gated behavior', async () => {
    const tools = composeSessionTools({ kind: 'owner-chat', pluginTools: [execTool('Write')] });
    const res = await runWithPolicy(POLICY, () => tools[0]!.execute(...callArgs({})));
    expect((res.content[0] as { text: string }).text).toBe('ran:Write');
  });
});
