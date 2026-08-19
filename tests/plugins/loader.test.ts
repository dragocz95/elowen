import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins, discoverPlugins } from '../../src/plugins/loader.js';

// Delegate to the real fs except readdirSync, which tests override to simulate an arbitrary on-disk
// directory order — loadPlugins must yield the same tool order no matter what order readdir returns.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

const log = { info() {}, warn() {}, error() {} };

function makePlugin(root: string, name: string, body: string, apiVersion = '1', extra: Record<string, unknown> = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name, version: '0.1.0', apiVersion, description: name, entry: 'index.mjs', ...extra,
  }));
  writeFileSync(join(dir, 'index.mjs'), body);
  return dir;
}

const SKILL = (n: string) => `{name:'${n}',description:'d',filePath:'/s/${n}.md'}`;

describe('loadPlugins', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'elowen-plugins-'));
    makePlugin(root, 'good', `export function register(ctx){ ctx.registerSkill(${SKILL('g')}); }`);
    makePlugin(root, 'other', `export function register(ctx){ ctx.registerSystemPromptFragment('frag'); }`);
    makePlugin(root, 'broken', `export function register(){ throw new Error('boom'); }`);
    makePlugin(root, 'disabled', `export function register(ctx){ ctx.registerSkill(${SKILL('x')}); }`);
    makePlugin(root, 'badver', `export function register(ctx){ ctx.registerSkill(${SKILL('v')}); }`, '999');
    makePlugin(root, 'usesconfig', `export function register(ctx){ ctx.registerSystemPromptFragment(ctx.config.msg); }`);
    makePlugin(root, 'usesprovider', `export function register(ctx){ const p = ctx.resolveProvider(ctx.config.pid); ctx.registerSystemPromptFragment(p ? p.baseUrl + '|' + p.apiKey : 'none'); }`);
    makePlugin(root, 'caps', `export function register(ctx){ ctx.registerSkill(${SKILL('c')}); }`, '1', { capabilities: { mutates: ['turnContext'] } });
    makePlugin(root, 'usercaps', `export function register(ctx){ ctx.registerSystemPromptFragment('users:' + Boolean(ctx.host.externalUsers())); }`, '1', { capabilities: { mutates: ['users'] } });
    // Declares an output-show policy in its manifest → the loader wires it into registry.toolShowOutput.
    makePlugin(root, 'quiet', `export function register(ctx){ ctx.registerSkill(${SKILL('q')}); }`, '1', { showOutput: ['Bash', 'quiet_*'] });
    // Declares one tool but tries to register two — the undeclared 'sneaky' must be refused.
    makePlugin(root, 'toolguard', `export function register(ctx){ ctx.registerTool({name:'allowed'}); ctx.registerTool({name:'sneaky'}); }`, '1', { provides: { tools: ['allowed'] } });
    // Reaches for a provider id it was never configured with (no config, no read capability) → denied.
    makePlugin(root, 'stealsprovider', `export function register(ctx){ const p = ctx.resolveProvider('oai'); ctx.registerSystemPromptFragment(p ? p.apiKey : 'denied'); }`);
    // Same grab, but the manifest declares a 'providers' read capability → allowed.
    makePlugin(root, 'readsprovider', `export function register(ctx){ const p = ctx.resolveProvider('oai'); ctx.registerSystemPromptFragment(p ? p.apiKey : 'denied'); }`, '1', { capabilities: { reads: ['providers'] } });
    // Reverse workflow-DAG mutation is granted by a DECLARED capability, never by a plugin's name. The
    // owner fixture is deliberately NOT called 'subagent', and a fixture that IS called 'subagent'
    // declares nothing — so the bundled owner's name cannot be what makes this pass.
    makePlugin(root, 'rpcprobe', `export function register(ctx){ ctx.registerSystemPromptFragment('probe:' + Boolean(ctx.workflowExpansionRpc())); }`);
    makePlugin(root, 'rpcowner', `export function register(ctx){ ctx.registerSystemPromptFragment('owner:' + Boolean(ctx.workflowExpansionRpc())); }`, '1', { capabilities: { mutates: ['workflow-dag'] } });
    makePlugin(root, 'subagent', `export function register(ctx){ ctx.registerSystemPromptFragment('named:' + Boolean(ctx.workflowExpansionRpc())); }`);
    // Tool-registering plugins used by the deterministic-order test: created in an arbitrary order here,
    // the assertion only cares that their tools come out sorted by plugin name.
    makePlugin(root, 'alpha', `export function register(ctx){ ctx.registerTool({name:'alpha_tool'}); }`);
    makePlugin(root, 'mike', `export function register(ctx){ ctx.registerTool({name:'mike_tool'}); }`);
    makePlugin(root, 'zeta', `export function register(ctx){ ctx.registerTool({name:'zeta_tool'}); }`);
    // The first owner wins the tool collision. Only a merged tool may receive its owner's defer default.
    makePlugin(root, 'collisionalpha', `export function register(ctx){ ctx.registerTool({name:'CollisionTool'}); }`);
    makePlugin(root, 'collisionzeta', `export function register(ctx){ ctx.registerTool({name:'CollisionTool'}); }`, '1', { deferLoading: ['CollisionTool'] });
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it('wires a plugin manifest showOutput into the registry tool-output policy set', async () => {
    const reg = await loadPlugins({ dirs: [root], enabled: ['quiet'], logger: log });
    expect([...reg.toolShowOutput].sort()).toEqual(['Bash', 'quiet_*']);
  });

  it('does not carry a deferred-tool default from a plugin whose colliding tool was rejected', async () => {
    const warnings: string[] = [];
    const reg = await loadPlugins({
      dirs: [root],
      enabled: ['collisionalpha', 'collisionzeta'],
      logger: { info() {}, warn: (message) => warnings.push(message), error() {} },
    });

    expect(reg.toolOwner.get('CollisionTool')).toBe('collisionalpha');
    expect([...reg.toolDeferLoading]).toEqual([]);
    expect(warnings).toContain("[plugin:collisionzeta] deferLoading 'CollisionTool' ignored: no matching tools registered by 'collisionzeta'");
  });

  it('refuses a tool the manifest did not declare in provides.tools', async () => {
    const reg = await loadPlugins({ dirs: [root], enabled: ['toolguard'], logger: log });
    expect(reg.tools.map((t) => t.name)).toEqual(['allowed']);
    expect(reg.toolOwner.has('sneaky')).toBe(false);
  });

  // Regression: deleting a bundled plugin leaves its GITIGNORED web bundle behind, so the bundle dir
  // keeps a folder for that name with no manifest. The loader used to log ERROR "plugin skipped" for it
  // — immediately before loading that very same plugin from the user dir. A folder that is not a plugin
  // has to be as quiet as no folder at all.
  it('ignores a manifest-less folder silently and still loads that name from a later dir', async () => {
    const bundled = mkdtempSync(join(tmpdir(), 'elowen-bundled-'));
    const user = mkdtempSync(join(tmpdir(), 'elowen-user-'));
    try {
      mkdirSync(join(bundled, 'ghost', 'web'), { recursive: true });
      writeFileSync(join(bundled, 'ghost', 'web', 'index.js'), 'export {};');
      makePlugin(user, 'ghost', `export function register(ctx){ ctx.registerSystemPromptFragment('alive'); }`);

      const errors: string[] = [];
      const warnings: string[] = [];
      const reg = await loadPlugins({
        dirs: [bundled, user],
        enabled: ['ghost'],
        logger: { info() {}, warn: (m) => warnings.push(m), error: (m) => errors.push(m) },
      });

      expect(reg.promptFragments).toContain('alive');
      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
    } finally {
      rmSync(bundled, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });

  // That quiet skip must not swallow a folder that IS a plugin and is broken.
  it('still fails loudly for a folder whose manifest cannot be parsed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-badmanifest-'));
    try {
      mkdirSync(join(dir, 'mangled'), { recursive: true });
      writeFileSync(join(dir, 'mangled', 'elowen-plugin.json'), '{ not json');

      const errors: string[] = [];
      await loadPlugins({ dirs: [dir], enabled: ['mangled'], logger: { info() {}, warn() {}, error: (m) => errors.push(m) } });

      expect(errors.some((m) => m.startsWith('plugin skipped: mangled:'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Before this, an enabled plugin that no directory provided disappeared without a single log line.
  it('reports enabled plugins that no directory provides, once and by name', async () => {
    const warnings: string[] = [];
    const reg = await loadPlugins({
      dirs: [root],
      enabled: ['good', 'nosuchplugin', 'anotherghost'],
      logger: { info() {}, warn: (m) => warnings.push(m), error() {} },
    });

    expect(reg.skills.map((s) => s.name)).toContain('g');
    expect(warnings).toContain('enabled but not found in any plugin directory: anotherghost, nosuchplugin');
  });

  it('denies resolveProvider for an id outside the plugin config and without a providers read capability', async () => {
    const resolveProvider = (id: string) => id === 'oai' ? { id, label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' } : null;
    const reg = await loadPlugins({ dirs: [root], enabled: ['stealsprovider'], resolveProvider, logger: log });
    expect(reg.promptFragments).toEqual(['denied']);
  });

  it('allows resolveProvider for any id when the plugin declares a providers read capability', async () => {
    const resolveProvider = (id: string) => id === 'oai' ? { id, label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' } : null;
    const reg = await loadPlugins({ dirs: [root], enabled: ['readsprovider'], resolveProvider, logger: log });
    expect(reg.promptFragments).toEqual(['sk-test']);
  });

  it('records a loaded plugin\'s declared capabilities on the registry', async () => {
    const reg = await loadPlugins({ dirs: [root], enabled: ['caps'], logger: log });
    expect(reg.pluginCapabilities.get('caps')).toEqual({ mutates: ['turnContext'] });
  });

  it("accepts mutates:['users'] in the manifest and capability-gates the account seam", async () => {
    const reg = await loadPlugins({
      dirs: [root], enabled: ['usercaps'], logger: log,
      host: {
        externalUsers: {
          resolve: () => null,
          describe: () => null,
          linkOrProvision: () => ({ user: { id: 2, username: 'external', isAdmin: false }, created: true }),
          linkExisting: () => ({
            provider: 'msteams', tenantId: 'tenant-1', subjectId: 'subject-1',
            user: { id: 2, username: 'external', isAdmin: false }, linkedAt: '2026-08-19 05:00:00',
          }),
        },
      },
    });
    expect(reg.promptFragments).toEqual(['users:true']);
    expect(reg.pluginCapabilities.get('usercaps')).toEqual({ mutates: ['users'] });
  });

  it("exposes the runner workflow mutation client only to a plugin declaring mutates:['workflow-dag']", async () => {
    const reg = await loadPlugins({
      dirs: [root],
      enabled: ['rpcprobe', 'rpcowner', 'subagent'],
      logger: log,
      workflowExpansionRpc: { addNodes: async () => ({ added: [] }) },
    });
    // Name-sorted load order: rpcowner, rpcprobe, subagent. Being called 'subagent' grants nothing.
    expect(reg.promptFragments).toEqual(['owner:true', 'probe:false', 'named:false']);
  });

  it('defaults a capability-less plugin to an empty (deny-all) capabilities entry', async () => {
    const reg = await loadPlugins({ dirs: [root], enabled: ['good'], logger: log });
    expect(reg.pluginCapabilities.get('good')).toEqual({});
  });

  it('loads only enabled plugins and aggregates their contributions', async () => {
    const reg = await loadPlugins({ dirs: [root], enabled: ['good', 'other'], logger: log });
    expect(reg.skills.map((s) => s.name)).toEqual(['g']);
    expect(reg.promptFragments).toEqual(['frag']);
  });

  it('skips a broken plugin without throwing, still loading its sibling', async () => {
    const reg = await loadPlugins({ dirs: [root], enabled: ['broken', 'good'], logger: log });
    expect(reg.skills.map((s) => s.name)).toEqual(['g']);
  });

  it('skips a plugin with an unsupported apiVersion', async () => {
    const reg = await loadPlugins({ dirs: [root], enabled: ['badver'], logger: log });
    expect(reg.skills).toHaveLength(0);
  });

  it('ignores plugins not in the enabled list', async () => {
    const reg = await loadPlugins({ dirs: [root], enabled: ['good'], logger: log });
    expect(reg.skills).toHaveLength(1);
  });

  it('passes each plugin its own config slice', async () => {
    const reg = await loadPlugins({ dirs: [root], enabled: ['usesconfig'], config: { usesconfig: { msg: 'hi' } }, logger: log });
    expect(reg.promptFragments).toEqual(['hi']);
  });

  it('exposes the central provider resolver to plugins (ctx.resolveProvider)', async () => {
    const resolveProvider = (id: string) => id === 'oai' ? { id, label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' } : null;
    const reg = await loadPlugins({ dirs: [root], enabled: ['usesprovider'], config: { usesprovider: { pid: 'oai' } }, resolveProvider, logger: log });
    expect(reg.promptFragments).toEqual(['https://api.openai.com/v1|sk-test']);
  });

  it('resolveProvider returns null for an unknown id (and defaults to null when unwired)', async () => {
    const reg = await loadPlugins({ dirs: [root], enabled: ['usesprovider'], config: { usesprovider: { pid: 'ghost' } }, logger: log });
    expect(reg.promptFragments).toEqual(['none']);
  });

  it('tolerates a missing directory', async () => {
    const reg = await loadPlugins({ dirs: [join(root, 'nope')], enabled: ['good'], logger: log });
    expect(reg.skills).toHaveLength(0);
  });

  it('registers plugin tools in a name-sorted order no matter the on-disk directory order', async () => {
    const readdir = vi.mocked(readdirSync);
    // Opposite readdir orders must yield the SAME tool order — tool order is part of the cached prompt
    // prefix, so it must not depend on the filesystem's directory listing.
    readdir.mockReturnValueOnce(['zeta', 'mike', 'alpha']);
    const reversed = await loadPlugins({ dirs: [root], enabled: ['alpha', 'mike', 'zeta'], logger: log });
    readdir.mockReturnValueOnce(['alpha', 'mike', 'zeta']);
    const sorted = await loadPlugins({ dirs: [root], enabled: ['alpha', 'mike', 'zeta'], logger: log });
    expect(reversed.tools.map((t) => t.name)).toEqual(['alpha_tool', 'mike_tool', 'zeta_tool']);
    expect(sorted.tools.map((t) => t.name)).toEqual(reversed.tools.map((t) => t.name));
  });
});

describe('discoverPlugins', () => {
  let dirs: string[] = [];
  const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
  afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

  it('lists valid manifests without importing code, skipping bad apiVersions', () => {
    const root = tmpDir('discover');
    makePlugin(root, 'alpha', `export function register(){ throw new Error('never imported'); }`);
    makePlugin(root, 'badver', `export function register(){}`, '999');
    const found = discoverPlugins([root]);
    expect(found.map((p) => p.manifest.name)).toEqual(['alpha']); // badver skipped, alpha's code never ran
    expect(found[0]?.source).toBe('bundled');
  });

  it('dedupes by name across dirs (first dir wins) and labels sources', () => {
    const a = tmpDir('disc-a');
    const b = tmpDir('disc-b');
    makePlugin(a, 'dup', `export function register(){}`);
    makePlugin(b, 'dup', `export function register(){}`);
    makePlugin(b, 'solo', `export function register(){}`);
    const found = discoverPlugins([a, b]);
    expect(found.find((p) => p.manifest.name === 'dup')?.source).toBe('bundled');
    expect(found.find((p) => p.manifest.name === 'solo')?.source).toBe('user');
  });
});
