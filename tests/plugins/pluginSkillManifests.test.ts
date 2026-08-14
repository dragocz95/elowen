import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

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

interface Manifest { provides?: { skills?: string[] } }

const declaring = readdirSync(pluginsDir)
  .filter((name) => existsSync(join(pluginsDir, name, 'elowen-plugin.json')))
  .map((name) => ({
    name,
    skills: (JSON.parse(readFileSync(join(pluginsDir, name, 'elowen-plugin.json'), 'utf-8')) as Manifest)
      .provides?.skills ?? [],
  }))
  .filter((p) => p.skills.length > 0);

describe('a plugin that declares skills ships them', () => {
  it('finds the declaring plugins from their manifests', () => {
    // Guards the cases below: read from disk, so a new plugin is covered the moment it ships — and an
    // empty read would make every assertion below pass by doing nothing.
    expect(declaring.map((p) => p.name).sort()).toEqual(['agents', 'work']);
  });

  it.each(declaring)('$name has every declared skill on disk, loadable, under the declared name', ({ name, skills }) => {
    const dir = join(pluginsDir, name, 'skills');
    expect(existsSync(dir), `${name} declares skills but has no skills/ dir`).toBe(true);
    // Loaded through the same loader the plugin uses at registration: a file with a broken front matter
    // block exists but never becomes a skill, which is exactly the silent failure this guards.
    const loaded = loadSkillsFromDir({ dir, source: `elowen-plugin:${name}` }).skills.map((s) => s.name);
    for (const skill of skills) expect(loaded, `${name} declares ${skill}`).toContain(skill);
  });

  it.each(declaring)('$name registers what it declares, not merely ships it', ({ name, skills }) => {
    // The manifest is a claim about behaviour. Without the registration call the file is inert cargo —
    // present, loadable, and never reaching a prompt.
    const entry = join(pluginsDir, name, 'src', 'index.ts');
    const source = readFileSync(entry, 'utf-8');
    expect(source, `${name} declares ${skills.join(', ')} but never calls ctx.registerSkill`)
      .toMatch(/ctx\.registerSkill\(/);
  });
});
