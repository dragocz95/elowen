import { describe, it, expect, vi, afterEach } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs package entry, no types
import { PLUGIN_SHARED_API_VERSION } from '../../packages/plugin-shared/index.mjs';
import { MarketplaceService } from '../../src/plugins/marketplace.js';
import { discoverPlugins } from '../../src/plugins/loader.js';

/** The rest of the marketplace suite stops at "the files landed in the right place" — it never imports
 *  what it installed, and says so (marketplace.ts: "Unset in tests (they never import the copied
 *  plugin)"). That leaves the one thing an installed plugin depends on completely uncovered: its bare
 *  specifiers have to resolve through the `node_modules -> host` symlink the installer creates.
 *
 *  That matters more since the shared helpers left plugins/_shared and became elowen-plugin-shared. A
 *  registry plugin no longer reaches its helpers by a relative path it carries with it; it names a
 *  package that only exists in the HOST's node_modules. Nothing else in this repository would notice if
 *  that stopped working, because every bundled plugin resolves it by walking up to the same node_modules
 *  for its own reasons. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hostNodeModules = join(repoRoot, 'node_modules');

let dirs: string[] = [];
const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

/** A registry fixture holding one plugin whose entry imports the shared package — the shape a migrated
 *  chat adapter has. It re-exports what it resolved so the assertion can prove the import ran, not just
 *  that the file parsed. */
function writeSharedConsumerRegistry(root: string, name: string): void {
  const dir = join(root, 'plugins', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'registry.json'), JSON.stringify({
    schema: 1,
    plugins: [{ name, version: '1.0.0', description: 'shared consumer', category: 'utility' }],
  }));
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name, version: '1.0.0', apiVersion: '1', description: 'shared consumer', entry: 'index.mjs',
    provides: { tools: ['SharedProbe'] },
  }));
  writeFileSync(join(dir, 'index.mjs'), [
    "import { stripThinking } from 'elowen-plugin-shared/format';",
    "import { PLUGIN_SHARED_API_VERSION } from 'elowen-plugin-shared';",
    'export function register() {}',
    'export const probe = (text) => stripThinking(text);',
    'export const contract = PLUGIN_SHARED_API_VERSION;',
  ].join('\n'));
}

const fakeGit = (fixture: string) => vi.fn(async (cmd: string, args: string[]) => {
  if (cmd === 'git' && args[0] === '--version') return { stdout: 'git version 2.40.0' };
  if (args.includes('rev-parse')) return { stdout: 'true' };
  if (args[0] === 'clone') {
    cpSync(fixture, args[args.length - 1]!, { recursive: true });
    mkdirSync(join(args[args.length - 1]!, '.git'), { recursive: true });
    return { stdout: '' };
  }
  return { stdout: '' };
});

describe('a marketplace-installed plugin actually loads', () => {
  it('resolves elowen-plugin-shared through the host node_modules symlink the installer creates', async () => {
    const base = tmpDir('mkt-import');
    const fixture = join(base, 'registry');
    const userDir = join(base, 'user');
    const bundledDir = join(base, 'bundled');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(bundledDir, { recursive: true });
    writeSharedConsumerRegistry(fixture, 'shared-probe');

    const enabled: string[] = [];
    const svc = new MarketplaceService({
      registryUrl: 'https://example.invalid/registry.git',
      cacheDir: join(base, 'cache'),
      userPluginsDir: userDir,
      pluginDataRoot: join(base, 'data'),
      ttlMs: 60_000,
      hostNodeModules,
      discovered: () => discoverPlugins([bundledDir, userDir]),
      getEnabled: () => enabled,
      setEnabled: (names) => { enabled.length = 0; enabled.push(...names); },
      reload: async () => {},
      io: { exec: fakeGit(fixture) as never },
    });

    await svc.install('shared-probe', { enable: false });

    // The real assertion: import the installed copy from where it actually sits, the way the loader
    // does, and use something that only exists inside the shared package.
    const entry = join(userDir, 'shared-probe', 'index.mjs');
    const mod = await import(`${pathToFileURL(entry).href}?probe=1`) as {
      probe: (t: string) => string;
      contract: number;
    };
    // Against the package's own constant, not a literal: what this proves is that the installed copy
    // resolves to the HOST's shared package, and a number restated here would just be a second place to
    // bump the contract version.
    expect(mod.contract).toBe(PLUGIN_SHARED_API_VERSION);
    expect(typeof mod.contract).toBe('number');
    expect(mod.probe('<thinking>hidden</thinking>visible')).not.toContain('hidden');
  });
});
