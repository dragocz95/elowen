import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandTurnSkillCommand, searchableSkills, turnSkillsBlock } from '../../src/brain/session/turnSkills.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import type { PluginSkill } from '../../src/plugins/api.js';

const noopLog = { info() {}, warn() {}, error() {} };
const fakeSkill = (name: string) => ({
  name,
  description: `Use ${name}.`,
  filePath: `/skills/${name}.md`,
  baseDir: '/skills',
  sourceInfo: { path: `/skills/${name}.md`, source: 'test', scope: 'user', origin: 'package' },
  disableModelInvocation: false,
} as PluginSkill);
const fakeTool = (name: string) => ({ name, label: name, description: name } as never);

const blockFor = (registry: PluginRegistry, granted_plugins: string[] | null, toolPolicy?: { allow?: Set<string>; deny?: Set<string> }) => turnSkillsBlock({
  plugins: async () => registry,
  contributionUserId: granted_plugins === null ? null : 7,
  users: { get: () => granted_plugins === null ? null : { is_admin: false, granted_plugins } },
  ...(toolPolicy ? { toolPolicy } : {}),
});

describe('turnSkillsBlock', () => {
  it('announces plugin skills only when the same writer may use SkillLoad', async () => {
    const registry = new PluginRegistry();
    registry.contextFor('raynet', {}, noopLog).registerSkill(fakeSkill('raynet-crm'));
    registry.setUserGrantable('raynet', true);

    expect(await blockFor(registry, ['raynet'])).toBe('');

    registry.contextFor('skills', {}, noopLog).registerTool(fakeTool('SkillLoad'));
    registry.setUserGrantable('skills', true);
    expect(await blockFor(registry, ['raynet'])).toBe('');

    const block = await blockFor(registry, ['skills', 'raynet']);
    expect(block).toContain('<available_skills>');
    expect(block).toContain('<name>raynet-crm</name>');
    expect(await blockFor(registry, ['skills', 'raynet'], { deny: new Set(['SkillLoad']) })).toBe('');
    expect(await blockFor(registry, ['skills', 'raynet'], { allow: new Set(['raynet_lookup']) })).toBe('');
    expect(await blockFor(registry, ['skills', 'raynet'], { allow: new Set(['SkillLoad']) })).toContain('raynet-crm');
  });

  it('does not advertise an open sibling skill to an unlinked writer when SkillLoad is grant-gated', async () => {
    const registry = new PluginRegistry();
    registry.contextFor('files', {}, noopLog).registerSkill(fakeSkill('file-workflow'));
    registry.contextFor('skills', {}, noopLog).registerTool(fakeTool('SkillLoad'));
    registry.setUserGrantable('skills', true);

    expect(await blockFor(registry, null)).toBe('');
  });

  it('expands /skill from the live catalog and stops immediately after either grant is revoked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elowen-live-skill-'));
    try {
      const filePath = join(root, 'SKILL.md');
      writeFileSync(filePath, '---\nname: raynet-crm\ndescription: Work in Raynet.\n---\n\nLIVE RAYNET BODY\n');
      const registry = new PluginRegistry();
      registry.contextFor('skills', {}, noopLog).registerTool(fakeTool('SkillLoad'));
      registry.setUserGrantable('skills', true);
      registry.contextFor('raynet', {}, noopLog).registerSkill({
        ...fakeSkill('raynet-crm'), filePath, baseDir: root,
      });
      registry.setUserGrantable('raynet', true);
      let grants = ['skills', 'raynet'];
      const deps = {
        plugins: async () => registry,
        users: { get: () => ({ is_admin: false, granted_plugins: grants }) },
      };

      const expanded = await expandTurnSkillCommand('/skill:raynet-crm update company 42', deps, 7);
      expect(expanded).toContain('LIVE RAYNET BODY');
      expect(expanded).toContain('update company 42');

      grants = ['skills'];
      expect(await expandTurnSkillCommand('/skill:raynet-crm', deps, 7)).toContain('<skill-unavailable');
      expect(await expandTurnSkillCommand('/skill:raynet-crm', deps, 7)).not.toContain('LIVE RAYNET BODY');

      grants = ['raynet'];
      expect(await expandTurnSkillCommand('/skill:raynet-crm', deps, 7)).toContain('<skill-unavailable');

      grants = ['skills', 'raynet'];
      expect(await expandTurnSkillCommand('/skill:raynet-crm', deps, 7, { deny: new Set(['SkillLoad']) }))
        .toContain('<skill-unavailable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The skills ToolSearch may REPORT for a turn. Same capability gate as the prompt catalog — without
// SkillLoad the model could not act on a match — and manual-only skills stay hidden, exactly as
// formatSkillsForPrompt drops them from the announcement.
describe('searchableSkills', () => {
  const manualSkill = { ...fakeSkill('runbook'), disableModelInvocation: true } as PluginSkill;

  const registryWith = (skills: PluginSkill[], skillLoadComposed: boolean) => {
    const registry = new PluginRegistry();
    if (skillLoadComposed) {
      registry.contextFor('skills', {}, noopLog).registerTool(fakeTool('SkillLoad'));
      registry.setUserGrantable('skills', true);
    }
    registry.contextFor('raynet', {}, noopLog).registerSkill(...skills);
    registry.setUserGrantable('raynet', true);
    // The host control the daemon registers in brainCore, pointed at the live catalog.
    registry.registerHostControl('skillCatalog', {
      visibleSkills: () => registry.skillsFor(7, { is_admin: false, granted_plugins: ['skills', 'raynet'] }),
      canonicalBaseDir: () => null,
    });
    return registry;
  };

  const composed = (name: string) => name === 'SkillLoad';

  it('returns model-invocable skills only when SkillLoad is composed and permitted', async () => {
    const registry = registryWith([fakeSkill('raynet-crm')], true);
    expect(await searchableSkills(registry, composed)).toEqual([
      { name: 'raynet-crm', description: 'Use raynet-crm.' },
    ]);
    expect(await searchableSkills(registry, composed, { allow: new Set(['SkillLoad']) })).toHaveLength(1);
    // The one capability gate: a turn that may not load skills gets no suggestions either.
    expect(await searchableSkills(registry, composed, { deny: new Set(['SkillLoad']) })).toEqual([]);
  });

  it('is empty without the skillCatalog control or a composed SkillLoad', async () => {
    const bare = new PluginRegistry();
    bare.contextFor('raynet', {}, noopLog).registerSkill(fakeSkill('raynet-crm'));
    expect(await searchableSkills(bare, composed)).toEqual([]);

    const uncomposed = registryWith([fakeSkill('raynet-crm')], false);
    expect(await searchableSkills(uncomposed, composed)).toEqual([]);
  });

  it('drops manual-only (disable-model-invocation) skills from the suggestions', async () => {
    const registry = registryWith([fakeSkill('raynet-crm'), manualSkill], true);
    expect(await searchableSkills(registry, composed)).toEqual([
      { name: 'raynet-crm', description: 'Use raynet-crm.' },
    ]);
  });
});
