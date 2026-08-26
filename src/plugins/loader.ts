import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLUGIN_SHARED_API_VERSION } from 'elowen-plugin-shared';
import { parseManifest } from './manifest.js';
import type { PluginManifest } from './manifest.js';
import { PluginRegistry } from './registry.js';
import type { PluginEmbedder, PluginHostWiring } from './registry.js';
import type { DelegatedChildBridge, PluginDb, PluginLogger, PluginModule, ProviderCredentials } from './api.js';
import type { ElowenEvent } from '../api/sse.js';
import type { McpBridgeSnapshot } from './mcpSnapshot.js';
import type { EmbeddingConfig } from '../embeddings/embeddingService.js';
import type { AskAnswer } from '../brain/events.js';
import type { PluginModelOption } from './api.js';
import type { WorkflowExpansionRpc } from '../subagent/hostRpc.js';

/** Localized overrides for a plugin's user-facing manifest strings, keyed by field key. The manifest's
 *  own English strings stay the source/fallback; a `<lang>.json` supplies translations for other locales. */
interface PluginI18n {
  description?: string;
  fields?: Record<string, { label?: string; hint?: string; options?: Record<string, string> }>;
  /** Localized browser-UI labels + view strings: nav keyed by route (`''` = the root page),
   *  account/settings by id, strings by the manifest `web.strings` keys. */
  web?: { nav?: Record<string, string>; account?: Record<string, string>; settings?: Record<string, string>; strings?: Record<string, string> };
}

/** A plugin found on disk (manifest parsed, code NOT imported). What the admin UI lists. */
export interface DiscoveredPlugin {
  manifest: PluginManifest;
  dir: string;
  /** Which scan root it came from: the Elowen install ('bundled') or the instance data dir ('user'). */
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

const PLATFORM_PROMPT_MAX_FILES = 16;
const PLATFORM_PROMPT_MAX_FILE_CHARS = 8_000;
const PLATFORM_PROMPT_MAX_TOTAL_CHARS = 32_000;

/** Convention-owned platform instructions. A plugin may place ordered Markdown files in `prompt/`; the
 *  loader applies them only to the platforms that same plugin declares and actually registers. */
function loadPlatformPrompts(pluginDir: string, manifest: PluginManifest, logger: PluginLogger): { platform: string; file: string; text: string }[] {
  const dir = join(pluginDir, 'prompt');
  if (!existsSync(dir)) return [];
  const platforms = [...new Set(manifest.provides?.platforms ?? [])];
  if (!platforms.length) {
    logger.warn(`[plugin:${manifest.name}] prompt/*.md ignored — manifest provides no platforms`);
    return [];
  }
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, PLATFORM_PROMPT_MAX_FILES);
  let remaining = PLATFORM_PROMPT_MAX_TOTAL_CHARS;
  const fragments: { file: string; text: string }[] = [];
  for (const file of files) {
    const path = join(dir, file);
    if (!statSync(path).isFile()) continue;
    let text = readFileSync(path, 'utf-8').trim();
    if (!text) continue;
    if (text.length > PLATFORM_PROMPT_MAX_FILE_CHARS) {
      logger.warn(`[plugin:${manifest.name}] prompt/${file} truncated to ${PLATFORM_PROMPT_MAX_FILE_CHARS} characters`);
      text = text.slice(0, PLATFORM_PROMPT_MAX_FILE_CHARS);
    }
    if (text.length > remaining) {
      if (remaining <= 0) break;
      logger.warn(`[plugin:${manifest.name}] platform prompts truncated to ${PLATFORM_PROMPT_MAX_TOTAL_CHARS} characters total`);
      text = text.slice(0, remaining);
    }
    remaining -= text.length;
    fragments.push({ file, text });
  }
  return platforms.flatMap((platform) => fragments.map((fragment) => ({ platform, ...fragment })));
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
        const manifest = parseManifest(JSON.parse(readFileSync(join(pluginDir, 'elowen-plugin.json'), 'utf-8')));
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
  listModels?: () => Promise<PluginModelOption[]>;
  /** Central provider credential resolver exposed to plugins as ctx.resolveProvider(id). */
  resolveProvider?: (id: string) => ProviderCredentials | null;
  /** The SHARED text→vector embedder (the memory subsystem's EmbeddingService), exposed to plugins as
   *  ctx.embeddings — gated by a `reads:['embeddings']` capability. Threaded together with the config
   *  mapper below so a plugin reuses the operator's ONE embedding model (single source of truth). */
  embeddings?: PluginEmbedder;
  /** The LIVE embedding config mapper (Settings → Memory), read on each embed so a model change applies
   *  without a reload. Pairs with `embeddings` above. */
  embeddingConfig?: () => EmbeddingConfig;
  /** Deliver a parked AskUserQuestion answer, exposed to plugins as ctx.answerQuestion() — for
   *  interactive transports (Discord) that gather the pick out-of-band. */
  answerQuestion?: (id: string, answers: AskAnswer[]) => boolean;
  /** The operator's configured IANA timezone, exposed to plugins as ctx.timezone(). Read live. */
  timezone?: () => string;
  /** The typed sub-agent catalog exposed to plugins as ctx.subagentTypes() (built-in explore/plan + user
   *  `.md` types). Read at plugin register time to compose the Delegate tool description. */
  subagentTypes?: () => { name: string; description: string }[];
  /** Host reloader exposed to plugins as ctx.requestReload() — a plugin that writes a skill/agent to disk
   *  asks the host to re-scan + apply it live (deferred to the end of the current turn). */
  requestReload?: () => void;
  /** The operator's delegated-context budget (Settings → Elowen AI → Limits), exposed to plugins as
   *  ctx.delegateContextChars(). Read live so a change applies without a reload. */
  delegateContextChars?: () => number;
  /** Durable sub-agent persistence, exposed to plugins as ctx.subagentRuns(), ctx.readSubagent(), and
   *  ctx.continueSubagent(). Absent (worker or unit-test wiring) → listing is empty and reads/continuations
   *  are refused. */
  delegatedChildren?: DelegatedChildBridge;
  /** Bridged MCP tool definitions inherited from the process that forked this one, exposed to plugins as
   *  ctx.mcpBridgeSnapshot. Set ONLY by the sub-agent runner: it lets the `mcp` plugin declare the daemon's
   *  bridged tools without connecting a single server at boot (see plugins/mcpSnapshot.ts). Absent in the
   *  daemon, which connects at boot exactly as before. */
  mcpBridgeSnapshot?: McpBridgeSnapshot;
  /** Whether a delegated child turn dispatched from this process may run in a forked runner process,
   *  exposed to plugins as ctx.delegatedTurnsOutOfProcess() (read live per delegation).
   *
   *  Deliberately REQUIRED, unlike its optional siblings: the workflow engine derives a node's whole
   *  expansion contract (briefing + WorkflowAddNodes deny) from this answer, and a caller that silently
   *  fell back to the registry's `false` default would re-invite remote nodes to call a tool that can
   *  only answer "no running workflow" in the runner. A process with no runner states that explicitly
   *  (`() => false`); dropping the wiring in brainCore now fails the typecheck instead of shipping. */
  delegatedTurnsOutOfProcess: () => boolean;
  /** Whether a remote child dispatched by this process can call the daemon's workflow engine back. Absent
   *  is the compatibility fallback and keeps WorkflowAddNodes denied in that child. */
  delegatedWorkflowExpansionAvailable?: () => boolean;
  /** Runner-only reverse RPC client. Ordinary daemon plugin instances never receive it. */
  workflowExpansionRpc?: WorkflowExpansionRpc;
  /** Per-plugin main-database handle factory, exposed to plugins as ctx.db() — gated by the
   *  `reads:['db']` capability. The daemon wires it with migrations enabled; the sub-agent runner wires
   *  it with migrations as a no-op (it opens the DB `{migrate:false}`). */
  pluginDb?: (plugin: string) => PluginDb;
  /** Event-bus publish sink exposed to plugins as ctx.publishEvent() — gated by `mutates:['events']`.
   *  Wired in the daemon; absent in the sub-agent runner (its plugin instances have no SSE audience). */
  publishEvent?: (e: ElowenEvent) => void;
  /** Host capabilities exposed to plugins as ctx.host.* (tmux, brain worker, agent CLI credentials,
   *  typed store seams) — each accessor behind its own `reads` grant. Wired by the daemon core. */
  host?: PluginHostWiring;
  /** Event-bus SUBSCRIBE sink exposed as ctx.subscribeEvents() — gated by `mutates:['events']`. The
   *  registry tracks the subscriptions so a reload detaches the whole old generation. */
  subscribeEvents?: (fn: (e: ElowenEvent) => void) => () => void;
  /** Activity-log purge sink exposed as ctx.deleteEventsForTarget() — gated by `mutates:['events']`,
   *  like the two above. Absent in a process without an event store; the verb then no-ops. */
  deleteEvents?: (target: string) => void;
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
    // Sort plugin folders by name before loading: tool registration order is part of the cached prompt
    // prefix, so it must not depend on the filesystem's readdir order (which varies across machines and
    // restarts). Locale-independent compare on purpose — localeCompare depends on the process locale.
    const names = readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      if (!wanted.has(name) || loaded.has(name)) continue;
      const pluginDir = join(dir, name);
      try {
        if (!statSync(pluginDir).isDirectory()) continue;
        // A folder without a manifest is not a plugin, so treat it exactly like an absent folder rather
        // than reporting a failure. The usual source is the gitignored build output (web/index.js) left
        // behind when a plugin is deleted from the bundle: the name still loads fine from the next dir,
        // and an ERROR logged next to a successful load only teaches people to ignore the log. A folder
        // that IS a plugin but is broken (unreadable or invalid manifest, name mismatch) still fails
        // loudly, and an enabled plugin that no dir provides is reported once at the end.
        if (!existsSync(join(pluginDir, 'elowen-plugin.json'))) continue;
        const manifest = parseManifest(
          JSON.parse(readFileSync(join(pluginDir, 'elowen-plugin.json'), 'utf-8')),
          (message) => opts.logger.warn(`[plugin:${name}] ${message}`),
        );
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
        // `toolNames` deliberately closes over the MERGED registry, not this plugin's staging one: a plugin
        // asks it at tool-execute time, long after every plugin has merged, and needs the whole live
        // toolset (the subagent plugin validates a caller's `tools` allow-list against it).
        const ctx = staging.contextFor(name, opts.config?.[name] ?? {}, opts.logger, opts.dataRoot, opts.notify, opts.listModels, opts.resolveProvider, manifest.capabilities ?? {}, manifest.provides, opts.answerQuestion, opts.embeddings, opts.embeddingConfig, () => registry.tools.map((t) => t.name), opts.timezone, opts.subagentTypes, opts.requestReload,
          // Like `toolNames`, this closes over the MERGED registry (not the staging one): the adapter reads it
          // long after every plugin has merged, so it must see the whole live set of plugin prompt commands.
          () => [...registry.commands.values()].map((c) => ({ name: c.name, description: c.description, prompt: c.prompt, surfaces: c.surfaces, plugin: registry.commandOwner.get(c.name) })),
          opts.delegateContextChars, opts.delegatedChildren, opts.mcpBridgeSnapshot, opts.delegatedTurnsOutOfProcess,
          opts.delegatedWorkflowExpansionAvailable,
          // Reverse mutation of a daemon-owned DAG is gated INSIDE contextFor by the manifest's declared
          // `mutates:['workflow-dag']` capability — a plugin that does not declare it gets null. The loader
          // deliberately no longer knows which plugin owns the workflow surface.
          opts.workflowExpansionRpc,
          opts.pluginDb, opts.publishEvent, opts.host, opts.subscribeEvents,
          // ctx.control(): resolve a SIBLING plugin's control. Closes over the MERGED registry for the
          // same reason `toolNames` does, and here it is load-bearing rather than convenient: plugins are
          // loaded name-sorted, so a consumer ('agents') can easily register BEFORE the owner ('work')
          // exists. Resolving at call time — long after every plugin has merged — makes the dependency
          // work in either order, and makes a reload swap the owner underneath the caller for free.
          (name) => registry.control(name),
          opts.deleteEvents);
        await mod.register(ctx);
        const registeredPlatforms = new Set(staging.platforms.map((platform) => platform.name));
        for (const fragment of loadPlatformPrompts(pluginDir, manifest, opts.logger)) {
          if (!registeredPlatforms.has(fragment.platform)) {
            opts.logger.warn(`[plugin:${name}] prompt/${fragment.file} ignored for '${fragment.platform}' — plugin did not register that platform`);
            continue;
          }
          staging.addPlatformPrompt(name, fragment.platform, fragment.file, fragment.text);
        }
        registry.merge(staging, (m) => opts.logger.warn(`[plugin:${name}] ${m}`));
        // Capture the plugin's declared capabilities (deny-by-default `{}` when absent) — the manifest
        // is otherwise discarded here, but the hook bus needs these to gate this plugin's mutations.
        registry.setCapabilities(name, manifest.capabilities ?? {});
        registry.setUserGrantable(name, manifest.userGrantable);
        // A plugin that keeps state PER ACCOUNT has to be told when an account goes away — nothing else
        // reaps its folders or rows. The two manifest flags that mean "this plugin is per-account" are the
        // only signal the host has, so say it out loud at load time rather than discovering the leftovers
        // months later. Not fatal: the plugin is otherwise fine, and refusing to load it would be worse.
        if ((manifest.userGrantable === true || (manifest.userConfigSchema?.length ?? 0) > 0)
          && !staging.userRemovedHandlers.some((h) => h.plugin === name)) {
          opts.logger.warn(`[plugin:${name}] keeps per-account state but registers no registerUserRemoved handler — a deleted account's data will be left behind`);
        }
        // A grant withholds this plugin's TOOLS, its HTTP routes and its web UI. Everything else a plugin
        // can contribute reaches a session unfiltered — prompt fragments and slash commands are merged
        // into the system prompt for everyone, and hooks run on everyone's tool calls. That is fine for
        // today's grant-gated plugins because none of them register any; it would open silently the day
        // one did, so the load says it out loud instead.
        if (manifest.userGrantable === true) {
          const ungated = [
            staging.promptFragments.length > 0 ? 'prompt fragments' : '',
            staging.platformPromptFragments.size > 0 ? 'platform prompts' : '',
            staging.commands.size > 0 ? 'slash commands' : '',
            staging.hooks.length > 0 ? 'hooks' : '',
          ].filter((x) => x !== '');
          if (ungated.length > 0) {
            opts.logger.warn(`[plugin:${name}] is user-grantable but registers ${ungated.join(' + ')}, which reach every session regardless of the grant`);
          }
        }
        registry.setIcons(manifest.icons);
        registry.setShowOutput(manifest.showOutput);
        registry.setPlanSafe(manifest.planSafe, manifest.provides, (m) => opts.logger.warn(`[plugin:${name}] ${m}`));
        registry.setDeferLoading(name, manifest.deferLoading, (m) => opts.logger.warn(`[plugin:${name}] ${m}`));
        // Browser UI bundle (manifest-declared): resolve inside the plugin dir (same escape rule as the
        // entry), content-hash it now so the serving route can pin an immutable URL, and carry the
        // manifest's nav/settings metadata — menus must render before (and without) the bundle's JS.
        if (manifest.web) {
          const webPath = resolve(pluginDir, manifest.web.entry);
          if (webPath !== pluginDir && !webPath.startsWith(pluginDir + sep)) throw new Error(`web entry "${manifest.web.entry}" escapes plugin dir`);
          if (!existsSync(webPath)) {
            opts.logger.warn(`[plugin:${name}] web bundle missing at ${manifest.web.entry} — UI skipped`);
          } else {
            const hash = createHash('sha256').update(readFileSync(webPath)).digest('hex').slice(0, 16);
            // The plugin's own stylesheet, resolved and hashed exactly like the bundle. A prebuilt host
            // web app cannot generate the utilities a plugin needs, so a registry plugin ships them; a
            // plugin without `css` keeps the old behaviour (host utilities only) with no undefined URL.
            let css: { cssFile: string; cssHash: string } | undefined;
            if (manifest.web.css) {
              const cssPath = resolve(pluginDir, manifest.web.css);
              if (cssPath !== pluginDir && !cssPath.startsWith(pluginDir + sep)) throw new Error(`web css "${manifest.web.css}" escapes plugin dir`);
              if (!existsSync(cssPath)) {
                // Same shape as the missing-bundle warning above: the UI still loads, it just paints
                // with whatever the host happens to carry — which is precisely the silent breakage this
                // whole path exists to end, so it has to be audible in the log.
                opts.logger.warn(`[plugin:${name}] web stylesheet missing at ${manifest.web.css} — styles skipped`);
              } else {
                css = { cssFile: cssPath, cssHash: createHash('sha256').update(readFileSync(cssPath)).digest('hex').slice(0, 16) };
              }
            }
            const i18n = loadPluginI18n(pluginDir);
            const webI18n = i18n
              ? Object.fromEntries(Object.entries(i18n).flatMap(([lang, v]) => (v.web ? [[lang, v.web]] : [])))
              : {};
            registry.webUi.set(name, {
              plugin: name, file: webPath, hash,
              ...(css ?? {}),
              requiresApiVersion: manifest.web.requiresApiVersion ?? 1,
              ...(manifest.web.adminOnly ? { adminOnly: true } : {}),
              nav: manifest.web.nav ?? [], account: manifest.web.account ?? [], settings: manifest.web.settings ?? [],
              ...(manifest.web.label ? { label: manifest.web.label } : {}),
              ...(manifest.web.strings ? { strings: manifest.web.strings } : {}),
              ...(Object.keys(webI18n).length > 0 ? { i18n: webI18n } : {}),
            });
          }
        }
        loaded.add(name);
        opts.logger.info(`plugin loaded: ${name}@${manifest.version}`);
      } catch (err) {
        opts.logger.error(`plugin skipped: ${name}: ${explainFailure(err)}`);
      }
    }
  }
  // An enabled plugin that no directory provides used to vanish without a word — the loader simply never
  // reached a folder for it. Say it once, listing the names, so "I enabled it and nothing happened" is
  // answerable from the log. Warn, not error: boot reconcile reinstalls a missing enabled plugin from the
  // registry moments later, and a broken plugin already reported itself above.
  const missing = [...wanted].filter((name) => !loaded.has(name)).sort();
  if (missing.length > 0) {
    opts.logger.warn(`enabled but not found in any plugin directory: ${missing.join(', ')}`);
  }
  return registry;
}

/** The ESM link error Node throws for a binding a module does not export. Paired below with the package
 *  name, so a missing export from anything else keeps its own unannotated message. */
const MISSING_EXPORT_ERROR = /does not provide an export named/;

/** Turn a load failure into something the log's reader can act on.
 *
 *  The manifest gate (parseManifest → `requiresSharedApi`) refuses a shared-API mismatch before the entry
 *  is imported, so a plugin that DECLARES what it needs never reaches this. What does reach it is a plugin
 *  published before that field existed: its manifest cannot state a contract, so the host has nothing to
 *  compare and the mismatch surfaces the only way it can — as a link-time SyntaxError naming a binding,
 *  from inside `import()`. That message describes a symptom nobody can map back to a cause, so name the
 *  cause next to it. This only makes an already-failed load legible; it does not rescue the plugin. */
function explainFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!MISSING_EXPORT_ERROR.test(message) || !message.includes('elowen-plugin-shared')) return message;
  return `${message} — built against a different elowen-plugin-shared contract than this daemon's (API `
    + `${PLUGIN_SHARED_API_VERSION}); update the plugin, or the daemon to the version it was built for`;
}
