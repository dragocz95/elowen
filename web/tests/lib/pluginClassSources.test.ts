import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPluginClassSources, userPluginsDir } from '../../scripts/collect-plugin-classes.mjs';

const repoRoot = join(import.meta.dirname, '..', '..', '..');

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A data directory as the daemon lays it out: `<dir>/elowen.db` beside `<dir>/plugins/<name>/…`. */
function dataDirWithPlugin(name: string, files: Record<string, string>): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'elowen-plugins-'));
  temps.push(root);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, 'plugins', name, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
  return { ...process.env, ELOWEN_DB: join(root, 'elowen.db') };
}

/** Plugin bundles style themselves with the host's utilities, but Tailwind only scans sources inside the
 *  web project root — a utility used solely by a plugin is generated ONLY because globals.css scans the
 *  generated mirror of the plugin sources. Lose either half and plugin pages quietly render unstyled, in
 *  a way no unit test of a component would notice. */
describe('plugin class sources', () => {
  it('globals.css scans the generated plugin source mirror', () => {
    const css = readFileSync(join(repoRoot, 'web', 'app', 'globals.css'), 'utf8');
    expect(css).toMatch(/@source\s+"\.\/styles\/plugin-classes\.txt"/);
  });

  // CSS ignores an @import that follows any other rule, so a stray at-rule above the import block drops
  // tokens, components, animations and skins from the build — the whole app renders unstyled while every
  // component test still passes and the build still succeeds.
  it('keeps every stylesheet import ahead of the other at-rules that would void it', () => {
    const lines = readFileSync(join(repoRoot, 'web', 'app', 'globals.css'), 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l.startsWith('@'));
    const lastImport = lines.findLastIndex((l) => l.startsWith('@import'));
    const firstOther = lines.findIndex((l) => !l.startsWith('@import') && !l.startsWith('@charset') && !l.startsWith('@layer'));
    expect(lastImport).toBeGreaterThan(-1);
    if (firstOther > -1) expect(firstOther).toBeGreaterThan(lastImport);
  });

  it('the mirror carries the markup of every plugin that ships a browser bundle', () => {
    const blob = collectPluginClassSources(repoRoot);
    // A container-query variant no core page uses: it exists in the built CSS only via this mirror.
    expect(blob).toContain('@sm:');

    // Read the expectation off the repo rather than naming plugins. A hardcoded list goes red the moment
    // a plugin moves to the marketplace registry — and it hid something worse: the mirror ALSO picks up
    // plugins installed in the data directory, so a name that had already left the package still
    // satisfied the list on a developer machine and failed only in CI, where that directory is empty.
    const bundled = readdirSync(join(repoRoot, 'plugins'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(repoRoot, 'plugins', e.name, 'web-src')))
      .map((e) => e.name);

    expect(bundled.length).toBeGreaterThan(2); // the loop below proves nothing if discovery breaks
    for (const plugin of bundled) expect(blob).toContain(`plugins/${plugin}/web-src`);
  });

  // A plugin is not only a plugin we shipped: installed ones live in the data directory, and the host
  // generates no CSS for a class it never saw. Without these the first third-party plugin page renders
  // completely unstyled, and nothing else in the build says so.
  it('carries the markup of a plugin installed in the data directory', () => {
    const env = dataDirWithPlugin('acme', { 'web-src/AcmePage.tsx': 'export const cls = "gap-[3.7rem] text-acme-marker";' });
    expect(collectPluginClassSources(repoRoot, env)).toContain('gap-[3.7rem] text-acme-marker');
  });

  it('falls back to the built bundle for an installed plugin that ships no sources', () => {
    // A marketplace install carries `web/index.js` and nothing else — the class names survive bundling
    // as string literals, so the bundle is the only text there is to scan.
    const env = dataDirWithPlugin('acme', { 'web/index.js': 'const c="rounded-[13px] bg-acme-bundle";' });
    expect(collectPluginClassSources(repoRoot, env)).toContain('rounded-[13px] bg-acme-bundle');
  });

  it('still collects the bundled plugins when no data directory exists', () => {
    // The web is often built where the daemon's data directory does not exist (CI, a packaging box, a
    // fresh checkout). That must degrade to "no user plugins", never to a build failure.
    const env = { ...process.env, ELOWEN_DB: join(tmpdir(), 'elowen-absent-' + Math.random().toString(36).slice(2), 'elowen.db') };
    expect(userPluginsDir(env)).toContain('plugins');
    expect(collectPluginClassSources(repoRoot, env)).toContain('plugins/agents/web-src');
  });

  it('regenerates the web build chain: build and dev both refresh the mirror before Next runs', () => {
    // A stale mirror is invisible — the page just misses a class — so the refresh must be wired into the
    // scripts themselves rather than left to whoever remembers to run it.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'web', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toContain('collect-plugin-classes.mjs');
    expect(pkg.scripts.dev).toContain('collect-plugin-classes.mjs');
  });
});
