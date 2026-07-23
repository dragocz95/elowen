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
      return 'child done';
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

  it('flags read_only as the host-side read-only MODE, not a plugin toolset', async () => {
    // The plugin no longer materializes a read-only allow-list; it forwards the mode and the host applies
    // the READ_ONLY_AGENT_TOOLS preset + minted boundary (so the child gets read-only shell too).
    const res = await delegate({ task: 'find every caller of X', read_only: true });
    expect(res.content[0].text).toBe('child done');
    expect(seen.access?.readOnly).toBe(true);
    expect(seen.access?.toolPolicy).toBeUndefined(); // no plugin-side allow-list; the host mints it
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
});
