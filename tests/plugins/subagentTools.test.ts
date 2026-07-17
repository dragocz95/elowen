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
    readOnly: boolean | undefined,
    requested: string[] | undefined,
    available: string[],
  ): { allow?: string[]; error?: string };
};

const AVAILABLE = ['Read', 'Search', 'ListDir', 'FileInfo', 'GitStatus', 'CodebaseSearch',
  'CodebaseStatus', 'Write', 'Edit', 'Bash', 'Delegate', 'KillProcess'];

// A delegated child inherits the caller's execution boundary. `read_only` / `tools` narrow it — and the one
// property that must never break is that they can ONLY narrow.
describe('resolveDelegateTools', () => {
  it('leaves the child unrestricted when neither knob is used', () => {
    expect(mod.resolveDelegateTools(undefined, undefined, undefined, AVAILABLE)).toEqual({ allow: undefined });
  });

  it('read_only hands over the look-but-do-not-touch set — and nothing that writes, runs or delegates', () => {
    const { allow } = mod.resolveDelegateTools(undefined, true, undefined, AVAILABLE);
    expect(allow).toEqual(['Read', 'Search', 'ListDir', 'FileInfo', 'GitStatus', 'CodebaseSearch', 'CodebaseStatus']);
    for (const dangerous of ['Write', 'Edit', 'Bash', 'Delegate', 'KillProcess']) {
      expect(allow).not.toContain(dangerous);
    }
  });

  it('an explicit tools list becomes the child\'s exact toolset', () => {
    expect(mod.resolveDelegateTools(undefined, undefined, ['Read', 'Search'], AVAILABLE))
      .toEqual({ allow: ['Read', 'Search'] });
  });

  it('deduplicates and trims a sloppy tools list', () => {
    expect(mod.resolveDelegateTools(undefined, undefined, [' Read ', 'Read', ''], AVAILABLE))
      .toEqual({ allow: ['Read'] });
  });

  it('read_only + tools INTERSECT — honoring only one would hand the child more than was asked for', () => {
    // Bash is in `tools` but not read-only, so it must be dropped, not granted.
    const { allow } = mod.resolveDelegateTools(undefined, true, ['Read', 'Bash'], AVAILABLE);
    expect(allow).toEqual(['Read']);
  });

  it('rejects unknown tool names instead of silently granting a narrower set', () => {
    // A typo must not quietly become "the child gets nothing useful and nobody knows why".
    const res = mod.resolveDelegateTools(undefined, undefined, ['Read', 'raed_file'], AVAILABLE);
    expect(res.allow).toBeUndefined();
    expect(res.error).toMatch(/unknown tool\(s\): raed_file/);
  });

  it('rejects an explicitly EMPTY tools list rather than reading it as "no restriction"', () => {
    // The dangerous inversion: a model that means "give it nothing" would otherwise get "give it everything".
    const res = mod.resolveDelegateTools(undefined, undefined, [], AVAILABLE);
    expect(res.allow).toBeUndefined();
    expect(res.error).toMatch(/`tools` was empty/);
  });

  describe('can only ever narrow', () => {
    it('refuses to hand over a tool the caller does not hold — loudly, not by silently dropping it', () => {
      // Silently dropping Bash would spawn a child that mysteriously cannot do its job.
      const res = mod.resolveDelegateTools(['Read', 'ListDir'], undefined, ['Read', 'Bash'], AVAILABLE);
      expect(res.allow).toBeUndefined();
      expect(res.error).toMatch(/you do not have Bash yourself/);
    });

    it('a read-only caller cannot mint a writing child', () => {
      const res = mod.resolveDelegateTools(['Read', 'Search'], undefined, ['Write', 'Read'], AVAILABLE);
      expect(res.allow).toBeUndefined();
      expect(res.error).toMatch(/you do not have Write yourself/);
    });

    it('a restricted caller may still narrow WITHIN what it holds', () => {
      const { allow } = mod.resolveDelegateTools(['Read', 'ListDir', 'Search'], undefined, ['Read', 'ListDir'], AVAILABLE);
      expect(allow).toEqual(['Read', 'ListDir']);
    });

    it('read_only intersects with a restricted caller down to what they both allow', () => {
      const { allow } = mod.resolveDelegateTools(['Read', 'Bash'], true, undefined, AVAILABLE);
      expect(allow).toEqual(['Read']); // Bash is held, but read_only excludes it
    });

    it('errors rather than spawning a child with an empty toolset', () => {
      const res = mod.resolveDelegateTools(['Bash'], true, undefined, AVAILABLE);
      expect(res.error).toMatch(/no tools at all/);
    });
  });
});

// The end of the wire: whatever the child is actually launched with. This is the assertion that matters —
// the narrowed policy has to reach the host as part of the delegated access, or the restriction is theatre.
describe('delegate — the access handed to the child', () => {
  let reg: PluginRegistry;
  let seen: { access?: Record<string, unknown> };

  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['subagent', 'files', 'terminal'], logger: log });
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

  it('sends a read-only allow-list the host persists as the child\'s immutable boundary', async () => {
    const res = await delegate({ task: 'find every caller of X', read_only: true });
    expect(res.content[0].text).toBe('child done');
    expect(seen.access?.toolPolicy).toEqual({
      allow: ['Read', 'Search', 'ListDir', 'FileInfo', 'GitStatus', 'CodebaseSearch', 'CodebaseStatus'],
    });
  });

  it('sends an exact tools allow-list', async () => {
    await delegate({ task: 'read the auth module', tools: ['Read', 'ListDir'] });
    expect(seen.access?.toolPolicy).toEqual({ allow: ['Read', 'ListDir'] });
  });

  it('carries the caller\'s deny-list through untouched while adding the allow-list', async () => {
    await delegate({ task: 'explore' }, { deny: new Set(['Bash']) });
    expect(seen.access?.toolPolicy).toEqual({ deny: ['Bash'] });

    await delegate({ task: 'explore', read_only: true }, { deny: new Set(['GitStatus']) });
    // The deny survives, and still applies ON TOP of the allow-list: a tool in both is denied.
    expect(seen.access?.toolPolicy).toMatchObject({ deny: ['GitStatus'] });
    expect((seen.access?.toolPolicy as { allow: string[] }).allow).toContain('Read');
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
});
