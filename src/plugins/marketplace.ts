import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { Type } from 'typebox';
import { Check, Errors } from 'typebox/value';
import { parseManifest } from './manifest.js';
import type { DiscoveredPlugin } from './loader.js';
import { KeyedMutex } from '../shared/keyedMutex.js';
import { NAME_RE } from '../shared/nameGrammar.js';
import { isNewer } from '../cli/version.js';
import { readPkgVersion } from '../shared/pkgVersion.js';
import { logger } from '../shared/logger.js';

const log = logger('marketplace');

/** The official curated plugin registry — a single GitHub repo (registry.json + plugins/<name>/) owned
 *  by the project. Installs are allowed ONLY for names listed in its registry.json, so the trust surface
 *  is exactly "do you trust this repo", the same posture as the npm package. Overridable via
 *  ELOWEN_PLUGIN_REGISTRY (used by tests to point at a local bare repo). */
const DEFAULT_REGISTRY_URL = 'https://github.com/dragocz95/elowen-plugins.git';
const DEFAULT_REGISTRY_BRANCH = 'main';

/** Guard rails on a copied plugin tree — a decompression/space-bomb backstop, not a size policy. Most
 *  plugins are a handful of small text files (manifest + one or more .mjs + i18n JSON), but a TypeScript
 *  plugin ships its sources AND its compiled output, which roughly doubles the file count for the same
 *  code: the largest one is a little over 300 files for ~1.2 MB. The byte ceiling is what actually bounds
 *  the damage here, and it is untouched — the file count only needs enough headroom that a legitimate
 *  plugin can keep growing without tripping a bomb guard. */
const MAX_FILES = 800;
const MAX_BYTES = 8 * 1024 * 1024;

/** This daemon's version, for the `requiresCore` gate below. Read from the package the same way the CLI
 *  and /health do, rather than threaded through options, so the check cannot be silently skipped by a
 *  caller that forgot to pass it. */
const CORE_VERSION = readPkgVersion(import.meta.url);

/** One catalog entry as published in the registry's `registry.json`. Only `name` is security-load-bearing
 *  (it becomes a path segment and the install allowlist key); the rest are display hints for the card and
 *  are never trusted for a filesystem or version decision. */
export interface RegistryEntry {
  name: string;
  version: string;
  description: string;
  category?: string;
  author?: string;
  homepage?: string;
  apiVersion?: string;
  provides?: { tools?: number; skills?: number; platforms?: number };
}

/** A marketplace catalog row: a registry entry plus its on-disk status. */
interface MarketplaceEntry extends RegistryEntry {
  /** `available` — in the registry, not on disk. `installed` — present as a user plugin, up to date.
   *  `updateAvailable` — a user plugin with a newer version in the registry. `bundled` — the name is
   *  owned by a built-in plugin, so the marketplace never offers to install/update it. */
  status: 'available' | 'installed' | 'updateAvailable' | 'bundled';
  /** The version currently on disk (installed/updateAvailable/bundled only). */
  installedVersion?: string;
}

export interface Marketplace {
  plugins: MarketplaceEntry[];
  /** Set when the registry could not be reached or refreshed (offline, missing repo, git absent, malformed
   *  index). Lets the UI show "marketplace unavailable" instead of the misleading "no plugins available". */
  registryError?: string;
}

/** An error carrying the HTTP status the route should map it to. */
export class MarketplaceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'MarketplaceError';
  }
}

const RegistrySchema = Type.Object({
  schema: Type.Optional(Type.Number()),
  plugins: Type.Array(Type.Object({
    name: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
    description: Type.String(),
    category: Type.Optional(Type.String()),
    author: Type.Optional(Type.String()),
    homepage: Type.Optional(Type.String()),
    apiVersion: Type.Optional(Type.String()),
    provides: Type.Optional(Type.Object({
      tools: Type.Optional(Type.Number()),
      skills: Type.Optional(Type.Number()),
      platforms: Type.Optional(Type.Number()),
    })),
  })),
});

/** Parse + validate a `registry.json`. Fail-closed: an invalid index throws (→ empty catalog + error),
 *  never a partial install of junk. Entries whose name doesn't match NAME_RE — or that repeat one — are
 *  dropped, so a typo'd/hostile name can never reach the filesystem layer. */
export function parseRegistry(raw: unknown): RegistryEntry[] {
  if (!Check(RegistrySchema, raw)) {
    const first = [...Errors(RegistrySchema, raw)][0];
    throw new Error(`invalid registry.json: ${first ? `${first.instancePath || '/'} ${first.message}` : 'shape mismatch'}`);
  }
  const seen = new Set<string>();
  const out: RegistryEntry[] = [];
  for (const p of (raw as { plugins: RegistryEntry[] }).plugins) {
    if (!NAME_RE.test(p.name) || seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(p);
  }
  return out;
}

/** Injectable IO so clone/refresh and the clock are unit-testable without a real git or network — mirrors
 *  the `ReinstallIO` seam in `cli/update.ts`. */
export interface MarketplaceIO {
  exec: (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<{ stdout: string }>;
  now: () => number;
  rand: () => string;
}

const runExec = promisify(execFile);
const defaultIO: MarketplaceIO = {
  exec: async (cmd, args, opts) => {
    const { stdout } = await runExec(cmd, args, {
      cwd: opts?.cwd,
      env: opts?.env,
      timeout: opts?.timeoutMs ?? 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: String(stdout) };
  },
  now: () => Date.now(),
  rand: () => Math.random().toString(36).slice(2, 10),
};

export interface MarketplaceServiceOptions {
  /** Registry repo clone URL (constant; ELOWEN_PLUGIN_REGISTRY override resolved by the caller). */
  registryUrl?: string;
  registryBranch?: string;
  /** Where the registry repo is shallow-cloned (a mirror used for both catalog reads and install copies). */
  cacheDir: string;
  /** The WRITABLE plugin scan root (`pluginDirs[1]`). NEVER the bundled dir — that's npm-owned. */
  userPluginsDir: string;
  /** The host's `node_modules`, symlinked into each installed plugin so its bare SDK imports
   *  (`@earendil-works/…`, `typebox`) resolve — a user-dir plugin lives outside the Elowen tree and can't
   *  reach them otherwise. Unset in tests (they never import the copied plugin). */
  hostNodeModules?: string;
  /** Root of per-plugin writable data dirs; a plugin's data is `<pluginDataRoot>/<name>`. */
  pluginDataRoot?: string;
  /** Skip a `git fetch` when the cache was refreshed within this window (default 15 min). */
  ttlMs?: number;
  /** Current on-disk plugins (wraps `discoverPlugins(pluginDirs)`) — the source of truth for status. */
  discovered: () => DiscoveredPlugin[];
  getEnabled: () => string[];
  setEnabled: (names: string[]) => void;
  /** Drop the memoized registry + hot-reload running sessions (`brain.reloadPlugins`). Resolves
   *  `applied` when the registry was actually rebuilt, and `deferred` when the daemon parked the swap
   *  because work was still running — a deferral is NOT a failure and NOT an apply, so the caller keeps
   *  its rollback copy and finishes when `settleDeferredApplies()` runs. Throws only when the rebuild
   *  itself failed. */
  reload: () => Promise<PluginApplyOutcome>;
  /** The plugin names the CURRENT registry actually loaded. This is how an apply proves the new folder
   *  survived import/register before the rollback copy is dropped — read after a reload, never cached. */
  loadedNames: () => Promise<ReadonlySet<string>>;
  io?: Partial<MarketplaceIO>;
}

/** What a swap attempt achieved. `deferred` means the files are in place but the daemon has not rebuilt
 *  itself around them yet: the change is not lost, it lands when running work settles. */
export type PluginApplyOutcome = 'applied' | 'deferred';

/** Downloads plugins from the curated registry into the writable user plugin dir and manages their
 *  lifecycle (install / update / uninstall), all live-applied via `reload()`. The registry is kept as a
 *  local shallow clone (git is already a hard dep) which doubles as the catalog source and the install
 *  payload — one mechanism, offline-tolerant, no extra dependency. */
export class MarketplaceService {
  private readonly io: MarketplaceIO;
  private readonly registryUrl: string;
  private readonly branch: string;
  private readonly cacheDir: string;
  private readonly ttlMs: number;
  private readonly lock = new KeyedMutex();
  private lastFetch = 0;
  /** Swaps whose files are live but whose registry rebuild was deferred while work was running, keyed by
   *  plugin name. Each holds the ONLY copy of the previous version, so it is kept until
   *  `settleDeferredApplies()` can see whether the rebuild actually loaded the plugin. */
  private readonly deferredApplies = new Map<string, { commit: () => void; rollback: () => void }>();
  /** Reentrancy guard for `settleDeferredApplies` — its own rollback reload fires the hook that calls it. */
  private settling = false;

  constructor(private readonly opts: MarketplaceServiceOptions) {
    this.io = { ...defaultIO, ...opts.io };
    this.registryUrl = opts.registryUrl || DEFAULT_REGISTRY_URL;
    this.branch = opts.registryBranch || DEFAULT_REGISTRY_BRANCH;
    this.cacheDir = opts.cacheDir;
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
  }

  /** The curated catalog, cross-referenced with what's on disk. Degrades gracefully: on any refresh/parse
   *  failure it serves the last-good cache (or an empty list) plus a `registryError`, never throwing. */
  async catalog(force = false): Promise<Marketplace> {
    return this.lock.run('marketplace', async () => {
      let registryError: string | undefined;
      try { await this.ensureFresh(force); }
      catch (e) { registryError = errMsg(e); }

      let entries: RegistryEntry[];
      try { entries = this.readRegistry(); }
      catch (e) { return { plugins: [], registryError: registryError ?? errMsg(e) }; }

      const onDisk = new Map(this.opts.discovered().map((p) => [p.manifest.name, p]));
      const plugins = entries.map((e): MarketplaceEntry => {
        const disk = onDisk.get(e.name);
        if (!disk) return { ...e, status: 'available' };
        if (disk.source === 'bundled') return { ...e, status: 'bundled', installedVersion: disk.manifest.version };
        // A user plugin: authoritative versions come from manifests, not the display-only registry field.
        const cacheVersion = this.cacheManifestVersion(e.name) ?? e.version;
        const status = isNewer(cacheVersion, disk.manifest.version) ? 'updateAvailable' : 'installed';
        return { ...e, status, installedVersion: disk.manifest.version };
      });
      return { plugins, registryError };
    });
  }

  /** Install a registry plugin into the user dir and (by default) enable it. Rejects a name absent from the
   *  registry or owned by a built-in plugin. Atomic: a validated staging copy is swapped in, so a failure
   *  never leaves a half-written folder under the real name.
   *
   *  Resolves `deferred` when the files landed but the daemon was too busy to rebuild its registry around
   *  them yet — installed, activating shortly, not failed. */
  async install(name: string, opts: { enable?: boolean } = {}): Promise<PluginApplyOutcome> {
    return this.lock.run('marketplace', async () => {
      this.ensureSafeName(name);
      // Same degradation as catalog(): the install payload comes from the cache on disk, so a failed
      // refresh is not a reason to refuse one the cache can already satisfy — it is the very cache the
      // catalog the caller is acting on was rendered from. This is also what lets reconcileEnabled()
      // restore a plugin during an offline boot, since it goes through here. A cache that cannot be READ
      // is still fatal, and the refresh error is reported with it rather than swallowed.
      let registryError: string | undefined;
      try { await this.ensureFresh(false); }
      catch (e) { registryError = errMsg(e); }

      let entries: RegistryEntry[];
      try { entries = this.readRegistry(); }
      catch (e) { throw new MarketplaceError(`the plugin registry is unavailable: ${registryError ?? errMsg(e)}`, 503); }
      if (!entries.some((e) => e.name === name)) throw new MarketplaceError(`plugin "${name}" is not in the registry`, 404);
      if (registryError) log.warn(`registry refresh failed (${registryError}) — installing "${name}" from the last-good cache`);

      const existing = this.opts.discovered().find((p) => p.manifest.name === name);
      if (existing?.source === 'bundled') throw new MarketplaceError(`"${name}" is a built-in plugin, managed by the app`, 409);

      const swap = this.copyFromCache(name);

      if (opts.enable ?? true) {
        const enabled = this.opts.getEnabled();
        if (!enabled.includes(name)) this.opts.setEnabled([...enabled, name]);
      }
      // Guard against the loader's "bundled wins" dedupe silently shadowing the fresh folder.
      const after = this.opts.discovered().find((p) => p.manifest.name === name);
      if (!after || after.source !== 'user') {
        swap.rollback();
        throw new MarketplaceError(`installed "${name}" but it did not resolve as a user plugin`, 500);
      }
      const outcome = await this.applyOrRollback(name, swap);
      log.info(`plugin installed: ${name}`);
      return outcome;
    });
  }

  /** Re-copy a newer version of an already-installed user plugin from the refreshed cache, then hot-reload. */
  async update(name: string): Promise<PluginApplyOutcome> {
    return this.lock.run('marketplace', async () => {
      this.ensureSafeName(name);
      const existing = this.opts.discovered().find((p) => p.manifest.name === name);
      if (!existing) throw new MarketplaceError(`"${name}" is not installed`, 404);
      if (existing.source !== 'user') throw new MarketplaceError(`"${name}" is a built-in plugin`, 409);
      await this.ensureFresh(true);
      if (!this.readRegistry().some((e) => e.name === name)) throw new MarketplaceError(`"${name}" is not in the registry`, 404);
      const swap = this.copyFromCache(name);
      const outcome = await this.applyOrRollback(name, swap);
      log.info(`plugin updated: ${name}`);
      return outcome;
    });
  }

  /** Remove a user plugin: disable it, delete its folder AND its persistent data, then hot-reload. Refuses
   *  built-in plugins (they live in the npm-owned bundled dir). Order matters — disable before deleting so
   *  no live session imports a half-removed folder, reload last. */
  async uninstall(name: string): Promise<void> {
    return this.lock.run('marketplace', async () => {
      this.ensureSafeName(name);
      const existing = this.opts.discovered().find((p) => p.manifest.name === name);
      if (!existing) throw new MarketplaceError(`"${name}" is not installed`, 404);
      if (existing.source !== 'user') throw new MarketplaceError(`"${name}" is a built-in plugin and cannot be removed`, 409);

      const enabled = this.opts.getEnabled();
      if (enabled.includes(name)) this.opts.setEnabled(enabled.filter((n) => n !== name));

      rmSync(join(this.opts.userPluginsDir, name), { recursive: true, force: true });
      // A delete removes the files too: drop the plugin's persistent data. `name` is NAME_RE-validated,
      // so it is a safe single segment under the data root.
      if (this.opts.pluginDataRoot) rmSync(join(this.opts.pluginDataRoot, name), { recursive: true, force: true });

      await this.opts.reload();
      log.info(`plugin uninstalled: ${name}`);
    });
  }

  /** Reinstall plugins the operator has ENABLED that are no longer on disk, when the registry offers
   *  them. This is what makes moving a plugin out of the npm package survivable: an upgrade that drops
   *  a bundled plugin would otherwise leave the name enabled with nothing behind it, and the loader
   *  would skip it in silence — the operator would just find the feature gone.
   *
   *  Deliberately narrow. It only touches names ALREADY enabled (so it installs nothing the operator did
   *  not ask for), only from the curated registry (the same single source an explicit install uses), and
   *  it never changes what is enabled. Offline, or a name the registry does not carry, is not an error:
   *  the plugin stays missing exactly as it is today and the reason is logged once. Returns the names
   *  actually installed, so the caller can decide whether a reload is worth it. */
  async reconcileEnabled(): Promise<string[]> {
    const onDisk = new Set(this.opts.discovered().map((p) => p.manifest.name));
    const missing = this.opts.getEnabled().filter((n) => !onDisk.has(n));
    if (!missing.length) return [];

    // Degrade exactly as catalog() does — a refresh failure must NOT discard a cache that is already on
    // disk. `lastFetch` is process-local, so the first reconcile of every boot always refreshes: treating
    // that refresh as fatal meant an offline boot threw away enabled-but-missing plugins whose payload was
    // sitting in the cache, fully installable (copyFromCache reads nothing but disk). Only an unreadable
    // cache is actually fatal here; the refresh error stays in the log either way.
    let registryError: string | undefined;
    try { await this.ensureFresh(false); }
    catch (e) { registryError = errMsg(e); }

    let available: Set<string>;
    try { available = new Set(this.readRegistry().map((e) => e.name)); }
    catch (e) {
      log.warn(`enabled plugins missing from disk (${missing.join(', ')}) and the registry is unavailable: ${registryError ?? errMsg(e)}`);
      return [];
    }
    if (registryError) log.warn(`registry refresh failed (${registryError}) — restoring from the last-good cache`);

    const restored: string[] = [];
    for (const name of missing) {
      if (!available.has(name)) {
        log.warn(`plugin "${name}" is enabled but neither installed nor in the registry — it stays disabled until you reinstall it`);
        continue;
      }
      try {
        // `enable: false` because it is already enabled; install() would otherwise rewrite the config
        // for no reason. Keep install()'s per-plugin validating reload: applyOrRollback must retain each
        // backup until the daemon has rebuilt the registry around that exact restored folder. Bootstrap
        // keeps platform adapters offline until the whole reconcile settles, so none can serve between them.
        await this.install(name, { enable: false });
        restored.push(name);
        log.info(`plugin "${name}" was enabled but missing — restored from the registry`);
      } catch (e) {
        log.warn(`could not restore enabled plugin "${name}" from the registry: ${errMsg(e)}`);
      }
    }
    return restored;
  }

  /** Clear leftover `.staging-*` / `.old-*` scratch dirs from an interrupted install. Called once on
   *  daemon startup so the user plugin dir never accretes crash debris.
   *
   *  This is also what resolves a daemon that died between a deferred install landing on disk and its
   *  apply being proven: the parked swap lives in memory only, so the reboot simply loads the new folder
   *  from disk like any other, and its now-meaningless backup is swept here. A plugin that then fails to
   *  load is reported by the loader and is disable-able, which is the same position an interrupted
   *  daemon leaves every other half-finished write in — no separate recovery path to keep correct. */
  sweep(): void {
    if (!existsSync(this.opts.userPluginsDir)) return;
    for (const entry of readdirSync(this.opts.userPluginsDir)) {
      if (entry.startsWith('.staging-') || entry.startsWith('.old-')) {
        rmSync(join(this.opts.userPluginsDir, entry), { recursive: true, force: true });
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Put a freshly swapped-in version into service, and keep the previous one only until that succeeds.
   *  A reload that throws means the daemon could not rebuild itself around the new version, so the old
   *  folder is restored and re-applied before the failure propagates — reporting the error while leaving
   *  the failed version live and the backup deleted is what makes such an update unrecoverable.
   *
   *  A DEFERRED reload is a third outcome, and collapsing it into either of the other two is wrong. It is
   *  not an apply (nothing has been proven, so the backup must stay), and it is not a failure: the files
   *  are on disk and the daemon applies them the moment running work settles. Rolling back there made an
   *  install from chat impossible by construction — the turn being waited on IS the one that asked for the
   *  install, so the wait can never end in time and every such install undid itself. The swap is parked
   *  instead and resolved by `settleDeferredApplies()`. */
  private async applyOrRollback(name: string, swap: { commit: () => void; rollback: () => void }): Promise<PluginApplyOutcome> {
    let outcome: PluginApplyOutcome;
    try {
      outcome = await this.opts.reload();
      if (outcome === 'applied') await this.verifyLoaded(name);
    } catch (e) {
      swap.rollback();
      await this.opts.reload().catch((re) => log.error(`plugin ${name}: reload after rollback failed: ${errMsg(re)}`));
      throw e;
    }
    if (outcome === 'deferred') {
      this.deferredApplies.set(name, swap);
      log.info(`plugin ${name}: installed on disk; the daemon is busy, so it activates when the running work settles`);
      return 'deferred';
    }
    swap.commit();
    return 'applied';
  }

  /** Finish the swaps that were parked while the daemon was busy — called once a plugin reload has ACTUALLY
   *  rebuilt the registry (wired to the brain's post-apply hook). Only now can the same proof an immediate
   *  apply demands be taken: the plugin is in the rebuilt registry, so the rollback copy is dropped; it is
   *  not, so the previous version goes back in and the registry is rebuilt around it again.
   *
   *  Guarded by a flag rather than the `marketplace` mutex, because both ways of waiting here deadlock.
   *  That mutex is held by the install this runs underneath. And a lock of its own would close on itself:
   *  the rollback path reloads, the reload fires this hook again, and that nested call would wait for the
   *  outer one that is waiting for the reload. The flag makes the nested call a no-op instead — anything
   *  parked in the meantime is unproven either way and belongs to the next real apply, which the brain
   *  already owes it (a deferral re-arms its pending reload). */
  async settleDeferredApplies(): Promise<void> {
    if (this.settling || !this.deferredApplies.size) return;
    this.settling = true;
    try {
      const entries = [...this.deferredApplies];
      this.deferredApplies.clear();
      for (const [name, swap] of entries) {
        try {
          await this.verifyLoaded(name);
          swap.commit();
          log.info(`plugin ${name}: deferred apply landed — the daemon rebuilt itself around the new version`);
        } catch (e) {
          // The previous version comes back and the daemon is rebuilt around IT. What is enabled is not
          // touched: that is the operator's setting, and an enabled name with nothing on disk is exactly
          // the state `reconcileEnabled()` exists to repair on the next boot.
          swap.rollback();
          log.error(`plugin ${name}: deferred apply failed (${errMsg(e)}) — rolled back to the previous version`);
          await this.opts.reload().catch((re) => log.error(`plugin ${name}: reload after rollback failed: ${errMsg(re)}`));
        }
      }
    } finally {
      this.settling = false;
    }
  }

  /** Names still waiting for a deferred apply to be proven — the honest answer to "is this live yet". */
  pendingApplies(): string[] {
    return [...this.deferredApplies.keys()];
  }

  /** A plugin the operator has ENABLED must be in the rebuilt registry, or the daemon could not run the
   *  version just swapped in and the swap has to come back out. A plugin installed inert (`enable:false`)
   *  is not supposed to load, so there is nothing to prove about it. */
  private async verifyLoaded(name: string): Promise<void> {
    if (!this.opts.getEnabled().includes(name)) return;
    if (!(await this.opts.loadedNames()).has(name)) {
      throw new MarketplaceError(`plugin "${name}" did not load into the rebuilt registry`, 500);
    }
  }

  /** Root API mounts that `name` DECLARES, read from the registry cache rather than from disk — for a
   *  plugin that is enabled but not installed, which is precisely when nothing on disk can answer.
   *
   *  This exists so a subsystem that moved out of the npm package into the registry degrades to an
   *  explicit 503 ("enabled but not installed") instead of a bare 404. A 404 tells a caller the endpoint
   *  never existed, which for `/tasks` or `/missions` is a lie that reads as data loss; the boot
   *  reconciler normally reinstalls such a plugin, so reaching this path at all means the registry was
   *  unreachable and the honest answer is "temporarily unavailable".
   *
   *  Best-effort by construction: no cache, no clone yet, unreadable or malformed manifest all mean an
   *  empty list and the caller falls back to 404. Never throws, never touches the network. */
  declaredRootRoutes(name: string): string[] {
    try {
      this.ensureSafeName(name);
      const manifestPath = join(this.cacheDir, 'plugins', name, 'elowen-plugin.json');
      if (!existsSync(manifestPath)) return [];
      return parseManifest(JSON.parse(readFileSync(manifestPath, 'utf-8'))).provides?.apiRoutes ?? [];
    } catch {
      return [];
    }
  }

  private ensureSafeName(name: string): void {
    if (!NAME_RE.test(name)) throw new MarketplaceError('invalid plugin name', 400);
    // Belt-and-suspenders: the validated name must be a plain single segment under each root.
    for (const root of [this.opts.userPluginsDir, join(this.cacheDir, 'plugins')]) {
      const p = resolve(root, name);
      if (p !== join(root, name) || !p.startsWith(root + sep)) throw new MarketplaceError('invalid plugin name', 400);
    }
  }

  private gitEnv(): NodeJS.ProcessEnv {
    // Never prompt for credentials — a private/missing repo must fail fast, not hang the request.
    return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  }

  private async ensureGit(): Promise<void> {
    try { await this.io.exec('git', ['--version'], { timeoutMs: 10_000 }); }
    catch { throw new MarketplaceError('git is not available on this host', 503); }
  }

  /** Refresh the cache clone when forced, stale, or missing — else reuse it. */
  private async ensureFresh(force: boolean): Promise<void> {
    await this.ensureGit();
    const stale = force || !existsSync(join(this.cacheDir, '.git')) || this.io.now() - this.lastFetch > this.ttlMs;
    if (!stale) return;
    await this.refreshCache();
  }

  private async refreshCache(): Promise<void> {
    if (!(await this.cacheHealthy())) {
      // No pre-emptive delete: clone() swaps the new checkout in atomically, so wiping here would only
      // destroy the last-good registry.json whenever the re-clone then fails (offline), turning a
      // degraded catalog into an empty one.
      await this.clone();
      this.lastFetch = this.io.now();
      return;
    }
    await this.io.exec('git', ['-C', this.cacheDir, 'fetch', '--depth', '1', 'origin', this.branch], { env: this.gitEnv(), timeoutMs: 120_000 });
    await this.io.exec('git', ['-C', this.cacheDir, 'reset', '--hard', 'FETCH_HEAD'], { env: this.gitEnv(), timeoutMs: 30_000 });
    this.lastFetch = this.io.now();
  }

  private async cacheHealthy(): Promise<boolean> {
    if (!existsSync(join(this.cacheDir, '.git'))) return false;
    try { await this.io.exec('git', ['-C', this.cacheDir, 'rev-parse', '--is-inside-work-tree'], { env: this.gitEnv(), timeoutMs: 10_000 }); return true; }
    catch { return false; }
  }

  /** Shallow-clone the registry into a sibling temp dir, then rename into place — an interrupted clone can
   *  never leave a valid-looking but partial cache. */
  private async clone(): Promise<void> {
    mkdirSync(dirname(this.cacheDir), { recursive: true });
    const tmp = `${this.cacheDir}.tmp-${this.io.rand()}`;
    rmSync(tmp, { recursive: true, force: true });
    try {
      await this.io.exec('git', [
        'clone', '--depth', '1', '--single-branch', '--branch', this.branch,
        '-c', 'core.autocrlf=false', '-c', 'credential.helper=',
        this.registryUrl, tmp,
      ], { env: this.gitEnv(), timeoutMs: 120_000 });
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    rmSync(this.cacheDir, { recursive: true, force: true });
    renameSync(tmp, this.cacheDir);
  }

  private readRegistry(): RegistryEntry[] {
    const file = join(this.cacheDir, 'registry.json');
    if (!existsSync(file)) throw new Error('registry.json missing from the registry repo');
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(file, 'utf-8')); }
    catch (e) { throw new Error(`registry.json is not valid JSON: ${errMsg(e)}`); }
    return parseRegistry(raw);
  }

  private cacheManifestVersion(name: string): string | null {
    try { return parseManifest(JSON.parse(readFileSync(join(this.cacheDir, 'plugins', name, 'elowen-plugin.json'), 'utf-8'))).version; }
    catch { return null; }
  }

  /** Copy `cache/plugins/<name>` into the user dir atomically: validate a staging copy, then swap it in
   *  over any existing folder with a restore-on-failure backup. Same-filesystem staging (a sibling of the
   *  destination) so the final `rename` can't hit EXDEV.
   *
   *  The previous version survives as a backup until the caller `commit()`s, because the swap alone does
   *  not prove the new version works: whether it is usable is only known after the reload, and by then
   *  deleting the backup would have made the failure unrecoverable. `rollback()` puts the old folder back. */
  private copyFromCache(name: string): { commit: () => void; rollback: () => void } {
    const src = join(this.cacheDir, 'plugins', name);
    if (!existsSync(join(src, 'elowen-plugin.json'))) throw new MarketplaceError(`payload for "${name}" is missing from the registry`, 502);
    // A new swap for a name that still has a parked one supersedes it: the version about to be backed up
    // below IS that pending version, so the older backup is no longer anything to return to. Dropping it
    // through commit() deletes the folder instead of leaving it as debris for sweep() to find.
    const superseded = this.deferredApplies.get(name);
    if (superseded) {
      this.deferredApplies.delete(name);
      superseded.commit();
    }

    mkdirSync(this.opts.userPluginsDir, { recursive: true });
    const staging = join(this.opts.userPluginsDir, `.staging-${name}-${this.io.rand()}`);
    const backup = join(this.opts.userPluginsDir, `.old-${name}-${this.io.rand()}`);
    const final = join(this.opts.userPluginsDir, name);
    rmSync(staging, { recursive: true, force: true });

    try {
      // verbatimSymlinks: copy links as-is (never dereference) so validateTree can reject them — otherwise
      // a symlinked `index.mjs -> /etc/passwd` would be silently materialized and later imported.
      cpSync(src, staging, { recursive: true, verbatimSymlinks: true });
      this.validateStaging(name, staging);

      let hadOld = false;
      if (existsSync(final)) { renameSync(final, backup); hadOld = true; }
      try {
        renameSync(staging, final);
        // Link the host node_modules so the plugin's SDK imports resolve (see linkHostModules). Last step
        // so a failure rolls back to the previous version rather than leaving an unloadable plugin live.
        this.linkHostModules(final);
      } catch (e) {
        rmSync(final, { recursive: true, force: true });
        if (hadOld) renameSync(backup, final);
        throw e;
      }
      return {
        commit: () => { if (hadOld) rmSync(backup, { recursive: true, force: true }); },
        rollback: () => {
          rmSync(final, { recursive: true, force: true });
          if (hadOld) renameSync(backup, final);
        },
      };
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e instanceof MarketplaceError ? e : new MarketplaceError(`install of "${name}" failed: ${errMsg(e)}`, 400);
    }
  }

  /** Symlink `<pluginDir>/node_modules -> hostNodeModules` so the plugin's bare SDK imports resolve —
   *  the same `node_modules -> <host>` convention manually-installed user plugins already use. No-op when
   *  the host path is unset (tests) or a node_modules already exists. Throws on failure so the caller rolls
   *  back (an unresolvable plugin is worse than a clean failure). Uninstall's rmSync only unlinks this
   *  symlink — it never recurses into the shared host modules (verified). */
  private linkHostModules(pluginDir: string): void {
    if (!this.opts.hostNodeModules) return;
    const link = join(pluginDir, 'node_modules');
    if (existsSync(link)) return;
    symlinkSync(this.opts.hostNodeModules, link, 'dir');
  }

  private validateStaging(name: string, dir: string): void {
    let files = 0;
    let bytes = 0;
    const walk = (d: string): void => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        if (ent.isSymbolicLink()) throw new Error(`symlink not allowed: ${ent.name}`);
        const full = join(d, ent.name);
        if (ent.isDirectory()) { walk(full); continue; }
        if (!ent.isFile()) throw new Error(`unexpected entry: ${ent.name}`);
        files += 1;
        if (files > MAX_FILES) throw new Error(`too many files (> ${MAX_FILES})`);
        bytes += statSync(full).size;
        if (bytes > MAX_BYTES) throw new Error(`plugin exceeds ${MAX_BYTES} bytes`);
      }
    };
    walk(dir);
    if (files === 0) throw new Error('empty plugin folder');

    const manifest = parseManifest(JSON.parse(readFileSync(join(dir, 'elowen-plugin.json'), 'utf-8')));
    if (manifest.name !== name) throw new Error(`manifest name "${manifest.name}" != "${name}"`);
    // Refuse a plugin that needs a newer daemon than this one, HERE rather than at load time. A plugin
    // compiled against a newer core installs perfectly happily and then throws inside register(ctx) on
    // the first missing API — which the loader catches and logs as "plugin skipped", so the user is left
    // with a feature that is quietly absent and no indication why. Failing the install says it out loud
    // and leaves nothing half-applied.
    if (manifest.requiresCore && isNewer(manifest.requiresCore, CORE_VERSION)) {
      throw new Error(
        `"${name}" needs Elowen ${manifest.requiresCore} or newer, but this daemon is ${CORE_VERSION} — update Elowen first`,
      );
    }
    const entryPath = resolve(dir, manifest.entry);
    if (entryPath !== dir && !entryPath.startsWith(dir + sep)) throw new Error(`entry "${manifest.entry}" escapes plugin dir`);
    if (!existsSync(entryPath)) throw new Error(`entry "${manifest.entry}" not found`);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
