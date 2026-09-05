import { describe, it, expect, beforeAll } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy, type ToolPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };

const mod = await import(resolve(repoRoot, 'plugins/subagent/index.mjs')) as {
  resolveDelegateTools(
    inheritedAllow: string[] | undefined,
    requested: string[] | undefined,
    available: string[],
  ): { allow?: string[]; error?: string };
};

const AVAILABLE = ['Read', 'Search', 'ListDir', 'FileInfo', 'GitStatus', 'CodebaseSearch',
  'CodebaseStatus', 'Write', 'Edit', 'Bash', 'Delegate', 'KillProcess'];

// `resolveDelegateTools` resolves ONLY an explicit `tools` list now — `read_only` moved host-side (it
// selects the read-only MODE: preset toolset + minted boundary). The invariant that must never break is that
// an explicit toolset can ONLY narrow what the caller holds.
describe('resolveDelegateTools', () => {
  it('leaves the child unrestricted when no tools list is given', () => {
    expect(mod.resolveDelegateTools(undefined, undefined, AVAILABLE)).toEqual({ allow: undefined });
  });

  it('an explicit tools list becomes the child\'s exact toolset', () => {
    expect(mod.resolveDelegateTools(undefined, ['Read', 'Search'], AVAILABLE))
      .toEqual({ allow: ['Read', 'Search'] });
  });

  it('deduplicates and trims a sloppy tools list', () => {
    expect(mod.resolveDelegateTools(undefined, [' Read ', 'Read', ''], AVAILABLE))
      .toEqual({ allow: ['Read'] });
  });

  it('rejects unknown tool names instead of silently granting a narrower set', () => {
    // A typo must not quietly become "the child gets nothing useful and nobody knows why".
    const res = mod.resolveDelegateTools(undefined, ['Read', 'raed_file'], AVAILABLE);
    expect(res.allow).toBeUndefined();
    expect(res.error).toMatch(/unknown tool\(s\): raed_file/);
  });

  it('rejects an explicitly EMPTY tools list rather than reading it as "no restriction"', () => {
    // The dangerous inversion: a model that means "give it nothing" would otherwise get "give it everything".
    const res = mod.resolveDelegateTools(undefined, [], AVAILABLE);
    expect(res.allow).toBeUndefined();
    expect(res.error).toMatch(/`tools` was empty/);
  });

  describe('can only ever narrow', () => {
    it('refuses to hand over a tool the caller does not hold — loudly, not by silently dropping it', () => {
      // Silently dropping Bash would spawn a child that mysteriously cannot do its job.
      const res = mod.resolveDelegateTools(['Read', 'ListDir'], ['Read', 'Bash'], AVAILABLE);
      expect(res.allow).toBeUndefined();
      expect(res.error).toMatch(/you do not have Bash yourself/);
    });

    it('a read-only caller cannot mint a writing child', () => {
      const res = mod.resolveDelegateTools(['Read', 'Search'], ['Write', 'Read'], AVAILABLE);
      expect(res.allow).toBeUndefined();
      expect(res.error).toMatch(/you do not have Write yourself/);
    });

    // The caller's inherited list is a PATTERN list: `users.allowed_tools` defaults to the `*` marker, so
    // before the grant migration runs every non-admin holds literally `['*']`, and an MCP family can only
    // ever be named `mcp__*`. Matching membership exactly told those callers they did not hold tools they
    // were plainly running, and refused every explicit `tools:` delegation they made.
    it('measures what the caller holds by the same covers rule the host uses', () => {
      expect(mod.resolveDelegateTools(['*'], ['Read', 'Bash'], AVAILABLE))
        .toEqual({ allow: ['Read', 'Bash'] });
      expect(mod.resolveDelegateTools(['Read', 'mcp__*'], ['Read', 'mcp__github__issue'], [...AVAILABLE, 'mcp__github__issue']))
        .toEqual({ allow: ['Read', 'mcp__github__issue'] });
      // Still a narrowing: a name no pattern of the caller's covers is refused exactly as before.
      expect(mod.resolveDelegateTools(['mcp__*'], ['Bash'], AVAILABLE).error).toMatch(/you do not have Bash yourself/);
    });

    it('a restricted caller may still narrow WITHIN what it holds', () => {
      const { allow } = mod.resolveDelegateTools(['Read', 'ListDir', 'Search'], ['Read', 'ListDir'], AVAILABLE);
      expect(allow).toEqual(['Read', 'ListDir']);
    });
  });
});

// The end of the wire: whatever the child is actually launched with. This is the assertion that matters —
// the narrowed policy has to reach the host as part of the delegated access, or the restriction is theatre.
describe('delegate — the access handed to the child', () => {
  let reg: PluginRegistry;
  let seen: { access?: Record<string, unknown> };
  /** What the stand-in child answers. Mutable so one test can hand back an oversized report. */
  let childReply = 'child done';

  beforeAll(async () => {
    reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['subagent', 'files', 'terminal'], logger: log,
      subagentTypes: () => [{ name: 'explore', description: 'read-only explore' }],
    });
    seen = {};
    // Stand in for the host's channel handler: capture the source the plugin would spawn the child with.
    const platform = reg.platforms.find((p) => p.name === 'subagent')!;
    platform.listen(async (src: { access?: Record<string, unknown> }) => {
      seen.access = src.access;
      return childReply;
    });
  });

  const delegate = (params: Record<string, unknown>, toolPolicy?: ToolPolicy) => {
    const tool = reg.tools.find((t) => t.name === 'Delegate')!;
    return runWithPolicy(
      adminPolicy,
      () => (tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> }).execute('call', params),
      { identity: owner, sessionId: 'brain-1', toolPolicy },
    );
  };

  it('sends no tool restriction when none was asked for', async () => {
    await delegate({ task: 'look around' });
    expect(seen.access?.toolPolicy).toBeUndefined();
  });

  it('inherits the delegating turn\'s working directory and reasoning effort by default', async () => {
    // The child must run in the SAME project the parent runs in (not the daemon's `/`) and think just as
    // hard by default — both are read off the parent turn scope (currentWorkDir / currentModel).
    const tool = reg.tools.find((t) => t.name === 'Delegate')!;
    await runWithPolicy(
      adminPolicy,
      () => (tool as unknown as { execute: (id: string, p: unknown) => Promise<unknown> }).execute('call', { task: 'inherit' }),
      { identity: owner, sessionId: 'brain-1', workDir: '/var/www/project', model: { provider: 'anthropic', model: 'claude-opus', thinkingLevel: 'high' } },
    );
    expect(seen.access?.cwd).toBe('/var/www/project');
    expect(seen.access?.thinkingLevel).toBe('high');
  });

  it('omits cwd and reasoning effort when the parent turn carries none', async () => {
    await delegate({ task: 'no inheritance' });
    expect(seen.access?.cwd).toBeUndefined();
    expect(seen.access?.thinkingLevel).toBeUndefined();
  });

  it('publishes workspaceId and forwards an explicit assignment without inheriting host cwd', async () => {
    const definition = reg.tools.find((tool) => tool.name === 'Delegate') as unknown as {
      parameters: { properties: Record<string, unknown> };
    };
    expect(definition.parameters.properties).toHaveProperty('workspaceId');
    const tool = reg.tools.find((candidate) => candidate.name === 'Delegate')!;
    await runWithPolicy(adminPolicy, () => (tool as unknown as { execute(id: string, p: unknown): Promise<unknown> })
      .execute('call', { task: 'scoped', workspaceId: 'ws_explicit' }), {
      identity: owner, sessionId: 'brain-1', workDir: '/var/www/project', contributionUserId: 1,
    });
    expect(seen.access?.workspaceId).toBe('ws_explicit');
    expect(seen.access?.cwd).toBeUndefined();
  });

  it('inherits only an already explicit workspace scope for nested delegation', async () => {
    const tool = reg.tools.find((candidate) => candidate.name === 'Delegate')!;
    await runWithPolicy(adminPolicy, () => (tool as unknown as { execute(id: string, p: unknown): Promise<unknown> })
      .execute('call', { task: 'nested' }), {
      identity: owner, sessionId: 'brain-child', contributionUserId: 1, workDir: '/host/ws',
      pathView: {
        kind: 'workspace', workspace: { workspaceId: 'ws_parent', projectId: 3 }, root: '/host/ws',
        resolve: (path: string) => path, display: (path: string) => path, stateKey: (path: string) => path,
        sanitize: (text: string) => text,
      },
    });
    expect(seen.access?.workspaceRef).toEqual({ workspaceId: 'ws_parent', projectId: 3 });
    expect(seen.access?.workspaceId).toBeUndefined();
    expect(seen.access?.cwd).toBeUndefined();
  });

  it('flags read_only as the host-side read-only MODE, not a plugin toolset', async () => {
    // The plugin no longer materializes a read-only allow-list; it forwards the mode and the host applies
    // the READ_ONLY_AGENT_TOOLS preset + minted boundary (so the child gets read-only shell too).
    const res = await delegate({ task: 'find every caller of X', read_only: true });
    expect(res.content[0].text).toBe('child done');
    expect(seen.access?.readOnly).toBe(true);
    expect(seen.access?.toolPolicy).toBeUndefined(); // no plugin-side allow-list; the host mints it
  });

  // Plan mode may delegate exploration, but a planning turn must never spawn a child that can write.
  // The flag is stamped by the host on currentAccess(), so the model cannot decline it: the plugin only
  // ever ADDS read_only from its own argument and has no path that clears it.
  it('forces read-only on every delegation made from a PLANNING turn', async () => {
    const tool = reg.tools.find((t) => t.name === 'Delegate')!;
    await runWithPolicy(
      adminPolicy,
      () => (tool as unknown as { execute: (id: string, p: unknown) => Promise<unknown> }).execute('call', { task: 'explore for the plan' }),
      { identity: owner, sessionId: 'brain-1', mode: 'plan' },
    );
    expect(seen.access?.readOnly).toBe(true);
  });

  it('leaves a BUILD turn free to delegate a writing child', async () => {
    const tool = reg.tools.find((t) => t.name === 'Delegate')!;
    await runWithPolicy(
      adminPolicy,
      () => (tool as unknown as { execute: (id: string, p: unknown) => Promise<unknown> }).execute('call', { task: 'implement it' }),
      { identity: owner, sessionId: 'brain-1', mode: 'build' },
    );
    expect(seen.access?.readOnly).toBeUndefined();
  });

  it('sends an exact tools allow-list', async () => {
    await delegate({ task: 'read the auth module', tools: ['Read', 'ListDir'] });
    expect(seen.access?.toolPolicy).toEqual({ allow: ['Read', 'ListDir'] });
  });

  it('carries the caller\'s deny-list through untouched', async () => {
    await delegate({ task: 'explore' }, { deny: new Set(['Bash']) });
    expect(seen.access?.toolPolicy).toEqual({ deny: ['Bash'] });

    // read_only rides as the mode flag; the parent deny survives on the toolPolicy for the host to keep.
    await delegate({ task: 'explore', read_only: true }, { deny: new Set(['GitStatus']) });
    expect(seen.access?.readOnly).toBe(true);
    expect(seen.access?.toolPolicy).toEqual({ deny: ['GitStatus'] });
  });

  it('refuses an unknown tool name and never spawns the child', async () => {
    seen.access = undefined;
    const res = await delegate({ task: 'go', tools: ['reed_file'] });
    expect(res.content[0].text).toMatch(/unknown tool\(s\): reed_file/);
    expect(seen.access).toBeUndefined(); // the child was never started
  });

  it('refuses to widen a restricted caller and never spawns the child', async () => {
    seen.access = undefined;
    const res = await delegate({ task: 'go', tools: ['Bash'] }, { allow: new Set(['Read']) });
    expect(res.content[0].text).toMatch(/you do not have Bash yourself/);
    expect(seen.access).toBeUndefined();
  });

  it('refuses an empty tools list and never spawns the child', async () => {
    seen.access = undefined;
    const res = await delegate({ task: 'go', tools: [] });
    expect(res.content[0].text).toMatch(/`tools` was empty/);
    expect(seen.access).toBeUndefined();
  });

  // A typed sub-agent gets its toolset from the HOST (from the type's own preset, which for a read-only type
  // includes read-only shell). The plugin forwards the type (and read_only as a mode flag) and clamps
  // nothing — the host resolves both into one read-only definition.
  it('forwards the type and does not clamp the toolset when a redundant read_only rides along', async () => {
    seen.access = undefined;
    await delegate({ task: 'find every caller of X', subagent_type: 'explore', read_only: true });
    expect(seen.access?.agentType).toBe('explore');
    expect(seen.access?.readOnly).toBe(true); // redundant with the read-only type, harmless — host converges them
    // No plugin-side allow-list: the host applies the type's preset (incl. Bash). read_only did NOT re-narrow.
    expect(seen.access?.toolPolicy).toBeUndefined();
    // A typed delegation carries no generic role prompt — the host supplies the type's prompt.
    expect(seen.access?.prompt).toBeUndefined();
  });

  it('still lets an explicit tools list narrow a typed sub-agent further', async () => {
    seen.access = undefined;
    await delegate({ task: 'read auth only', subagent_type: 'explore', tools: ['Read'] });
    expect(seen.access?.agentType).toBe('explore');
    expect(seen.access?.toolPolicy).toEqual({ allow: ['Read'] });
  });

  it('rejects an unknown subagent_type and never spawns the child', async () => {
    seen.access = undefined;
    const res = await delegate({ task: 'go', subagent_type: 'nope' });
    expect(res.content[0].text).toMatch(/unknown subagent_type "nope"/);
    expect(seen.access).toBeUndefined();
  });

  // The incident this exists for: a delegated report reached its parent cut short and the conclusion — the
  // last paragraph, the only part that mattered — was what got destroyed. Over the stored ceiling the parent
  // must receive the END of the report, and be told plainly how to page the rest back out of the database.
  it('returns the END of an over-long child report, with the note that names DelegateRead', async () => {
    const conclusion = 'CONCLUSION: the retry backoff is the root cause.';
    childReply = `OPENING: how I looked.\n${'x'.repeat(120_000)}\n${conclusion}`;
    try {
      const text = (await delegate({ task: 'write a very long report' })).content[0].text;
      expect(text.endsWith(conclusion)).toBe(true);
      expect(childReply.endsWith(text.replace(/^\[truncated:[^\]]*\]\n/, ''))).toBe(true);
      expect(text).not.toContain('OPENING: how I looked.');
      expect(text).toMatch(/^\[truncated: first \d+ chars dropped, end kept — read it in full with DelegateRead\]\n/);
      expect(text.length).toBeLessThanOrEqual(100_000);
    } finally {
      childReply = 'child done';
    }
  });
});

describe('Delegate — a child that delegates further', () => {
  // The wait itself is the host's (BrainService.settleDelegatedReply): the `run` handle resolves only once
  // the child has no delegation of its own open, so the plugin has NO loop and no collect reminder — it
  // takes whatever the settled handle returns as the answer. What the plugin owns is what the call's
  // progress row says meanwhile and that the wait never reads as a stall.
  async function loadDelegate(runHandle: (source: unknown, text: string, onEvent?: (event: Record<string, unknown>) => void) => Promise<string>) {
    const emitted: Record<string, unknown>[] = [];
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], logger: log,
      delegatedChildren: {
        runs: () => [], read: () => 'not used',
        continue: async () => ({ status: 'reply', reply: 'not used' }),
        stop: async () => ({ stopped: false }),
      },
    });
    const platform = reg.platforms.find((candidate) => candidate.name === 'subagent')!;
    platform.listen(runHandle);
    const tool = reg.tools.find((candidate) => candidate.name === 'Delegate')!;
    const result = await runWithPolicy(
      adminPolicy,
      () => (tool as unknown as { execute(id: string, params: unknown): Promise<{ content: { text: string }[] }> })
        .execute('call-parent', { task: 'audit and implement everything' }),
      { identity: owner, sessionId: 'brain-1', emitSubagent: ((update: Record<string, unknown>) => { emitted.push(update); return true; }) as never },
    );
    return { result, emitted };
  }

  it('takes the settled handle\'s answer as the result, with no collect loop of its own', async () => {
    let turns = 0;
    const { result } = await loadDelegate(async (_source, _text, onEvent) => {
      turns += 1;
      onEvent?.({ type: 'session', sessionId: 'brain-ch-subagent-sub-parent' });
      onEvent?.({ type: 'subagent', id: 'gc', sessionId: 'brain-ch-subagent-sub-grandchild', status: 'running' });
      // The host held the call open across the grandchild and the child's follow-up turn; this is that answer.
      return 'all four audits integrated and fixed';
    });
    expect(result.content[0]?.text).toBe('all four audits integrated and fixed');
    expect(turns).toBe(1);
  });

  it('reports the child as waiting for its own sub-agent on the progress row the host republishes', async () => {
    const { emitted } = await loadDelegate(async (_source, _text, onEvent) => {
      onEvent?.({ type: 'session', sessionId: 'brain-ch-subagent-sub-parent' });
      onEvent?.({ type: 'tool', name: 'Read', detail: 'x.ts' });
      onEvent?.({ type: 'subagent', id: 'gc', sessionId: 'brain-ch-subagent-sub-grandchild', status: 'running' });
      return 'done';
    });
    const details = emitted.map((update) => update.detail);
    expect(details).toContain('Read x.ts');
    expect(details).toContain('waiting for its own sub-agent sub-grandchild');
    // The wait replaces the tool detail in order: the row said "Read x.ts" first and "waiting" after.
    expect(details.indexOf('Read x.ts')).toBeLessThan(details.indexOf('waiting for its own sub-agent sub-grandchild'));
  });
});
