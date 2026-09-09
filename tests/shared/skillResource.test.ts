import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import { containedSkillResource, directorySkillResourceRoot } from '../../src/shared/skillResource.js';

/** The boundary a managed session's skill support file must cross. SkillLoad returns a canonical HOST
 *  directory the guest cannot read, so the only safe way to follow a directory-form skill's relative
 *  references is a host-side resolve that re-checks containment every time — against the directory as it
 *  was PINNED, never against whatever that path points at now. */
describe('containedSkillResource', () => {
  let root: string;
  let skill: string;
  let sibling: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-resource-'));
    skill = join(root, 'skills', 'demo');
    sibling = join(root, 'skills', 'other');
    mkdirSync(join(skill, 'refs'), { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# demo');
    writeFileSync(join(skill, 'refs', 'reference.md'), 'support content');
    writeFileSync(join(sibling, 'secret.md'), 'another skill');
    writeFileSync(join(root, 'host-secret.txt'), 'host');
    symlinkSync(join(root, 'host-secret.txt'), join(skill, 'escape.md'));
  });

  it('resolves the absolute path SkillLoad disclosed', () => {
    expect(containedSkillResource(skill, join(skill, 'refs', 'reference.md'))).toBe(join(skill, 'refs', 'reference.md'));
    expect(containedSkillResource(skill, join(skill, 'SKILL.md'))).toBe(join(skill, 'SKILL.md'));
  });

  it('refuses every relative form, so there is no second string aimed at the same check', () => {
    expect(containedSkillResource(skill, 'refs/reference.md')).toBeNull();
    expect(containedSkillResource(skill, './SKILL.md')).toBeNull();
    expect(containedSkillResource(skill, '../other/secret.md')).toBeNull();
  });

  it('refuses an absolute path outside the skill directory', () => {
    expect(containedSkillResource(skill, join(root, 'host-secret.txt'))).toBeNull();
    expect(containedSkillResource(skill, '/etc/hostname')).toBeNull();
    expect(containedSkillResource(skill, join(sibling, 'secret.md'))).toBeNull();
  });

  it('refuses traversal spelled inside an absolute path', () => {
    expect(containedSkillResource(skill, join(skill, '..', 'other', 'secret.md'))).toBeNull();
  });

  it('refuses a symlink that points out of the directory, which a string prefix check would accept', () => {
    expect(containedSkillResource(skill, join(skill, 'escape.md'))).toBeNull();
  });

  it('refuses empty, NUL-bearing and missing references, the directory itself, and a relative base', () => {
    expect(containedSkillResource(skill, '')).toBeNull();
    expect(containedSkillResource(skill, '   ')).toBeNull();
    expect(containedSkillResource(skill, join(skill, 'ref\0.md'))).toBeNull();
    expect(containedSkillResource(skill, join(skill, 'nope.md'))).toBeNull();
    expect(containedSkillResource(skill, skill)).toBeNull();
    expect(containedSkillResource(skill, join(skill, 'refs'))).toBeNull();
    expect(containedSkillResource('skills/demo', join(skill, 'SKILL.md'))).toBeNull();
    expect(containedSkillResource('', join(skill, 'SKILL.md'))).toBeNull();
  });

  it('refuses everything when the pinned base directory does not exist', () => {
    expect(containedSkillResource(join(root, 'missing'), join(root, 'missing', 'SKILL.md'))).toBeNull();
  });

  /** The reproduced escape: resolving the BASE again let an attacker replace the pinned directory with a
   *  symlink, after which every file under the new target passed containment. The pin is a string and is
   *  compared as one, so a base that has been moved out from under the registration simply stops matching. */
  it('refuses everything after the pinned base is replaced by a symlink elsewhere', () => {
    const pinned = join(root, 'skills', 'pinned');
    const attacker = join(root, 'attacker');
    mkdirSync(pinned, { recursive: true });
    mkdirSync(attacker, { recursive: true });
    writeFileSync(join(pinned, 'SKILL.md'), '# pinned');
    writeFileSync(join(attacker, 'loot.txt'), 'secret');
    expect(containedSkillResource(pinned, join(pinned, 'SKILL.md'))).toBe(join(pinned, 'SKILL.md'));
    expect(containedSkillResource(pinned, join(attacker, 'loot.txt'))).toBeNull();

    renameSync(pinned, join(root, 'skills', 'pinned-moved'));
    symlinkSync(attacker, pinned);

    expect(containedSkillResource(pinned, join(attacker, 'loot.txt'))).toBeNull();
    expect(containedSkillResource(pinned, join(pinned, 'loot.txt'))).toBeNull();
  });
});

/** Which skills have a support root at all. The loader pins a FLAT skill's base to the shared folder it
 *  sits in, and on the instance skills directory that folder also holds every account's personal skills. */
describe('directorySkillResourceRoot', () => {
  let root: string;
  let flatBase: string;
  let directorySkill: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-root-'));
    flatBase = join(root, 'skills');
    directorySkill = join(flatBase, 'canvas-design');
    mkdirSync(join(directorySkill, 'refs'), { recursive: true });
    mkdirSync(join(flatBase, 'users', '1'), { recursive: true });
    writeFileSync(join(flatBase, 'email-management.md'), '# flat');
    writeFileSync(join(flatBase, 'users', '1', 'private.md'), '# private');
    writeFileSync(join(directorySkill, 'SKILL.md'), '# directory form');
    writeFileSync(join(directorySkill, 'refs', 'reference.md'), 'support');
  });

  it('gives a directory-form skill its own folder', () => {
    expect(directorySkillResourceRoot(directorySkill, join(directorySkill, 'SKILL.md'))).toBe(directorySkill);
  });

  it('gives a flat skill no root, whatever the loader pinned as its base', () => {
    expect(directorySkillResourceRoot(flatBase, join(flatBase, 'email-management.md'))).toBeNull();
    expect(directorySkillResourceRoot(flatBase, join(flatBase, 'users', '1', 'private.md'))).toBeNull();
  });

  it('requires the skill file to be the base directory\'s own SKILL.md', () => {
    // A SKILL.md deeper in the tree does not widen the base to the folder above it.
    expect(directorySkillResourceRoot(flatBase, join(directorySkill, 'SKILL.md'))).toBeNull();
    expect(directorySkillResourceRoot(directorySkill, join(directorySkill, 'refs', 'reference.md'))).toBeNull();
    expect(directorySkillResourceRoot(directorySkill, join(directorySkill, 'skill.md'))).toBeNull();
    expect(directorySkillResourceRoot(directorySkill, join(directorySkill, 'MISSING.md'))).toBeNull();
  });

  it('refuses a missing base, a relative base and a relative skill file', () => {
    expect(directorySkillResourceRoot(null, join(directorySkill, 'SKILL.md'))).toBeNull();
    expect(directorySkillResourceRoot(join(root, 'gone'), join(root, 'gone', 'SKILL.md'))).toBeNull();
    expect(directorySkillResourceRoot('skills/canvas-design', join(directorySkill, 'SKILL.md'))).toBeNull();
    expect(directorySkillResourceRoot(directorySkill, 'SKILL.md')).toBeNull();
  });
});
