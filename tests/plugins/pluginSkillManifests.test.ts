import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { fixturePlugins } from '../helpers/fixturePlugin.js';

/** A plugin that owns tools ships the skill teaching the model to use them, next to the tools rather
 *  than in the skills plugin — otherwise the instruction survives its tools and tells the model to call
 *  something nothing answers.
 *
 *  Nothing else checks that the arrangement holds. `provides.skills` is a manifest claim, the file is
 *  loose markdown, and the packaged copy exists only because `npm run build` happens to `cp -r plugins
 *  dist/`. Each of the three can break without the other two noticing, and the failure is silent: the
 *  plugin loads fine and the model simply never learns about its tools. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');

interface Manifest { entry?: string; provides?: { skills?: string[] } }

/** Every leg of the arrangement, checked from disk for one plugin tree, reported as a flat problem list
 *  so the caller can be held to an exact set rather than to "something threw". */
function auditSkillDeclarations(root: string): { declaring: string[]; problems: string[] } {
  const declaring: string[] = [];
  const problems: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const manifestPath = join(root, name, 'elowen-plugin.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest;
    const declared = manifest.provides?.skills ?? [];
    if (declared.length === 0) continue;
    declaring.push(name);

    const dir = join(root, name, 'skills');
    if (!existsSync(dir)) {
      problems.push(`${name}: declares ${declared.join(', ')} but has no skills/ dir`);
      continue;
    }
    // Loaded through the same loader the plugin uses at registration: a file with a broken front matter
    // block exists but never becomes a skill, which is exactly the silent failure this guards.
    const loaded = loadSkillsFromDir({ dir, source: `elowen-plugin:${name}` }).skills.map((s) => s.name);
    for (const skill of declared) {
      if (!loaded.includes(skill)) problems.push(`${name}: declares ${skill}, but no loadable skill ships under that name`);
    }

    // The manifest is a claim about behaviour. Without the registration call the file is inert cargo —
    // present, loadable, and never reaching a prompt. Read the entry the MANIFEST names: the bundled
    // plugins are hand-written .mjs today and the last TypeScript ones (src/index.ts, which this used to
    // assume) left for the plugin registry, so the entry is the only place that stays right.
    const entry = join(root, name, manifest.entry ?? 'index.mjs');
    if (!existsSync(entry)) { problems.push(`${name}: manifest entry ${manifest.entry ?? 'index.mjs'} does not exist`); continue; }
    if (!/ctx\.registerSkill\(/.test(readFileSync(entry, 'utf-8'))) {
      problems.push(`${name}: declares ${declared.join(', ')} but never calls ctx.registerSkill`);
    }
  }
  return { declaring, problems };
}

describe('a plugin that declares skills ships them', () => {
  it('holds for every bundled plugin that declares one', () => {
    // No bundled plugin declares a skill at the moment — agents (elowen-control) and work were the last
    // two and both moved to the plugin registry, which runs its own catalogue checks over them. So this
    // is the audit of a set that is currently empty, and it is the tests below, not this one, that keep
    // the audit itself honest in the meantime.
    expect(auditSkillDeclarations(pluginsDir).problems).toEqual([]);
  });
});

/** An empty subject set makes the assertion above true no matter what the audit does, so the audit is
 *  run against plugin trees written here: one that satisfies the arrangement, and one plugin per way of
 *  breaking it. The day a bundled plugin declares a skill again, the check above has real subjects and
 *  these keep it from rotting in the meantime. */
describe('the audit catches each way the arrangement breaks', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  const FRONT_MATTER = (name: string) => `---\nname: ${name}\ndescription: Use when closing a ledger period.\n---\n\n# ${name}\n\nBody.\n`;

  /** The fixture tree: a plugin per case, plus the skill files each one is supposed to ship. */
  function tree(): { declaring: string[]; problems: string[] } {
    const fixture = fixturePlugins([
      { name: 'healthy', provides: { skills: ['ledger-close'] }, register: "ctx.registerSkill({ name: 'ledger-close', path: 'skills/ledger-close.md' });" },
      { name: 'no-dir', provides: { skills: ['ledger-close'] }, register: "ctx.registerSkill({ name: 'ledger-close', path: 'skills/ledger-close.md' });" },
      { name: 'unloadable', provides: { skills: ['ledger-close'] }, register: "ctx.registerSkill({ name: 'ledger-close', path: 'skills/ledger-close.md' });" },
      { name: 'misnamed', provides: { skills: ['ledger-close'] }, register: "ctx.registerSkill({ name: 'ledger-close', path: 'skills/ledger-close.md' });" },
      { name: 'unregistered', provides: { skills: ['ledger-close'] }, register: 'ctx.registerTool({ name: "LedgerClose" });' },
      { name: 'declares-nothing', register: 'return;' },
    ]);
    cleanup = fixture.cleanup;
    const skill = (plugin: string, file: string, body: string) => {
      mkdirSync(join(fixture.dir, plugin, 'skills'), { recursive: true });
      writeFileSync(join(fixture.dir, plugin, 'skills', file), body);
    };
    skill('healthy', 'ledger-close.md', FRONT_MATTER('ledger-close'));
    skill('unloadable', 'ledger-close.md', '# ledger-close\n\nNo front matter block, so nothing ever becomes a skill.\n');
    skill('misnamed', 'ledger-close.md', FRONT_MATTER('ledger-open')); // ships A, promised B
    skill('unregistered', 'ledger-close.md', FRONT_MATTER('ledger-close'));
    return auditSkillDeclarations(fixture.dir);
  }

  it('reports exactly the plugins that break it, and passes the one that does not', () => {
    const { declaring, problems } = tree();
    // A plugin declaring no skill is outside the rule entirely and must not be dragged into it.
    expect(declaring).toEqual(['healthy', 'misnamed', 'no-dir', 'unloadable', 'unregistered']);
    expect(problems.sort()).toEqual([
      'misnamed: declares ledger-close, but no loadable skill ships under that name',
      'no-dir: declares ledger-close but has no skills/ dir',
      'unloadable: declares ledger-close, but no loadable skill ships under that name',
      'unregistered: declares ledger-close but never calls ctx.registerSkill',
    ]);
    expect(problems.filter((p) => p.startsWith('healthy:'))).toEqual([]);
  });
});
