import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_SHARED_API_VERSION } from 'elowen-plugin-shared';
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
    makePlugin(root, 'adminmissing', `export function register(ctx){ ctx.registerProjectIndicators(() => [{projectId:1,label:'Admin'}]); }`, '1', { web: { entry: 'web/missing.js', adminOnly: true } });
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
    const surface = makePlugin(root, 'surface', `export function register(ctx){ ctx.registerPlatform({name:'msteams',listen(){},connect(){}}); }`, '1', { provides: { platforms: ['msteams', 'msteams'] } });
    mkdirSync(join(surface, 'prompt'));
    writeFileSync(join(surface, 'prompt', '20-tools.md'), 'Use TeamsSendFile for generated files.');
    writeFileSync(join(surface, 'prompt', '10-surface.md'), 'You are replying through Microsoft Teams.');
    writeFileSync(join(surface, 'prompt', 'ignored.txt'), 'not a prompt');
    // The first owner wins the tool collision. Only a merged tool may receive its owner's defer default.
    makePlugin(root, 'collisionalpha', `export function register(ctx){ ctx.registerTool({name:'CollisionTool'}); }`);
    makePlugin(root, 'collisionzeta', `export function register(ctx){ ctx.registerTool({name:'CollisionTool'}); }`, '1', { deferLoading: ['CollisionTool'] });
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it('loads ordered prompt/*.md fragments only for the platform the plugin registered', async () => {
    const reg = await loadPlugins({ dirs: [root], enabled: ['surface'], logger: log });
    expect(reg.platformPromptsFor('msteams')).toEqual([
      'You are replying through Microsoft Teams.',
      'Use TeamsSendFile for generated files.',
    ]);
    expect(reg.platformPromptsFor('discord')).toEqual([]);
    expect(reg.platformPromptFragments.get('msteams')?.map((fragment) => fragment.file)).toEqual(['10-surface.md', '20-tools.md']);
  });

  it('reloads platform prompt files into a fresh registry without retaining the old generation', async () => {
    const file = join(root, 'surface', 'prompt', '10-surface.md');
    const original = 'You are replying through Microsoft Teams.';
    try {
      expect((await loadPlugins({ dirs: [root], enabled: ['surface'], logger: log })).platformPromptsFor('msteams')[0]).toBe(original);
      writeFileSync(file, 'Updated Teams surface instructions.');
      expect((await loadPlugins({ dirs: [root], enabled: ['surface'], logger: log })).platformPromptsFor('msteams')).toEqual([
        'Updated Teams surface instructions.',
        'Use TeamsSendFile for generated files.',
      ]);
    } finally {
      writeFileSync(file, original);
    }
  });

  it('keeps admin-only metadata even when the declared web bundle is missing', async () => {
    const reg = await loadPlugins({ dirs: [root], enabled: ['adminmissing'], logger: log });
    expect(reg.webUi.has('adminmissing')).toBe(false);
    expect(reg.webAdminOnly.has('adminmissing')).toBe(true);
    expect(reg.projectIndicatorProviders.map((provider) => provider.plugin)).toEqual(['adminmissing']);
  });

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

  /** The shared-helper contract, refused at the only moment that works.
   *
   *  A plugin links against the HOST's copy of `elowen-plugin-shared`, so removing an export from it
   *  breaks every already-installed plugin that imports the export — as a link-time SyntaxError raised by
   *  `import()` itself, before any code of the plugin's own could check a version. The manifest gate is
   *  what gets in front of that, and these fixtures import a binding that genuinely does not exist so the
   *  ordering is real rather than asserted: if the gate ran a line later, the SyntaxError would win and
   *  both messages below would be the wrong one. */
  describe('shared-helper contract', () => {
    /** An entry that cannot be imported, by two independent routes: it links a binding
     *  `elowen-plugin-shared` genuinely does not export (Node raises that at LINK time, which is the real
     *  failure this gate exists for) and its module body throws on the line after. The second route is
     *  what makes the ordering assertions below hold under a test runner that resolves ESM itself and
     *  turns the missing binding into `undefined` instead of a SyntaxError — either way, reaching the
     *  import at all produces a different message than the gate's. */
    const UNIMPORTABLE = "import { CONTROL_COMMANDS } from 'elowen-plugin-shared/chatCommands';\n"
      + "throw new Error('MODULE BODY RAN: ' + String(CONTROL_COMMANDS));\n"
      + 'export function register(){}';

    /** Build the fixture the way the installer really leaves a plugin on disk: its bare
     *  `elowen-plugin-shared` imports resolve through a `node_modules` symlink to the HOST's, which is the
     *  whole reason a plugin runs against the daemon's copy instead of its own. */
    async function loadFixture(name: string, body: string, extra: Record<string, unknown>) {
      const dir = mkdtempSync(join(tmpdir(), 'elowen-sharedapi-'));
      try {
        const pluginDir = makePlugin(dir, name, body, '1', extra);
        symlinkSync(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(pluginDir, 'node_modules'), 'dir');
        const errors: string[] = [];
        const reg = await loadPlugins({ dirs: [dir], enabled: [name], logger: { info() {}, warn() {}, error: (m) => errors.push(m) } });
        return { errors, reg };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    const load = (name: string, extra: Record<string, unknown>) => loadFixture(name, UNIMPORTABLE, extra);

    it('refuses a plugin built for an OLDER contract before its entry is imported', async () => {
      const { errors, reg } = await load('stale', { requiresSharedApi: PLUGIN_SHARED_API_VERSION - 1 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`needs elowen-plugin-shared API ${PLUGIN_SHARED_API_VERSION - 1}`);
      expect(errors[0]).toContain(`this daemon ships ${PLUGIN_SHARED_API_VERSION}`);
      expect(errors[0]).toContain('update stale');
      // The ordering proof: this entry cannot be imported without failing, so the version message can only
      // be the reported one if nothing ever tried.
      expect(errors[0]).not.toContain('MODULE BODY RAN');
      expect(reg.promptFragments).toEqual([]);
    });

    it('refuses a plugin built for a NEWER contract too, so neither upgrade order reaches the import', async () => {
      const { errors } = await load('ahead', { requiresSharedApi: PLUGIN_SHARED_API_VERSION + 1 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('update Elowen');
      expect(errors[0]).not.toContain('MODULE BODY RAN');
    });

    /** A plugin published BEFORE this field existed declares no contract, so there is nothing to compare
     *  and it does reach the import. That case cannot be gated by a manifest that cannot speak — but the
     *  SyntaxError Node raises names a missing binding, not a cause, so the log has to say what it means.
     *  Driven through a module-body throw carrying that exact message: the runner used here links ESM
     *  itself and would not raise the real one, and what is under test is how the failure is REPORTED. */
    it('explains a shared-helper link failure for a plugin too old to declare a contract', async () => {
      const { errors } = await loadFixture(
        'legacy',
        "throw new Error(\"The requested module 'elowen-plugin-shared/chatCommands' does not provide an export named 'CONTROL_COMMANDS'\");\n"
        + 'export function register(){}',
        {},
      );
      expect(errors[0]).toContain('does not provide an export named');
      expect(errors[0]).toContain(`different elowen-plugin-shared contract than this daemon's (API ${PLUGIN_SHARED_API_VERSION})`);
    });

    it('leaves an unrelated failure message exactly as it was', async () => {
      const { errors } = await loadFixture('other', "throw new Error('boom');\nexport function register(){}", {});
      expect(errors[0]).toBe('plugin skipped: other: boom');
    });

    it('loads a plugin that declares the contract this daemon ships', async () => {
      const { errors, reg } = await loadFixture(
        'current',
        "import { PLUGIN_SHARED_API_VERSION as v } from 'elowen-plugin-shared';\n"
        + 'export function register(ctx){ ctx.registerSystemPromptFragment(`shared:${v}`); }',
        { requiresSharedApi: PLUGIN_SHARED_API_VERSION },
      );
      expect(errors).toEqual([]);
      expect(reg.promptFragments).toContain(`shared:${PLUGIN_SHARED_API_VERSION}`);
    });
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
