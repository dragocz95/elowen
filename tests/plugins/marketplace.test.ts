import { describe, it, expect, vi, afterEach } from 'vitest';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketplaceService, parseRegistry, MarketplaceError } from '../../src/plugins/marketplace.js';
import { discoverPlugins } from '../../src/plugins/loader.js';

// setup() runs once per test and roots everything under one temp dir, so sweeping them after each
// test is enough; without this the suite left a directory behind on every single case.
let dirs: string[] = [];
const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

/** One plugin folder (manifest + entry) inside a `plugins/<name>` root. */
function writePlugin(pluginsRoot: string, name: string, version: string, requiresCore?: string): string {
  const dir = join(pluginsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name, version, apiVersion: '1', description: `${name} plugin`, entry: 'index.mjs',
    ...(requiresCore ? { requiresCore } : {}),
    provides: { tools: [`${name}_tool`] },
  }));
  writeFileSync(join(dir, 'index.mjs'), 'export function register(){}');
  return dir;
}

/** Build a registry-repo fixture: registry.json + plugins/<name>/ for each entry. */
function writeRegistryFixture(root: string, entries: { name: string; version: string; requiresCore?: string }[], extraNames: string[] = []): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'registry.json'), JSON.stringify({
    schema: 1,
    plugins: [...entries, ...extraNames.map((name) => ({ name, version: '9.9.9', description: 'hostile' }))]
      .map((e) => ({ ...e, description: (e as { description?: string }).description ?? `${e.name} desc`, category: 'utility' })),
  }));
  const pluginsDir = join(root, 'plugins');
  for (const e of entries) writePlugin(pluginsDir, e.name, e.version, e.requiresCore);
}

/** A fake `git` exec: `clone` copies the fixture registry into the target dir; the rest no-op. When
 *  `net.offline` is set, only the commands that actually reach the network fail — a local `rev-parse`
 *  on an existing clone still answers, which is precisely the shape of a daemon booting without a link. */
function fakeGit(fixtureRegistry: string, opts: { failRevParse?: boolean; calls?: string[]; net?: { offline: boolean } } = {}) {
  return vi.fn(async (cmd: string, args: string[]) => {
    opts.calls?.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args[0] === '--version') return { stdout: 'git version 2.40.0' };
    if (args.includes('rev-parse')) {
      if (opts.failRevParse) throw new Error('not a git repo');
      return { stdout: 'true' };
    }
    if (opts.net?.offline && (args[0] === 'clone' || args.includes('fetch'))) {
      throw new Error('could not resolve host: github.com');
    }
    if (args[0] === 'clone') {
      const dest = args[args.length - 1];
      cpSync(fixtureRegistry, dest, { recursive: true });
      mkdirSync(join(dest, '.git'), { recursive: true });
      return { stdout: '' };
    }
    return { stdout: '' }; // fetch / reset
  });
}

interface Harness {
  svc: MarketplaceService;
  bundledDir: string;
  userDir: string;
  dataRoot: string;
  cacheDir: string;
  enabled: string[];
  reload: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  /** Flip `offline` to make every network-touching git command fail from that point on. */
  net: { offline: boolean };
}

function setup(opts: {
  registryEntries: { name: string; version: string; requiresCore?: string }[];
  bundled?: { name: string; version: string }[];
  installed?: { name: string; version: string }[];
  hostileNames?: string[];
  failRevParse?: boolean;
  seedCacheGit?: boolean;
  /** Put a WARM cache on disk — a full registry clone, exactly what an earlier successful refresh
   *  leaves behind — without letting this process record a fetch. Models a restarted daemon. */
  warmCache?: boolean;
  offline?: boolean;
  calls?: string[];
}): Harness {
  const base = tmpDir('mkt');
  const fixture = join(base, 'fixture-registry');
  const bundledDir = join(base, 'bundled');
  const userDir = join(base, 'user');
  const dataRoot = join(base, 'data');
  const cacheDir = join(base, 'cache');
  mkdirSync(bundledDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });

  writeRegistryFixture(fixture, opts.registryEntries, opts.hostileNames);
  for (const b of opts.bundled ?? []) writePlugin(bundledDir, b.name, b.version);
  for (const p of opts.installed ?? []) writePlugin(userDir, p.name, p.version);
  if (opts.seedCacheGit) mkdirSync(join(cacheDir, '.git'), { recursive: true });
  if (opts.warmCache) {
    cpSync(fixture, cacheDir, { recursive: true });
    mkdirSync(join(cacheDir, '.git'), { recursive: true });
  }

  const enabled: string[] = [...(opts.installed ?? []).map((p) => p.name)];
  const reload = vi.fn(async () => {});
  const net = { offline: !!opts.offline };
  const exec = fakeGit(fixture, { failRevParse: opts.failRevParse, calls: opts.calls, net });

  const svc = new MarketplaceService({
    registryUrl: 'https://example.invalid/registry.git',
    cacheDir,
    userPluginsDir: userDir,
    pluginDataRoot: dataRoot,
    ttlMs: 60_000,
    discovered: () => discoverPlugins([bundledDir, userDir]),
    getEnabled: () => enabled,
    setEnabled: (names) => { enabled.length = 0; enabled.push(...names); },
    reload,
    io: { exec, now: () => 1_000_000, rand: () => 'rnd' },
  });
  return { svc, bundledDir, userDir, dataRoot, cacheDir, enabled, reload, exec, net };
}

describe('parseRegistry', () => {
  it('drops entries with an unsafe or duplicate name', () => {
    const out = parseRegistry({ schema: 1, plugins: [
      { name: 'good', version: '1.0.0', description: 'ok' },
      { name: '../evil', version: '1.0.0', description: 'traversal' },
      { name: 'UPPER', version: '1.0.0', description: 'caps not allowed' },
      { name: 'good', version: '2.0.0', description: 'dup' },
    ] });
    expect(out.map((e) => e.name)).toEqual(['good']);
  });

  it('throws (fail-closed) on a malformed index', () => {
    expect(() => parseRegistry({ plugins: [{ name: 'x' }] })).toThrow();
    expect(() => parseRegistry(null)).toThrow();
  });
});

describe('MarketplaceService.catalog', () => {
  it('classifies available / installed / updateAvailable / bundled', async () => {
    const { svc } = setup({
      registryEntries: [
        { name: 'weather', version: '1.0.0' },   // not on disk → available
        { name: 'notion', version: '2.0.0' },    // installed older → updateAvailable
        { name: 'slack', version: '1.0.0' },     // installed same → installed
        { name: 'memory', version: '5.0.0' },    // bundled → bundled
      ],
      bundled: [{ name: 'memory', version: '1.0.0' }],
      installed: [{ name: 'notion', version: '1.0.0' }, { name: 'slack', version: '1.0.0' }],
    });
    const cat = await svc.catalog();
    expect(cat.registryError).toBeUndefined();
    const byName = Object.fromEntries(cat.plugins.map((p) => [p.name, p.status]));
    expect(byName).toEqual({ weather: 'available', notion: 'updateAvailable', slack: 'installed', memory: 'bundled' });
  });

  it('drops hostile registry names from the catalog', async () => {
    const { svc } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }], hostileNames: ['../evil', 'bad/name'] });
    const cat = await svc.catalog();
    expect(cat.plugins.map((p) => p.name)).toEqual(['weather']);
  });

  it('re-clones a corrupt cache (rev-parse fails)', async () => {
    const calls: string[] = [];
    const { svc } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }], seedCacheGit: true, failRevParse: true, calls });
    const cat = await svc.catalog(true);
    expect(cat.plugins.map((p) => p.name)).toEqual(['weather']);
    expect(calls.some((c) => c.startsWith('git clone'))).toBe(true);
  });

  it('keeps serving the last-good cache when an unhealthy cache cannot be re-cloned', async () => {
    const { svc, exec, cacheDir } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }] });
    await svc.catalog(); // primes the cache with a readable registry.json
    expect(existsSync(join(cacheDir, 'registry.json'))).toBe(true);
    // Cache goes unhealthy AND the network is down: the refresh must not destroy what we can still read.
    exec.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === '--version') return { stdout: 'git version 2.40.0' };
      throw new Error('network unreachable');
    });
    const cat = await svc.catalog(true);
    expect(cat.registryError).toBeTruthy();
    expect(cat.plugins.map((p) => p.name)).toEqual(['weather']);
  });

  it('reports registryError and an empty catalog when git is unavailable and no cache exists', async () => {
    const { svc, exec } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }] });
    exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (args[0] === '--version') throw new Error('git: not found');
      return { stdout: '' };
    });
    const cat = await svc.catalog();
    expect(cat.plugins).toEqual([]);
    expect(cat.registryError).toBeTruthy();
  });
});

describe('MarketplaceService.install', () => {
  it('installs a registry plugin as a user source, enables it, and reloads', async () => {
    const { svc, bundledDir, userDir, enabled, reload } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }] });
    await svc.install('weather');
    expect(existsSync(join(userDir, 'weather', 'index.mjs'))).toBe(true);
    expect(enabled).toContain('weather');
    expect(reload).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledWith('weather');
    const disk = discoverPlugins([bundledDir, userDir]).find((p) => p.manifest.name === 'weather');
    expect(disk?.source).toBe('user');
  });

  it('symlinks host node_modules into the installed plugin so its SDK imports resolve', async () => {
    const base = tmpDir('mkt-hostmods');
    const host = join(base, 'host-node-modules');
    mkdirSync(host, { recursive: true });
    const { svc, userDir } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }] });
    // Rebuild svc with a hostNodeModules pointing at the fixture dir.
    (svc as unknown as { opts: { hostNodeModules?: string } }).opts.hostNodeModules = host;
    await svc.install('weather');
    const link = join(userDir, 'weather', 'node_modules');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(host);
    rmSync(base, { recursive: true, force: true });
  });

  it('honors { enable:false } without requiring the inert plugin in the rebuilt registry', async () => {
    const { svc, enabled, reload } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }] });
    await svc.install('weather', { enable: false });
    expect(enabled).not.toContain('weather');
    expect(reload).toHaveBeenCalledWith(undefined);
  });

  it('rejects a name not in the registry (404)', async () => {
    const { svc } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }] });
    await expect(svc.install('ghost')).rejects.toMatchObject({ status: 404 });
  });

  // The payload is copied out of the cache, so an install the cache can already satisfy must not be
  // refused merely because the refresh could not run — the catalog the operator clicked was rendered
  // from that same cache. This is also the path reconcileEnabled() uses to restore during an offline boot.
  it('installs from the last-good cache while the network is down', async () => {
    const { svc, userDir, enabled } = setup({
      registryEntries: [{ name: 'weather', version: '1.0.0' }],
      warmCache: true, offline: true,
    });
    await svc.install('weather');
    expect(existsSync(join(userDir, 'weather', 'index.mjs'))).toBe(true);
    expect(enabled).toContain('weather');
  });

  // …but with nothing readable to install FROM, the failure must be explicit rather than a 404 that
  // reads as "no such plugin".
  it('reports the registry as unavailable (503) when offline with no cache', async () => {
    const { svc } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }], offline: true });
    await expect(svc.install('weather')).rejects.toMatchObject({ status: 503 });
  });

  it('rejects installing over a built-in plugin (409)', async () => {
    const { svc } = setup({
      registryEntries: [{ name: 'memory', version: '2.0.0' }],
      bundled: [{ name: 'memory', version: '1.0.0' }],
    });
    await expect(svc.install('memory')).rejects.toBeInstanceOf(MarketplaceError);
    await expect(svc.install('memory')).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a plugin that needs a newer daemon, and leaves nothing installed', async () => {
    // The version is deliberately absurd rather than "current + 1": this must keep asserting the same
    // thing after the next release bump, and a test that quietly stops covering its case is worse than
    // no test.
    const { svc, userDir, enabled, reload } = setup({
      registryEntries: [{ name: 'weather', version: '1.0.0', requiresCore: '999.0.0' }],
    });
    await expect(svc.install('weather')).rejects.toBeInstanceOf(MarketplaceError);
    // A rejected install must not be half-applied — no folder, not enabled, no reload. Without this the
    // gate could "fail" and still leave the daemon carrying a plugin it cannot run.
    expect(existsSync(join(userDir, 'weather'))).toBe(false);
    expect(enabled).not.toContain('weather');
    expect(reload).not.toHaveBeenCalled();
  });

  it('names the required and the running version, so the user knows what to do about it', async () => {
    const { svc } = setup({
      registryEntries: [{ name: 'weather', version: '1.0.0', requiresCore: '999.0.0' }],
    });
    const running = (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string }).version;
    await expect(svc.install('weather')).rejects.toThrow(new RegExp(`999\\.0\\.0.*${running.replace(/\./g, '\\.')}`));
  });

  it('installs when the requirement is satisfied — the gate must fail in both directions', async () => {
    // The mirror of the case above. A gate that only ever rejects would pass its own test while blocking
    // every plugin, so the permissive direction is the half that proves it discriminates.
    const { svc, userDir, enabled } = setup({
      registryEntries: [{ name: 'weather', version: '1.0.0', requiresCore: '0.0.1' }],
    });
    await svc.install('weather');
    expect(existsSync(join(userDir, 'weather', 'index.mjs'))).toBe(true);
    expect(enabled).toContain('weather');
  });

  it('installs a plugin that declares no requirement at all', async () => {
    // Every plugin in the registry today omits the field; if the gate treated "absent" as "incompatible"
    // it would brick the whole marketplace on upgrade.
    const { svc, userDir } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }] });
    await svc.install('weather');
    expect(existsSync(join(userDir, 'weather', 'index.mjs'))).toBe(true);
  });

  it('rejects an invalid plugin name (400) before touching disk', async () => {
    const { svc } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }] });
    await expect(svc.install('../etc')).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a plugin whose payload contains a symlink and leaves no folder behind', async () => {
    const { svc, userDir, cacheDir } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }] });
    // Prime the cache, then poison the cached payload with a symlink before install copies it.
    await svc.catalog();
    symlinkSync('/etc/passwd', join(cacheDir, 'plugins', 'weather', 'secret.mjs'));
    await expect(svc.install('weather')).rejects.toBeInstanceOf(Error);
    expect(existsSync(join(userDir, 'weather'))).toBe(false);
    expect(existsSync(join(userDir, '.staging-weather-rnd'))).toBe(false);
  });
});

describe('MarketplaceService.update', () => {
  it('re-copies a newer version over the installed one', async () => {
    const { svc, userDir, reload } = setup({
      registryEntries: [{ name: 'notion', version: '2.0.0' }],
      installed: [{ name: 'notion', version: '1.0.0' }],
    });
    await svc.update('notion');
    const manifest = JSON.parse(readFileSync(join(userDir, 'notion', 'elowen-plugin.json'), 'utf-8')) as { version: string };
    expect(manifest.version).toBe('2.0.0');
    expect(reload).toHaveBeenCalled();
  });

  it('rolls the previous version back in when the post-update reload fails', async () => {
    const { svc, userDir, reload } = setup({
      registryEntries: [{ name: 'notion', version: '2.0.0' }],
      installed: [{ name: 'notion', version: '1.0.0' }],
    });
    reload.mockRejectedValueOnce(new Error('registry rebuild failed'));
    await expect(svc.update('notion')).rejects.toThrow(/registry rebuild failed/);
    // The update reported a failure, so the working version must still be the one on disk.
    const manifest = JSON.parse(readFileSync(join(userDir, 'notion', 'elowen-plugin.json'), 'utf-8')) as { version: string };
    expect(manifest.version).toBe('1.0.0');
    expect(existsSync(join(userDir, '.old-notion-rnd'))).toBe(false); // backup consumed, no debris
    expect(reload.mock.calls).toEqual([['notion'], []]); // rollback reloads without requiring the rejected version
  });

  it('refuses to update a built-in plugin (409)', async () => {
    const { svc } = setup({
      registryEntries: [{ name: 'memory', version: '2.0.0' }],
      bundled: [{ name: 'memory', version: '1.0.0' }],
    });
    await expect(svc.update('memory')).rejects.toMatchObject({ status: 409 });
  });
});

describe('MarketplaceService.uninstall', () => {
  it('removes the folder AND its data, disables it, and reloads', async () => {
    const { svc, userDir, dataRoot, enabled, reload } = setup({
      registryEntries: [{ name: 'notion', version: '1.0.0' }],
      installed: [{ name: 'notion', version: '1.0.0' }],
    });
    mkdirSync(join(dataRoot, 'notion'), { recursive: true });
    writeFileSync(join(dataRoot, 'notion', 'state.json'), '{}');
    await svc.uninstall('notion');
    expect(existsSync(join(userDir, 'notion'))).toBe(false);
    expect(existsSync(join(dataRoot, 'notion'))).toBe(false);
    expect(enabled).not.toContain('notion');
    expect(reload).toHaveBeenCalled();
  });

  it('refuses to uninstall a built-in plugin (409)', async () => {
    const { svc } = setup({
      registryEntries: [],
      bundled: [{ name: 'memory', version: '1.0.0' }],
    });
    await expect(svc.uninstall('memory')).rejects.toMatchObject({ status: 409 });
  });

  it('404s for a plugin that is not installed', async () => {
    const { svc } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }] });
    await expect(svc.uninstall('weather')).rejects.toMatchObject({ status: 404 });
  });
});

// The upgrade path for a plugin that moves out of the npm package: its name stays in `plugins.enabled`
// while its folder disappears with the old package, and the loader skips a missing plugin in silence.
// Without this reconcile the operator simply finds the feature gone after a routine `npm i -g elowen`.
describe('MarketplaceService.reconcileEnabled', () => {
  it('reinstalls an enabled plugin that is no longer on disk', async () => {
    const { svc, userDir, enabled } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }] });
    enabled.push('weather');

    expect(await svc.reconcileEnabled()).toEqual(['weather']);
    expect(existsSync(join(userDir, 'weather', 'elowen-plugin.json'))).toBe(true);
    // It restores, it does not re-decide: the enabled list is untouched (no duplicate, no reordering).
    expect(enabled).toEqual(['weather']);
  });

  it('never installs a plugin the operator has not enabled', async () => {
    const { svc, userDir, enabled } = setup({
      registryEntries: [{ name: 'weather', version: '1.0.0' }, { name: 'spy', version: '1.0.0' }],
    });
    enabled.push('weather');

    expect(await svc.reconcileEnabled()).toEqual(['weather']);
    expect(existsSync(join(userDir, 'spy'))).toBe(false);
  });

  it('leaves an enabled name the registry does not carry alone', async () => {
    const { svc, enabled, reload } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }] });
    enabled.push('handwritten');

    expect(await svc.reconcileEnabled()).toEqual([]);
    expect(enabled).toEqual(['handwritten']); // still enabled — this is not the place to un-decide that
    expect(reload).not.toHaveBeenCalled();
  });

  it('does nothing when every enabled plugin is present, without touching the network', async () => {
    const calls: string[] = [];
    const { svc } = setup({
      registryEntries: [{ name: 'weather', version: '1.0.0' }],
      bundled: [{ name: 'files', version: '1.0.0' }],
      installed: [{ name: 'weather', version: '1.0.0' }],
      calls,
    });

    expect(await svc.reconcileEnabled()).toEqual([]);
    expect(calls).toEqual([]); // no clone/fetch when there is nothing to look up
  });

  it('reports rather than throws when the registry is unreachable', async () => {
    const { svc, enabled } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }] });
    enabled.push('weather');
    const { svc: broken } = setup({ registryEntries: [], failRevParse: true });
    // A boot must survive an offline registry: the plugin stays missing, the daemon still starts.
    await expect(broken.reconcileEnabled()).resolves.toEqual([]);
    await expect(svc.reconcileEnabled()).resolves.toEqual(['weather']);
  });

  // A daemon that boots WITHOUT a network is the ordinary case this reconcile exists for, and it is the
  // one where the cache is most valuable: `lastFetch` is process-local, so the first reconcile of every
  // boot refreshes, and the refresh is the only step that needs the network — the payload it would
  // install is already on disk. Treating the failed refresh as fatal dropped the plugin for the whole
  // process lifetime, so the operator found the feature gone precisely when they could not fix it.
  it('restores from the last-good cache when the boot has no network', async () => {
    const { svc, userDir, enabled } = setup({
      registryEntries: [{ name: 'weather', version: '1.0.0' }],
      warmCache: true, offline: true,
    });
    enabled.push('weather');

    expect(await svc.reconcileEnabled()).toEqual(['weather']);
    expect(existsSync(join(userDir, 'weather', 'elowen-plugin.json'))).toBe(true);
    expect(enabled).toEqual(['weather']); // restored, not re-decided
  });

  // The degradation must stop at "serve what is cached" — with no readable cache there is nothing to
  // install from, and the reconcile must still report rather than throw the boot.
  it('gives up quietly when the boot has no network AND no cache', async () => {
    const { svc, userDir, enabled } = setup({
      registryEntries: [{ name: 'weather', version: '1.0.0' }],
      offline: true,
    });
    enabled.push('weather');

    await expect(svc.reconcileEnabled()).resolves.toEqual([]);
    expect(existsSync(join(userDir, 'weather'))).toBe(false);
  });

  it('does not resurrect a plugin that still ships bundled', async () => {
    // A bundled plugin is on disk by definition, so it is never "missing" — and install() would refuse
    // it anyway. This pins that the reconcile cannot shadow a built-in with a registry copy.
    const { svc, userDir, enabled } = setup({
      registryEntries: [{ name: 'files', version: '9.9.9' }],
      bundled: [{ name: 'files', version: '1.0.0' }],
      installed: [],
    });
    enabled.push('files'); // enabled AND in the registry — only "on disk as bundled" keeps it out
    expect(await svc.reconcileEnabled()).toEqual([]);
    expect(existsSync(join(userDir, 'files'))).toBe(false);
  });
});

describe('MarketplaceService.sweep', () => {
  it('deletes leftover .staging-*/.old-* dirs', () => {
    const { svc, userDir } = setup({ registryEntries: [] });
    mkdirSync(join(userDir, '.staging-x-1'), { recursive: true });
    mkdirSync(join(userDir, '.old-y-2'), { recursive: true });
    mkdirSync(join(userDir, 'real'), { recursive: true });
    svc.sweep();
    expect(existsSync(join(userDir, '.staging-x-1'))).toBe(false);
    expect(existsSync(join(userDir, '.old-y-2'))).toBe(false);
    expect(existsSync(join(userDir, 'real'))).toBe(true);
    rmSync(userDir, { recursive: true, force: true });
  });
});
