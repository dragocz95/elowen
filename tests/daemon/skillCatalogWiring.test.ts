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

describe('brainCore skill catalog control', () => {
  let dir = '';

  afterEach(() => {
    delete (globalThis as { __skillCatalogProbe?: unknown }).__skillCatalogProbe;
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
});
