import { describe, it, expect, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketplaceService, parseRegistry, MarketplaceError } from '../../src/plugins/marketplace.js';
import { discoverPlugins } from '../../src/plugins/loader.js';

/** One plugin folder (manifest + entry) inside a `plugins/<name>` root. */
function writePlugin(pluginsRoot: string, name: string, version: string): string {
  const dir = join(pluginsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'orca-plugin.json'), JSON.stringify({
    name, version, apiVersion: '1', description: `${name} plugin`, entry: 'index.mjs',
    provides: { tools: [`${name}_tool`] },
  }));
  writeFileSync(join(dir, 'index.mjs'), 'export function register(){}');
  return dir;
}

/** Build a registry-repo fixture: registry.json + plugins/<name>/ for each entry. */
function writeRegistryFixture(root: string, entries: { name: string; version: string }[], extraNames: string[] = []): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'registry.json'), JSON.stringify({
    schema: 1,
    plugins: [...entries, ...extraNames.map((name) => ({ name, version: '9.9.9', description: 'hostile' }))]
      .map((e) => ({ ...e, description: (e as { description?: string }).description ?? `${e.name} desc`, category: 'utility' })),
  }));
  const pluginsDir = join(root, 'plugins');
  for (const e of entries) writePlugin(pluginsDir, e.name, e.version);
}

/** A fake `git` exec: `clone` copies the fixture registry into the target dir; the rest no-op. */
function fakeGit(fixtureRegistry: string, opts: { failRevParse?: boolean; calls?: string[] } = {}) {
  return vi.fn(async (cmd: string, args: string[]) => {
    opts.calls?.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args[0] === '--version') return { stdout: 'git version 2.40.0' };
    if (args.includes('rev-parse')) {
      if (opts.failRevParse) throw new Error('not a git repo');
      return { stdout: 'true' };
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
}

function setup(opts: {
  registryEntries: { name: string; version: string }[];
  bundled?: { name: string; version: string }[];
  installed?: { name: string; version: string }[];
  hostileNames?: string[];
  failRevParse?: boolean;
  seedCacheGit?: boolean;
  calls?: string[];
}): Harness {
  const base = mkdtempSync(join(tmpdir(), 'orca-mkt-'));
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

  const enabled: string[] = [...(opts.installed ?? []).map((p) => p.name)];
  const reload = vi.fn(async () => {});
  const exec = fakeGit(fixture, { failRevParse: opts.failRevParse, calls: opts.calls });

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
  return { svc, bundledDir, userDir, dataRoot, cacheDir, enabled, reload, exec };
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
    const disk = discoverPlugins([bundledDir, userDir]).find((p) => p.manifest.name === 'weather');
    expect(disk?.source).toBe('user');
  });

  it('honors { enable:false }', async () => {
    const { svc, enabled } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }] });
    await svc.install('weather', { enable: false });
    expect(enabled).not.toContain('weather');
  });

  it('rejects a name not in the registry (404)', async () => {
    const { svc } = setup({ registryEntries: [{ name: 'weather', version: '1.0.0' }] });
    await expect(svc.install('ghost')).rejects.toMatchObject({ status: 404 });
  });

  it('rejects installing over a built-in plugin (409)', async () => {
    const { svc } = setup({
      registryEntries: [{ name: 'memory', version: '2.0.0' }],
      bundled: [{ name: 'memory', version: '1.0.0' }],
    });
    await expect(svc.install('memory')).rejects.toBeInstanceOf(MarketplaceError);
    await expect(svc.install('memory')).rejects.toMatchObject({ status: 409 });
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
    const manifest = JSON.parse(readFileSync(join(userDir, 'notion', 'orca-plugin.json'), 'utf-8')) as { version: string };
    expect(manifest.version).toBe('2.0.0');
    expect(reload).toHaveBeenCalled();
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
