import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins } from '../../src/plugins/loader.js';
import { parseManifest, PLUGIN_API_VERSION } from '../../src/plugins/manifest.js';

// A plugin may ship its OWN stylesheet, because Elowen is distributed as a PREBUILT web app: on a user's
// machine there is no Tailwind and no Next build, so the host's CSS is frozen at publish time and carries
// only the utilities the host itself uses. Everything below is about the loader half of that pipe —
// resolving the file, hashing it for an immutable URL, and staying quiet-but-audible when it is missing.
const BUNDLE = 'export const ok = 1;\n';
const CSS = '@layer utilities{.w-\\[137px\\]{width:137px}}\n';

let roots: string[] = [];
afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); roots = []; });

function pluginWith(web: Record<string, unknown>, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-web-css-'));
  roots.push(root);
  const dir = join(root, 'demo');
  mkdirSync(join(dir, 'web'), { recursive: true });
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name: 'demo', version: '1.0.0', apiVersion: PLUGIN_API_VERSION, description: 'demo', entry: 'index.mjs', web,
  }));
  writeFileSync(join(dir, 'index.mjs'), 'export function register(){}');
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  return root;
}

async function load(root: string) {
  const warnings: string[] = [];
  const errors: string[] = [];
  const registry = await loadPlugins({
    dirs: [root], enabled: ['demo'], delegatedTurnsOutOfProcess: false,
    logger: { info() {}, warn(m: string) { warnings.push(m); }, error(m: string) { errors.push(m); } },
  });
  return { web: registry.webUi.get('demo'), warnings, errors };
}

describe('bundled plugin web build', () => {
  it('emits the stylesheet every manifest with web.css expects', () => {
    const script = readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'build-plugins-web.mjs'), 'utf8');
    expect(script).toContain('buildPluginUiCss');
    expect(script).toContain("join(dir, 'web', 'index.css')");
  });
});

describe('plugin manifest web.css', () => {
  it('is optional, and a manifest without it parses exactly as before', () => {
    const m = parseManifest({
      name: 'demo', version: '1.0.0', apiVersion: PLUGIN_API_VERSION, description: 'd', entry: 'index.mjs',
      web: { entry: 'web/index.js' },
    });
    expect(m.web?.css).toBeUndefined();
  });

  it('accepts a declared stylesheet path and rejects an empty one', () => {
    const base = { name: 'demo', version: '1.0.0', apiVersion: PLUGIN_API_VERSION, description: 'd', entry: 'index.mjs' };
    expect(parseManifest({ ...base, web: { entry: 'web/index.js', css: 'web/index.css' } }).web?.css).toBe('web/index.css');
    expect(() => parseManifest({ ...base, web: { entry: 'web/index.js', css: '' } })).toThrow();
  });

  it('ignores manifest fields it does not know — an OLDER daemon must survive a newer plugin', () => {
    // This is what lets the core half ship before the registry starts emitting `web.css`, and what keeps
    // a user on an older daemon from being locked out of a plugin that adopted it. If the schema were
    // strict, the manifest would be REJECTED and the whole plugin skipped over a cosmetic field.
    const m = parseManifest({
      name: 'demo', version: '1.0.0', apiVersion: PLUGIN_API_VERSION, description: 'd', entry: 'index.mjs',
      web: { entry: 'web/index.js', css: 'web/index.css', somethingFromTheFuture: { deeply: ['nested'] } },
      alsoUnknownAtTopLevel: 42,
    });
    expect(m.web?.entry).toBe('web/index.js');
  });
});

describe('loader resolves a plugin stylesheet', () => {
  it('content-hashes it independently of the bundle', async () => {
    const { web, warnings } = await load(pluginWith(
      { entry: 'web/index.js', css: 'web/index.css' },
      { 'web/index.js': BUNDLE, 'web/index.css': CSS },
    ));
    expect(web?.cssFile).toMatch(/web\/index\.css$/);
    expect(web?.cssHash).toBe(createHash('sha256').update(CSS).digest('hex').slice(0, 16));
    // Two assets, two hashes: a release that changes only the CSS must still bust only the CSS URL.
    expect(web?.cssHash).not.toBe(web?.hash);
    expect(warnings).toEqual([]);
  });

  it('leaves cssFile/cssHash unset for a plugin that declares none', async () => {
    const { web } = await load(pluginWith({ entry: 'web/index.js' }, { 'web/index.js': BUNDLE }));
    expect(web).toBeDefined();
    expect(web?.cssHash).toBeUndefined();
    expect(web?.cssFile).toBeUndefined();
  });

  it('warns and keeps the UI when the declared stylesheet is missing', async () => {
    // Not fatal — the page still loads, it just paints with whatever the host happens to carry, which
    // is exactly the silent breakage this pipe exists to end. So it has to be audible in the log.
    const { web, warnings } = await load(pluginWith(
      { entry: 'web/index.js', css: 'web/index.css' },
      { 'web/index.js': BUNDLE },
    ));
    expect(web).toBeDefined();
    expect(web?.cssHash).toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining('web stylesheet missing at web/index.css')]);
  });

  it('refuses a stylesheet path that escapes the plugin directory', async () => {
    // Same rule the bundle entry has always had: the manifest is plugin-authored input, and this path
    // is read off disk and served to any authorized user.
    const { web, errors } = await load(pluginWith(
      { entry: 'web/index.js', css: '../../etc/passwd' },
      { 'web/index.js': BUNDLE },
    ));
    expect(web).toBeUndefined();
    expect(errors).toEqual([expect.stringContaining('web css "../../etc/passwd" escapes plugin dir')]);
  });
});
