import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBrainCore } from '../../src/daemon/brainCore.js';
import { runWithContributionUser } from '../../src/plugins/policyContext.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';

interface SkillCatalogProbe {
  (): string[] | null;
}

interface ResourceProbe {
  (path: string): {
    resources: string | null;
    hasResourceControl: boolean;
    catalogHasResolve: boolean;
    catalogSkills: string[] | null;
  } | null;
}

describe('brainCore skill catalog control', () => {
  let dir = '';

  afterEach(() => {
    delete (globalThis as { __skillCatalogProbe?: unknown }).__skillCatalogProbe;
    delete (globalThis as { __filesResourceProbe?: unknown }).__filesResourceProbe;
    delete (globalThis as { __readerResourceProbe?: unknown }).__readerResourceProbe;
    delete (globalThis as { __flatResourceProbe?: unknown }).__flatResourceProbe;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('returns the same grant- and owner-filtered plugin skills advertised to the current turn', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-skill-catalog-'));
    const pluginsDir = join(dir, 'plugins');
    const readerDir = join(pluginsDir, 'catalog-reader');
    const raynetDir = join(pluginsDir, 'raynet');
    mkdirSync(readerDir, { recursive: true });
    mkdirSync(raynetDir, { recursive: true });

    writeFileSync(join(readerDir, 'elowen-plugin.json'), JSON.stringify({
      name: 'catalog-reader', version: '0.1.0', apiVersion: '1', description: 'catalog reader',
      entry: 'index.mjs', capabilities: { reads: ['controls'] },
    }));
    writeFileSync(join(readerDir, 'index.mjs'), `export function register(ctx) {
      globalThis.__skillCatalogProbe = () => ctx.control('skillCatalog')?.visibleSkills().map((skill) => skill.name) ?? null;
    }`);

    const sharedFile = join(raynetDir, 'raynet-crm.md');
    const personalFile = join(raynetDir, 'private-raynet.md');
    writeFileSync(sharedFile, '# Raynet CRM\n');
    writeFileSync(personalFile, '# Private Raynet\n');
    writeFileSync(join(raynetDir, 'elowen-plugin.json'), JSON.stringify({
      name: 'raynet', version: '0.1.0', apiVersion: '1', description: 'raynet', entry: 'index.mjs',
      userGrantable: true, provides: { skills: ['raynet-crm', 'private-raynet'] },
    }));
    writeFileSync(join(raynetDir, 'index.mjs'), `export function register(ctx) {
      ctx.registerSkill({
        name: 'raynet-crm', description: 'Use Raynet.', filePath: ${JSON.stringify(sharedFile)},
        baseDir: ${JSON.stringify(raynetDir)}, sourceInfo: { path: ${JSON.stringify(sharedFile)}, source: 'elowen-plugin:raynet', scope: 'user', origin: 'package' },
        disableModelInvocation: false,
      });
      ctx.registerSkill({
        name: 'private-raynet', description: 'Use private Raynet.', filePath: ${JSON.stringify(personalFile)},
        baseDir: ${JSON.stringify(raynetDir)}, sourceInfo: { path: ${JSON.stringify(personalFile)}, source: 'elowen-plugin:raynet', scope: 'user', origin: 'package' },
        disableModelInvocation: false,
      }, { ownerUserId: 2 });
    }`);

    const core = await buildBrainCore({
      dbPath: join(dir, 'elowen.db'),
      project: { id: 1, slug: 'wiring', path: dir },
      tmux: new FakeTmuxDriver(),
      bootstrap: { username: 'owner', password: 'pw-for-test-only' },
      pluginDirs: [pluginsDir, join(dir, 'user-plugins')],
    });
    try {
      const member = core.users.create('member', 'pw-for-test-only');
      core.config.update({ plugins: { enabled: ['catalog-reader', 'raynet'] } });
      await core.pluginProvider.get();
      const probe = (globalThis as { __skillCatalogProbe?: SkillCatalogProbe }).__skillCatalogProbe;
      if (!probe) throw new Error('catalog reader never captured the control');

      expect(probe()).toEqual([]);
      expect(runWithContributionUser(1, probe)).toEqual(['raynet-crm']);
      expect(runWithContributionUser(member.id, probe)).toEqual([]);

      core.users.setGrantedPlugins(member.id, ['raynet']);
      expect(runWithContributionUser(member.id, probe)).toEqual(['raynet-crm', 'private-raynet']);
    } finally {
      core.db.close();
    }
  });

  /** The catalog is a broadly readable listing; resolving a support file to a host path core will then
   *  READ on the caller's behalf is authority of a different kind. Sharing one control key handed the
   *  second to every present and future catalog reader, so it lives on its own key with its own consumer
   *  list — matched against the name the loader assigns, never against a self-declared capability. */
  it('serves skill resource resolution only to the managed read path owner, and never through the catalog', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-skill-resources-'));
    const pluginsDir = join(dir, 'plugins');
    const filesDir = join(pluginsDir, 'files');
    const readerDir = join(pluginsDir, 'catalog-reader');
    const raynetDir = join(pluginsDir, 'raynet');
    mkdirSync(filesDir, { recursive: true });
    mkdirSync(readerDir, { recursive: true });
    mkdirSync(join(raynetDir, 'refs'), { recursive: true });

    const probeBody = `(requestedPath) => {
        const resources = ctx.control('skillResources');
        const catalog = ctx.control('skillCatalog');
        return {
          resources: resources ? resources.resolveResource(requestedPath) : null,
          hasResourceControl: typeof resources?.resolveResource === 'function',
          catalogHasResolve: typeof (catalog ?? {}).resolveResource === 'function',
          catalogSkills: catalog ? catalog.visibleSkills().map((skill) => skill.name) : null,
        };
      }`;
    for (const [name, dirPath, global] of [
      ['files', filesDir, '__filesResourceProbe'],
      ['catalog-reader', readerDir, '__readerResourceProbe'],
    ] as const) {
      writeFileSync(join(dirPath, 'elowen-plugin.json'), JSON.stringify({
        name, version: '0.1.0', apiVersion: '1', description: name,
        entry: 'index.mjs', capabilities: { reads: ['controls'] },
      }));
      writeFileSync(join(dirPath, 'index.mjs'), `export function register(ctx) {
        globalThis.${global} = ${probeBody};
      }`);
    }

    // Directory form: the skill file IS <dir>/SKILL.md, which is what gives the folder around it a
    // support root at all.
    const sharedFile = join(raynetDir, 'SKILL.md');
    const supportFile = join(raynetDir, 'refs', 'reference.md');
    const outsideFile = join(dir, 'host-secret.txt');
    writeFileSync(sharedFile, '# Raynet CRM\n');
    writeFileSync(supportFile, 'support content\n');
    writeFileSync(outsideFile, 'host secret\n');
    writeFileSync(join(raynetDir, 'elowen-plugin.json'), JSON.stringify({
      name: 'raynet', version: '0.1.0', apiVersion: '1', description: 'raynet', entry: 'index.mjs',
      provides: { skills: ['raynet-crm'] },
    }));
    writeFileSync(join(raynetDir, 'index.mjs'), `export function register(ctx) {
      ctx.registerSkill({
        name: 'raynet-crm', description: 'Use Raynet.', filePath: ${JSON.stringify(sharedFile)},
        baseDir: ${JSON.stringify(raynetDir)}, sourceInfo: { path: ${JSON.stringify(sharedFile)}, source: 'elowen-plugin:raynet', scope: 'user', origin: 'package' },
        disableModelInvocation: false,
      });
    }`);

    const core = await buildBrainCore({
      dbPath: join(dir, 'elowen.db'),
      project: { id: 1, slug: 'resources', path: dir },
      tmux: new FakeTmuxDriver(),
      bootstrap: { username: 'owner', password: 'pw-for-test-only' },
      pluginDirs: [pluginsDir, join(dir, 'user-plugins')],
    });
    try {
      core.config.update({ plugins: { enabled: ['files', 'catalog-reader', 'raynet'] } });
      await core.pluginProvider.get();
      const globals = globalThis as { __filesResourceProbe?: ResourceProbe; __readerResourceProbe?: ResourceProbe };
      const filesProbe = globals.__filesResourceProbe;
      const readerProbe = globals.__readerResourceProbe;
      if (!filesProbe || !readerProbe) throw new Error('a probe plugin never captured its context');

      const asOwner = <T>(fn: () => T): T => runWithContributionUser(1, fn) as T;

      const files = asOwner(() => filesProbe(supportFile));
      expect(files?.hasResourceControl).toBe(true);
      expect(files?.resources).toBe(supportFile);
      expect(files?.catalogHasResolve).toBe(false);
      expect(asOwner(() => filesProbe(outsideFile))?.resources).toBeNull();

      const reader = asOwner(() => readerProbe(supportFile));
      expect(reader?.hasResourceControl).toBe(false);
      expect(reader?.resources).toBeNull();
      expect(reader?.catalogHasResolve).toBe(false);
      // A split of authority, not a lockdown of the listing: the same refused plugin still reads the catalog.
      expect(reader?.catalogSkills).toEqual(['raynet-crm']);
    } finally {
      core.db.close();
    }
  });

  /** The instance skills folder holds BOTH layouts side by side: flat `<name>.md` files whose pinned base
   *  is that whole shared folder, and `users/<id>/*.md`, every account's personal skills. One visible flat
   *  skill therefore carried a "support root" containing every other account's private skill files, which
   *  is how a reviewer read `users/1/private.md` through it. Only the directory form has a support root. */
  it('gives a flat skill no support root, so a visible one cannot read another account\'s personal skill', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-flat-skill-'));
    const pluginsDir = join(dir, 'plugins');
    const filesDir = join(pluginsDir, 'files');
    // The shared loader folder, laid out as the real instance skills directory is.
    const skillsRoot = join(pluginsDir, 'skill-source', 'skills');
    const directorySkillDir = join(skillsRoot, 'canvas-design');
    mkdirSync(filesDir, { recursive: true });
    mkdirSync(join(directorySkillDir, 'refs'), { recursive: true });
    mkdirSync(join(skillsRoot, 'users', '1'), { recursive: true });

    const flatSkillFile = join(skillsRoot, 'email-management.md');
    const personalSkillFile = join(skillsRoot, 'users', '1', 'private.md');
    const directorySkillFile = join(directorySkillDir, 'SKILL.md');
    const directorySupportFile = join(directorySkillDir, 'refs', 'reference.md');
    writeFileSync(flatSkillFile, '# Email management\n');
    writeFileSync(personalSkillFile, '# Private\n');
    writeFileSync(directorySkillFile, '# Canvas design\n');
    writeFileSync(directorySupportFile, 'support content\n');

    writeFileSync(join(filesDir, 'elowen-plugin.json'), JSON.stringify({
      name: 'files', version: '0.1.0', apiVersion: '1', description: 'files',
      entry: 'index.mjs', capabilities: { reads: ['controls'] },
    }));
    writeFileSync(join(filesDir, 'index.mjs'), `export function register(ctx) {
      globalThis.__flatResourceProbe = (requestedPath) => ctx.control('skillResources')?.resolveResource(requestedPath) ?? null;
    }`);

    const sourceDir = join(pluginsDir, 'skill-source');
    writeFileSync(join(sourceDir, 'elowen-plugin.json'), JSON.stringify({
      name: 'skill-source', version: '0.1.0', apiVersion: '1', description: 'skills',
      entry: 'index.mjs', provides: { skills: ['email-management', 'canvas-design'] },
    }));
    // Exactly what the loader pins for each layout: a flat skill's base is the SHARED folder, a
    // directory-form skill's base is its own folder.
    writeFileSync(join(sourceDir, 'index.mjs'), `export function register(ctx) {
      ctx.registerSkill({
        name: 'email-management', description: 'Flat instance skill.', filePath: ${JSON.stringify(flatSkillFile)},
        baseDir: ${JSON.stringify(skillsRoot)}, sourceInfo: { path: ${JSON.stringify(flatSkillFile)}, source: 'elowen-user:skills', scope: 'user', origin: 'package' },
        disableModelInvocation: false,
      });
      ctx.registerSkill({
        name: 'canvas-design', description: 'Directory-form skill.', filePath: ${JSON.stringify(directorySkillFile)},
        baseDir: ${JSON.stringify(directorySkillDir)}, sourceInfo: { path: ${JSON.stringify(directorySkillFile)}, source: 'elowen-user:skills', scope: 'user', origin: 'package' },
        disableModelInvocation: false,
      });
    }`);

    const core = await buildBrainCore({
      dbPath: join(dir, 'elowen.db'),
      project: { id: 1, slug: 'flat', path: dir },
      tmux: new FakeTmuxDriver(),
      bootstrap: { username: 'owner', password: 'pw-for-test-only' },
      pluginDirs: [pluginsDir, join(dir, 'user-plugins')],
    });
    try {
      core.config.update({ plugins: { enabled: ['files', 'skill-source'] } });
      await core.pluginProvider.get();
      const probe = (globalThis as { __flatResourceProbe?: (path: string) => string | null }).__flatResourceProbe;
      if (!probe) throw new Error('the files probe never captured its context');
      const asOwner = (path: string): string | null => runWithContributionUser(1, () => probe(path)) as string | null;

      // Both skills are visible to this account, so the flat one is the live authority under test.
      expect(asOwner(personalSkillFile)).toBeNull();
      // Nor any other file of the shared folder, including the flat skill's own body: SkillLoad already
      // returned that, and a flat skill has no folder of its own to serve.
      expect(asOwner(flatSkillFile)).toBeNull();
      expect(asOwner(join(skillsRoot, 'users', '1'))).toBeNull();

      // The directory form is unaffected: its own folder still serves its own support files.
      expect(asOwner(directorySupportFile)).toBe(directorySupportFile);
      expect(asOwner(directorySkillFile)).toBe(directorySkillFile);
    } finally {
      core.db.close();
    }
  });
});
