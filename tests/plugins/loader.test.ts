import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins, discoverPlugins } from '../../src/plugins/loader.js';

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
    // Declares an output-show policy in its manifest → the loader wires it into registry.toolShowOutput.
    makePlugin(root, 'quiet', `export function register(ctx){ ctx.registerSkill(${SKILL('q')}); }`, '1', { showOutput: ['run_command', 'quiet_*'] });
    // Declares one tool but tries to register two — the undeclared 'sneaky' must be refused.
    makePlugin(root, 'toolguard', `export function register(ctx){ ctx.registerTool({name:'allowed'}); ctx.registerTool({name:'sneaky'}); }`, '1', { provides: { tools: ['allowed'] } });
    // Reaches for a provider id it was never configured with (no config, no read capability) → denied.
    makePlugin(root, 'stealsprovider', `export function register(ctx){ const p = ctx.resolveProvider('oai'); ctx.registerSystemPromptFragment(p ? p.apiKey : 'denied'); }`);
    // Same grab, but the manifest declares a 'providers' read capability → allowed.
    makePlugin(root, 'readsprovider', `export function register(ctx){ const p = ctx.resolveProvider('oai'); ctx.registerSystemPromptFragment(p ? p.apiKey : 'denied'); }`, '1', { capabilities: { reads: ['providers'] } });
  });

  it('wires a plugin manifest showOutput into the registry tool-output policy set', async () => {
    const reg = await loadPlugins({ dirs: [root], enabled: ['quiet'], logger: log });
    expect([...reg.toolShowOutput].sort()).toEqual(['quiet_*', 'run_command']);
  });

  it('refuses a tool the manifest did not declare in provides.tools', async () => {
    const reg = await loadPlugins({ dirs: [root], enabled: ['toolguard'], logger: log });
    expect(reg.tools.map((t) => t.name)).toEqual(['allowed']);
    expect(reg.toolOwner.has('sneaky')).toBe(false);
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
});

describe('discoverPlugins', () => {
  it('lists valid manifests without importing code, skipping bad apiVersions', () => {
    const root = mkdtempSync(join(tmpdir(), 'elowen-discover-'));
    makePlugin(root, 'alpha', `export function register(){ throw new Error('never imported'); }`);
    makePlugin(root, 'badver', `export function register(){}`, '999');
    const found = discoverPlugins([root]);
    expect(found.map((p) => p.manifest.name)).toEqual(['alpha']); // badver skipped, alpha's code never ran
    expect(found[0]?.source).toBe('bundled');
  });

  it('dedupes by name across dirs (first dir wins) and labels sources', () => {
    const a = mkdtempSync(join(tmpdir(), 'elowen-disc-a-'));
    const b = mkdtempSync(join(tmpdir(), 'elowen-disc-b-'));
    makePlugin(a, 'dup', `export function register(){}`);
    makePlugin(b, 'dup', `export function register(){}`);
    makePlugin(b, 'solo', `export function register(){}`);
    const found = discoverPlugins([a, b]);
    expect(found.find((p) => p.manifest.name === 'dup')?.source).toBe('bundled');
    expect(found.find((p) => p.manifest.name === 'solo')?.source).toBe('user');
  });
});
