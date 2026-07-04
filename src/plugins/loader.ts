import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseManifest } from './manifest.js';
import type { PluginManifest } from './manifest.js';
import { PluginRegistry } from './registry.js';
import type { PluginLogger, PluginModule, ProviderCredentials } from './api.js';
import type { AskAnswer } from '../brain/events.js';

/** Localized overrides for a plugin's user-facing manifest strings, keyed by field key. The manifest's
 *  own English strings stay the source/fallback; a `<lang>.json` supplies translations for other locales. */
interface PluginI18n {
  description?: string;
  fields?: Record<string, { label?: string; hint?: string }>;
}

/** A plugin found on disk (manifest parsed, code NOT imported). What the admin UI lists. */
export interface DiscoveredPlugin {
  manifest: PluginManifest;
  dir: string;
  /** Which scan root it came from: the Orca install ('bundled') or the instance data dir ('user'). */
  source: 'bundled' | 'user';
  /** Per-locale manifest translations from the plugin's `i18n/<lang>.json` files (empty when none). */
  i18n?: Record<string, PluginI18n>;
}

/** Load a plugin's `i18n/<lang>.json` translation files into a `{ lang: PluginI18n }` map. Each plugin
 *  owns its own translations next to its manifest, so a new plugin ships localized without touching the
 *  app dictionaries. Missing dir or malformed files degrade to the manifest's English strings. */
function loadPluginI18n(pluginDir: string): Record<string, PluginI18n> | undefined {
  const dir = join(pluginDir, 'i18n');
  if (!existsSync(dir)) return undefined;
  const out: Record<string, PluginI18n> = {};
  for (const file of readdirSync(dir)) {
    const m = /^([a-z]{2})\.json$/.exec(file);
    const lang = m?.[1];
    if (!lang) continue;
    try { out[lang] = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as PluginI18n; }
    catch { /* malformed translation file → fall back to manifest English */ }
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
        found.push({ manifest, dir: pluginDir, source: i === 0 ? 'bundled' : 'user', i18n: loadPluginI18n(pluginDir) });
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
  notify?: (text: string, channelId?: string) => Promise<void>;
  /** Model catalog provider exposed to plugins as ctx.listModels(). */
  listModels?: () => Promise<{ provider: string; providerLabel: string; model: string }[]>;
  /** Central provider credential resolver exposed to plugins as ctx.resolveProvider(id). */
  resolveProvider?: (id: string) => ProviderCredentials | null;
  /** Deliver a parked ask_user_question answer, exposed to plugins as ctx.answerQuestion() — for
   *  interactive transports (Discord) that gather the pick out-of-band. */
  answerQuestion?: (id: string, answers: AskAnswer[]) => boolean;
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
        // Resolve the entry inside the plugin dir and refuse one that escapes it (e.g. `../../x.mjs`) —
        // resolve() would otherwise import an arbitrary file. Cheap belt-and-suspenders, and load-bearing
        // once folders can arrive via the marketplace rather than only shipping in the trusted bundle.
        const entryPath = resolve(pluginDir, manifest.entry);
        if (entryPath !== pluginDir && !entryPath.startsWith(pluginDir + sep)) throw new Error(`entry "${manifest.entry}" escapes plugin dir`);
        // Cache-bust the ESM import URL by version+mtime. Node caches modules by URL for the whole process
        // life, so after an in-place marketplace update (same path, new bytes) a plain import() would keep
        // returning the STALE module until a daemon restart. Keying on version+mtime imports fresh code on
        // reload, while an unchanged plugin keeps a stable key across reloads.
        const entryUrl = `${pathToFileURL(entryPath).href}?v=${encodeURIComponent(manifest.version)}-${statSync(entryPath).mtimeMs}`;
        const mod = (await import(entryUrl)) as Partial<PluginModule>;
        if (typeof mod.register !== 'function') throw new Error('entry does not export register()');
        // Stage the plugin's contributions in a scratch registry and merge only after a clean
        // register() — a plugin that throws halfway must not leave half its tools live.
        const staging = new PluginRegistry();
        // Pass the manifest's declared capabilities + provides so the context can enforce them at
        // registration/resolve time (deny-by-default). Absent blocks default to unconstrained tools/
        // platforms and a deny-all provider gate.
        const ctx = staging.contextFor(name, opts.config?.[name] ?? {}, opts.logger, opts.dataRoot, opts.notify, opts.listModels, opts.resolveProvider, manifest.capabilities ?? {}, manifest.provides, opts.answerQuestion);
        await mod.register(ctx);
        registry.merge(staging);
        // Capture the plugin's declared capabilities (deny-by-default `{}` when absent) — the manifest
        // is otherwise discarded here, but the hook bus needs these to gate this plugin's mutations.
        registry.setCapabilities(name, manifest.capabilities ?? {});
        registry.setIcons(manifest.icons);
        loaded.add(name);
        opts.logger.info(`plugin loaded: ${name}@${manifest.version}`);
      } catch (err) {
        opts.logger.error(`plugin skipped: ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return registry;
}
