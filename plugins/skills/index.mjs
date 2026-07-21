// Bundled reference plugin: exposes markdown skills to the brain. Hand-written ESM (no build step) so
// it doubles as the canonical example of the plugin format. It reads .md skills from its own `skills/`
// directory plus the instance's user skills dir (where CreateSkill writes), and registers each so the
// brain's system prompt advertises them. The creator tools are admin-only — skills are shared state.
import { loadSkillsFromDir, defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, resolve, sep } from 'node:path';
import { writeFileSync, unlinkSync, rmSync, existsSync, statSync } from 'node:fs';

const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function register(ctx) {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundledDir = join(here, 'skills');
  const userDir = ctx.dataDir(); // instance-local skills created at runtime
  // Both catalog surfaces (list/delete) go through PI's loader, not a raw `*.md` readdir, so they see
  // EVERY skill PI actually loads — including the `<name>/SKILL.md` directory form (PI treats a dir with a
  // SKILL.md as a skill root). A flat readdir would silently miss those.
  const loadSkills = (dir, source) => (existsSync(dir) ? loadSkillsFromDir({ dir, source }).skills : []);

  let count = 0;
  for (const { dir, source } of [
    { dir: bundledDir, source: 'elowen-plugin:skills' },
    { dir: userDir, source: 'elowen-user:skills' },
  ]) {
    const skills = loadSkills(dir, source);
    for (const skill of skills) ctx.registerSkill(skill);
    count += skills.length;
  }

  const adminOnly = () => { if (!ctx.isAdminSession()) throw new Error('skills can only be managed from an admin session'); };

  // Skill INVOCATION is fully PI-native: the resource loader's skillsOverride feeds these registered
  // skills to PI, which advertises them (progressive disclosure) in the system prompt and expands
  // `/skill:name` on its own. This plugin only LOADS skills and offers the admin write tools below.
  ctx.registerTool(defineTool({
    name: 'CreateSkill', label: 'Create skill',
    description: 'Create (or overwrite) a reusable markdown skill. It is applied live: available in your system prompt from the next message onward. Admin only.',
    parameters: Type.Object({
      name: Type.String({ description: 'kebab-case identifier, e.g. deploy-checklist' }),
      description: Type.String({ description: 'One line: when to use this skill' }),
      content: Type.String({ description: 'The skill body (markdown instructions)' }),
    }),
    execute: async (_id, p) => {
      try {
        adminOnly();
        if (!NAME_RE.test(p.name)) return ok('Error: name must be kebab-case (a-z, 0-9, dashes), max 64 chars.');
        const body = `---\nname: ${p.name}\ndescription: ${p.description.replaceAll('\n', ' ')}\n---\n\n${p.content}\n`;
        writeFileSync(join(userDir, `${p.name}.md`), body, 'utf-8');
        // Apply live: the host reloads plugins once the current turn settles (respawning the session), so
        // the new skill is in the available-skills block from the next message — no restart needed.
        ctx.requestReload?.();
        return ok(`Skill "${p.name}" saved. It is available from your next message.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'ListSkills', label: 'List skills',
    description: 'List available skills (bundled + user-created).',
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const rows = [];
        for (const { dir, source, tag } of [
          { dir: bundledDir, source: 'elowen-plugin:skills', tag: 'bundled' },
          { dir: userDir, source: 'elowen-user:skills', tag: 'user' },
        ]) {
          for (const s of loadSkills(dir, source)) {
            const flags = s.disableModelInvocation ? ', /skill only' : '';
            rows.push(`- ${s.name} (${tag}${flags}) — ${s.description}`);
          }
        }
        return ok(rows.length ? rows.join('\n') : 'No skills found.');
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DeleteSkill', label: 'Delete skill',
    description: 'Delete a user-created skill by name (bundled skills cannot be deleted). Admin only.',
    parameters: Type.Object({ name: Type.String() }),
    execute: async (_id, p) => {
      try {
        adminOnly();
        if (!NAME_RE.test(p.name)) return ok('Error: invalid skill name.');
        // Resolve via the loader so BOTH forms are deletable: a flat `<name>.md` (unlink the file) and a
        // `<name>/SKILL.md` directory skill (remove the whole skill root). Guard the resolved path stays
        // inside userDir so a crafted frontmatter name can never point the delete outside it.
        const skill = loadSkills(userDir, 'elowen-user:skills').find((s) => s.name === p.name);
        if (!skill) return ok(`Error: no user skill named "${p.name}".`);
        const isDirForm = basename(skill.filePath).toLowerCase() === 'skill.md';
        const target = isDirForm ? dirname(skill.filePath) : skill.filePath;
        const base = resolve(userDir);
        const abs = resolve(target);
        if (abs !== base && !abs.startsWith(base + sep)) return ok('Error: skill path is outside the user skills directory.');
        if (abs === base) return ok('Error: refusing to delete the skills root.');
        if (isDirForm && statSync(abs).isDirectory()) rmSync(abs, { recursive: true, force: true });
        else unlinkSync(abs);
        ctx.requestReload?.(); // apply live, same as CreateSkill — the skill leaves the prompt next message
        return ok(`Skill "${p.name}" deleted.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.logger.info(`registered ${count} skill(s) + creator tools`);
}
