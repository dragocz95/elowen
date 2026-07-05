// Bundled reference plugin: exposes markdown skills to the brain. Hand-written ESM (no build step) so
// it doubles as the canonical example of the plugin format. It reads .md skills from its own `skills/`
// directory plus the instance's user skills dir (where create_skill writes), and registers each so the
// brain's system prompt advertises them. The creator tools are admin-only — skills are shared state.
import { loadSkillsFromDir, defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';

const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function register(ctx) {
  const here = dirname(fileURLToPath(import.meta.url));
  const userDir = ctx.dataDir(); // instance-local skills created at runtime
  let count = 0;
  for (const { dir, source } of [
    { dir: join(here, 'skills'), source: 'orca-plugin:skills' },
    { dir: userDir, source: 'orca-user:skills' },
  ]) {
    if (!existsSync(dir)) continue;
    const { skills } = loadSkillsFromDir({ dir, source });
    for (const skill of skills) ctx.registerSkill(skill);
    count += skills.length;
  }

  const adminOnly = () => { if (!ctx.isAdminSession()) throw new Error('skills can only be managed from an admin session'); };

  // Load a skill's full instructions on demand. NOT admin-gated: any session may load a skill it was
  // told about in <available_skills> so it can actually follow it — reading is not a mutation.
  ctx.registerTool(defineTool({
    name: 'read_skill', label: 'Read skill',
    description: 'Load a skill\'s full instructions by name (from the <available_skills> list) so you can follow it. Use this instead of reading the skill file directly.',
    parameters: Type.Object({ name: Type.String({ description: 'The skill name from <available_skills>, e.g. deploy-checklist' }) }),
    execute: async (_id, p) => {
      try {
        if (!NAME_RE.test(p.name)) return ok('Error: invalid skill name.');
        for (const dir of [join(here, 'skills'), userDir]) {
          const file = join(dir, `${p.name}.md`);
          if (existsSync(file)) return ok(readFileSync(file, 'utf-8'));
        }
        return ok(`Error: no skill named "${p.name}". Call list_skills to see what's available.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'create_skill', label: 'Create skill',
    description: 'Create (or overwrite) a reusable markdown skill. It becomes part of your system prompt for NEW conversations after a brain restart. Admin only.',
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
        return ok(`Skill "${p.name}" saved. It loads into new conversations after the plugins reload (Settings → Plugins toggle, or daemon restart).`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'list_skills', label: 'List skills',
    description: 'List available skills (bundled + user-created).',
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const rows = [];
        for (const { dir, tag } of [{ dir: join(here, 'skills'), tag: 'bundled' }, { dir: userDir, tag: 'user' }]) {
          if (!existsSync(dir)) continue;
          for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
            const head = readFileSync(join(dir, f), 'utf-8').slice(0, 400);
            const desc = /description:\s*(.+)/.exec(head)?.[1] ?? '';
            rows.push(`- ${f.replace(/\.md$/, '')} (${tag}) — ${desc}`);
          }
        }
        return ok(rows.length ? rows.join('\n') : 'No skills found.');
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'delete_skill', label: 'Delete skill',
    description: 'Delete a user-created skill by name (bundled skills cannot be deleted). Admin only.',
    parameters: Type.Object({ name: Type.String() }),
    execute: async (_id, p) => {
      try {
        adminOnly();
        if (!NAME_RE.test(p.name)) return ok('Error: invalid skill name.');
        const file = join(userDir, `${p.name}.md`);
        if (!existsSync(file)) return ok(`Error: no user skill named "${p.name}".`);
        unlinkSync(file);
        return ok(`Skill "${p.name}" deleted.`);
      } catch (e) { return fail(e); }
    },
  }));

  // Nudge the brain to LOAD a skill through the tool (a clean "read_skill(name)" chip) rather than
  // reading the raw file — the <available_skills> block only lists names + descriptions.
  if (count > 0) {
    ctx.registerSystemPromptFragment(
      'To use a skill listed in <available_skills>, call `read_skill` with its name to load the full '
      + 'instructions, then follow them. Do not open the skill file directly.',
    );
  }

  ctx.logger.info(`registered ${count} skill(s) + creator tools`);
}
