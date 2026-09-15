/**
 * Every bundled plugin has to expose the entry shape the loader resolves.
 *
 * `loadPlugins` imports `manifest.entry` and requires a NAMED `register` function (loader.ts). A default
 * export satisfies the type checker, every unit test that calls the function directly, and the whole
 * gate chain — and then the daemon logs `plugin skipped: <name>: entry does not export register()` and
 * the plugin simply is not there. That is exactly how code mode shipped dead: nothing in the suite went
 * through the loader's contract, so the one thing the daemon actually asks for was never asked here.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const pluginsDir = join(repoRoot, 'plugins');

/** The module to import for a plugin's entry.
 *
 *  A TypeScript plugin's manifest points at its BUILD (`dist/index.js`), which may not exist in a fresh
 *  checkout. Its source is the same module, so the export surface is measured there — the compiler
 *  renames nothing. A hand-written `.mjs` plugin is imported exactly as the loader would. */
function entryModule(name: string, entry: string): string | undefined {
  const built = join(pluginsDir, name, entry);
  if (entry.startsWith('dist/')) {
    const source = join(pluginsDir, name, 'src', `${entry.slice('dist/'.length).replace(/\.js$/, '')}.ts`);
    if (existsSync(source)) return source;
  }
  return existsSync(built) ? built : undefined;
}

const bundled = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(pluginsDir, e.name, 'elowen-plugin.json')))
  .map((e) => {
    const manifest = JSON.parse(readFileSync(join(pluginsDir, e.name, 'elowen-plugin.json'), 'utf-8')) as { entry: string };
    return { name: e.name, entry: manifest.entry };
  });

describe('bundled plugin entries', () => {
  it('finds bundled plugins to check', () => {
    expect(bundled.length).toBeGreaterThan(5);
  });

  it.each(bundled)('$name exports register()', async ({ name, entry }) => {
    const module = entryModule(name, entry);
    expect(module, `${name}: manifest entry "${entry}" resolves to no importable module`).toBeDefined();
    const loaded = (await import(module!)) as Record<string, unknown>;
    expect(typeof loaded.register, `${name} must export a named register function, not only a default`).toBe('function');
  });
});
