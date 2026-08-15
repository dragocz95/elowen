import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';

/** A plugin to write to disk: its manifest `provides` block and the body of its `register(ctx)`. */
export interface FixturePluginSpec {
  name: string;
  /** The manifest's `provides` block — the daemon refuses to register anything it does not declare. */
  provides?: Record<string, unknown>;
  /** The body of `export function register(ctx){ … }`, as source. */
  register: string;
}

/** Write plugins to a throwaway directory and hand back a provider over them, plus the dir itself.
 *
 *  The daemon's plugin loader only reads REAL folders, so a suite whose subject is the daemon's plugin
 *  machinery — what a contribution does to a composed surface, what its absence does — has to put
 *  something on disk. A FIXTURE is the right something: the rule being measured is the daemon's, and
 *  pinning it to whichever product plugin happens to be installed beside the daemon would make the test
 *  fail for reasons that have nothing to do with it.
 *
 *  `enabled` is separate from what is written on purpose: a plugin that is present but not enabled is
 *  DISCOVERABLE, which is what lets the daemon answer "switched off" instead of "no such thing".
 *  Call `cleanup()` from afterEach. */
export function fixturePlugins(specs: FixturePluginSpec[], enabled: string[] = specs.map((s) => s.name)): {
  provider: PluginRegistryProvider;
  dir: string;
  warnings: string[];
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'elowen-fixture-plugin-'));
  for (const spec of specs) {
    const pluginDir = join(dir, spec.name);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'elowen-plugin.json'), JSON.stringify({
      name: spec.name, version: '1.0.0', apiVersion: '1', description: `fixture plugin ${spec.name}`,
      entry: 'index.mjs', ...(spec.provides ? { provides: spec.provides } : {}),
    }));
    writeFileSync(join(pluginDir, 'index.mjs'), `export function register(ctx){\n${spec.register}\n}\n`);
  }
  const warnings: string[] = [];
  const provider = new PluginRegistryProvider(() => loadPlugins({
    dirs: [dir], enabled, logger: { info() {}, warn(m: string) { warnings.push(m); }, error(m: string) { warnings.push(m); } },
  }));
  return { provider, dir, warnings, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
