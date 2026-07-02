import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseManifest } from './manifest.js';
import type { PluginManifest } from './manifest.js';
import { PluginRegistry } from './registry.js';
import type { PluginLogger, PluginModule } from './api.js';

/** A plugin found on disk (manifest parsed, code NOT imported). What the admin UI lists. */
export interface DiscoveredPlugin {
  manifest: PluginManifest;
  dir: string;
  /** Which scan root it came from: the Orca install ('bundled') or the instance data dir ('user'). */
  source: 'bundled' | 'user';
}

/** Scan `dirs` for plugin folders and parse their manifests WITHOUT importing any code — safe to call
 *  from a request handler. The first occurrence of a name wins (bundled dir is scanned first), matching
 *  the loader's dedupe rule. A folder with a broken manifest is skipped silently (the loader logs it at
 *  load time; the listing simply doesn't show it as installable). */
export function discoverPlugins(dirs: string[]): DiscoveredPlugin[] {
  const found: DiscoveredPlugin[] = [];
  const seen = new Set<string>();
  dirs.forEach((dir, i) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (seen.has(name)) continue;
      const pluginDir = join(dir, name);
      try {
        if (!statSync(pluginDir).isDirectory()) continue;
        const manifest = parseManifest(JSON.parse(readFileSync(join(pluginDir, 'orca-plugin.json'), 'utf-8')));
        if (manifest.name !== name) continue;
        seen.add(name);
        found.push({ manifest, dir: pluginDir, source: i === 0 ? 'bundled' : 'user' });
      } catch { /* not a plugin folder (or broken manifest) → not listed */ }
    }
  });
  return found;
}

export interface LoadPluginsOptions {
  /** Directories scanned for plugin folders (bundled first, then user). */
  dirs: string[];
  /** Plugin folder names the admin has enabled; anything else is ignored. */
  enabled: string[];
  /** Per-plugin config slices (secrets included), keyed by plugin name. */
  config?: Record<string, Record<string, unknown>>;
  /** Root for per-plugin writable data dirs (ctx.dataDir()). */
  dataRoot?: string;
  /** Proactive-notification sink exposed to plugins as ctx.notify(). */
  notify?: (text: string) => Promise<void>;
  logger: PluginLogger;
}

/** Discover plugin folders across `dirs`, load the enabled ones, and aggregate their contributions into
 *  a PluginRegistry. Fail-open: a bad manifest / failed import / throwing `register` is logged and the
 *  plugin is skipped — a single broken plugin never crashes the daemon or blocks its siblings. */
export async function loadPlugins(opts: LoadPluginsOptions): Promise<PluginRegistry> {
  const registry = new PluginRegistry();
  const wanted = new Set(opts.enabled);
  const loaded = new Set<string>(); // a name found in an earlier dir wins; don't double-load
  for (const dir of opts.dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!wanted.has(name) || loaded.has(name)) continue;
      const pluginDir = join(dir, name);
      try {
        if (!statSync(pluginDir).isDirectory()) continue;
        const manifest = parseManifest(JSON.parse(readFileSync(join(pluginDir, 'orca-plugin.json'), 'utf-8')));
        if (manifest.name !== name) throw new Error(`manifest name "${manifest.name}" != folder "${name}"`);
        const entryUrl = pathToFileURL(resolve(pluginDir, manifest.entry)).href;
        const mod = (await import(entryUrl)) as Partial<PluginModule>;
        if (typeof mod.register !== 'function') throw new Error('entry does not export register()');
        // Stage the plugin's contributions in a scratch registry and merge only after a clean
        // register() — a plugin that throws halfway must not leave half its tools live.
        const staging = new PluginRegistry();
        const ctx = staging.contextFor(name, opts.config?.[name] ?? {}, opts.logger, opts.dataRoot, opts.notify);
        await mod.register(ctx);
        registry.merge(staging);
        loaded.add(name);
        opts.logger.info(`plugin loaded: ${name}@${manifest.version}`);
      } catch (err) {
        opts.logger.error(`plugin skipped: ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return registry;
}
