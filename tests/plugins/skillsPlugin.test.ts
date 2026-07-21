import { describe, it, expect } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const adminPolicy = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };
const admin = { platform: 'elowen', userId: '1', admin: true, owner: true };
const runTool = (reg: { tools: { name: string; execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> }[] }, name: string, p: unknown) =>
  reg.tools.find((t) => t.name === name)!.execute('t', p);

describe('bundled skills plugin', () => {
  it('registers at least one skill from its bundled dir', async () => {
    const reg = await loadPlugins({ dirs: [resolve(repoRoot, 'plugins')], enabled: ['skills'], logger: log });
    expect(reg.skills.length).toBeGreaterThan(0);
    expect(reg.skills.map((s) => s.name)).toContain('elowen-control');
  });

  it('the registered skills format into a non-empty prompt block', async () => {
    const reg = await loadPlugins({ dirs: [resolve(repoRoot, 'plugins')], enabled: ['skills'], logger: log });
    expect(formatSkillsForPrompt(reg.skills).length).toBeGreaterThan(0);
  });

  it('CreateSkill writes the skill AND asks the host to apply it live (no restart)', async () => {
    // Regression: before the fix, CreateSkill wrote the file but never triggered a reload, so a freshly
    // created skill only reached the model after a daemon restart / plugins toggle. It must now request a
    // live reload (drained by the brain once the turn settles) so the skill is available next message.
    const dataRoot = mkdtempSync(join(tmpdir(), 'elowen-skills-'));
    let reloads = 0;
    const reg = await loadPlugins({ dirs: [resolve(repoRoot, 'plugins')], enabled: ['skills'], logger: log, dataRoot, requestReload: () => { reloads += 1; } });
    const res = await runWithPolicy(adminPolicy, () => runTool(reg as never, 'CreateSkill', { name: 'ship-it', description: 'how to ship a release', content: 'do the thing' }), { identity: admin });
    expect(res.content[0].text).toContain('next message'); // the message no longer says "after a restart"
    expect(reloads).toBe(1); // the missing link: the tool now requests a live apply
    // A fresh load (what the reload performs) picks the new skill up from the data dir.
    const reloaded = await loadPlugins({ dirs: [resolve(repoRoot, 'plugins')], enabled: ['skills'], logger: log, dataRoot });
    expect(reloaded.skills.map((s) => s.name)).toContain('ship-it');
  });

  it('DeleteSkill also asks the host to apply the removal live', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'elowen-skills-'));
    mkdirSync(join(dataRoot, 'skills'), { recursive: true });
    writeFileSync(join(dataRoot, 'skills', 'temp-skill.md'), '---\nname: temp-skill\ndescription: throwaway\n---\n\nbody\n');
    let reloads = 0;
    const reg = await loadPlugins({ dirs: [resolve(repoRoot, 'plugins')], enabled: ['skills'], logger: log, dataRoot, requestReload: () => { reloads += 1; } });
    const del = await runWithPolicy(adminPolicy, () => runTool(reg as never, 'DeleteSkill', { name: 'temp-skill' }), { identity: admin });
    expect(del.content[0].text).toContain('deleted');
    expect(reloads).toBe(1);
  });

  it('lists AND deletes a directory-form <name>/SKILL.md user skill, not just flat .md', async () => {
    // ctx.dataDir() resolves to <dataRoot>/skills — seed a directory-form skill there (PI treats a dir
    // with a SKILL.md as a skill root). The old flat-*.md readdir catalog would miss it entirely.
    const dataRoot = mkdtempSync(join(tmpdir(), 'elowen-skills-'));
    const skillDir = join(dataRoot, 'skills', 'deploy-flow');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: deploy-flow\ndescription: how to deploy the app\n---\n\nsteps here\n');

    const reg = await loadPlugins({ dirs: [resolve(repoRoot, 'plugins')], enabled: ['skills'], logger: log, dataRoot });
    // PI's loader registered the dir-form skill…
    expect(reg.skills.map((s) => s.name)).toContain('deploy-flow');
    // …and ListSkills surfaces it (via the loader, not a flat readdir).
    const listed = await runWithPolicy(adminPolicy, () => runTool(reg as never, 'ListSkills', {}), { identity: admin });
    expect(listed.content[0].text).toContain('deploy-flow');
    // …and DeleteSkill removes the whole skill directory.
    const del = await runWithPolicy(adminPolicy, () => runTool(reg as never, 'DeleteSkill', { name: 'deploy-flow' }), { identity: admin });
    expect(del.content[0].text).toContain('deleted');
    expect(existsSync(skillDir)).toBe(false);
  });
});
