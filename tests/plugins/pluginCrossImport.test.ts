import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');

const bundledPlugins = readdirSync(pluginsDir).filter((name) => {
  const dir = join(pluginsDir, name);
  return statSync(dir).isDirectory() && readdirSync(dir).includes('elowen-plugin.json');
});

/** Every module of one bundled plugin, excluding its browser bundle sources and vendored deps. */
function modulesOf(plugin: string): string[] {
  const root = join(pluginsDir, plugin);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'web-src' || entry.name === 'web') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|js|cjs)$/.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Static imports, re-exports, dynamic imports and requires — the specifier only, not what it resolves
 *  to. A re-export (`export * from`) is the idiomatic way one module would surface another's exports, so
 *  it has to be matched as carefully as an import; the `from` keyword is what separates it from an
 *  ordinary `export const x = '…'`. */
function specifiersOf(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:^|[\s;}])import\s*(?:[^;'"]*?\bfrom\s*)?['"]([^'"]+)['"]/g,
    /(?:^|[\s;}])export\s*[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire(?:\.resolve)?\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.push(match[1]!);
  }
  return out;
}

// A plugin reaching into another plugin's module would couple two independently installable, independently
// disableable units: the importer would break when the other is absent or disabled, and the imported
// plugin's behaviour would run outside its own lifecycle, permissions and config. The host contract is the
// only legal path between plugins — a tool call, or the `tools.call.after` seam for observing one. This is
// the sibling of the rule that core never imports a plugin, and it is what lets the LSP plugin react to a
// `files` write without either side knowing the other exists.
describe('bundled plugins — no plugin imports another plugin', () => {
  it('finds the bundled plugins to check', () => {
    expect(bundledPlugins).toContain('files');
    expect(bundledPlugins.length).toBeGreaterThan(1);
  });

  it.each(bundledPlugins)('%s imports nothing from another plugin', (plugin) => {
    const own = join(pluginsDir, plugin);
    const offenders: string[] = [];
    for (const file of modulesOf(plugin)) {
      for (const spec of specifiersOf(readFileSync(file, 'utf-8'))) {
        const isRelative = spec.startsWith('.');
        // A relative specifier must stay inside the plugin's own directory…
        if (isRelative) {
          const target = resolve(dirname(file), spec);
          const outside = relative(own, target).startsWith('..');
          if (outside) offenders.push(`${relative(repoRoot, file)} → ${spec}`);
          continue;
        }
        // …and an absolute or bare one must not name a sibling plugin's directory.
        const named = bundledPlugins.find((other) => other !== plugin
          && (spec.includes(`plugins/${other}/`) || spec.endsWith(`plugins/${other}`)));
        if (named !== undefined || (isAbsolute(spec) && !relative(pluginsDir, spec).startsWith('..'))) {
          offenders.push(`${relative(repoRoot, file)} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
