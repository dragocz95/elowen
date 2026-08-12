// Bundled reference plugin: exposes markdown skills to the brain. Hand-written ESM (no build step) so
// it doubles as the canonical example of the plugin format. It reads .md skills from its own `skills/`
// directory plus the instance's user skills dir (where CreateSkill writes), and registers each so the
// brain's system prompt advertises them. The creator tools are admin-only — skills are shared state.
import { loadSkillsFromDir, defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, resolve, sep } from 'node:path';
import { writeFileSync, unlinkSync, rmSync, rmdirSync, existsSync, statSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';

const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
// Names that collide with the core per-plugin route family under /plugins/skills/* (PATCH
// /plugins/:name/config would eat PATCH /plugins/skills/config, and the rest are reserved for URL
// hygiene). Core matched routes first, so a skill with one of these names could never be edited.
const RESERVED_NAMES = new Set(['config', 'icon', 'logs', 'contributions', 'hook-executions', 'data', 'restore', 'api', 'list']);

/** Split a skill file into its leading `---` fenced YAML frontmatter and the markdown body — the
 *  regex mirrors src/shared/frontmatter.ts (this no-build plugin cannot import daemon sources):
 *  BOM-tolerant, CRLF-tolerant, and the block ends at the FIRST `---` line so a horizontal rule
 *  later in the body stays body. */
const FRONTMATTER_RE = /^\uFEFF?---[ \t]*(?:\r?\n)([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
function splitFrontmatter(source) {
  const m = FRONTMATTER_RE.exec(source);
  if (!m) return { frontmatter: '', body: source };
  return { frontmatter: m[1] ?? '', body: m[2] ?? '' };
}

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

  // ── Admin skills API (root mounts, grandfathered core URLs): bundled .md skills ship inside this
  // plugin folder (read-only), user skills live in the plugin's writable data dir — the same files
  // CreateSkill/DeleteSkill write. Both the flat `<name>.md` and the Agent-Skills `<name>/SKILL.md`
  // directory layout are supported, because the loader reads either. A successful write/delete
  // requests a plugin reload (deferred + coalesced by the host), so new conversations pick it up. ──

  // Resolve a skill name to its file in a dir, accepting both layouts. Flat wins when both exist so a
  // stray `<name>.md` keeps shadowing the folder the way the loader sees it.
  const skillFileIn = (dir, name) => {
    const flat = join(dir, `${name}.md`);
    if (existsSync(flat)) return flat;
    const nested = join(dir, name, 'SKILL.md');
    return existsSync(nested) ? nested : null;
  };
  // Every skill file in a dir, from both layouts. A folder only counts when it carries a SKILL.md —
  // support dirs (references/, scripts/) never appear as skills on their own.
  const enumerateSkills = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) out.push({ name: entry.name.replace(/\.md$/, ''), file: join(dir, entry.name) });
      else if (entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md'))) out.push({ name: entry.name, file: join(dir, entry.name, 'SKILL.md') });
    }
    return out;
  };
  // Frontmatter as an object + trimmed body. Unknown fields (license, allowed-tools, compatibility,
  // metadata…) stay in the object so a write preserves them verbatim instead of dropping them.
  const splitSkillFile = (raw) => {
    const { frontmatter, body } = splitFrontmatter(raw);
    let front = {};
    if (frontmatter) {
      try {
        const parsed = parseYaml(frontmatter);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) front = parsed;
      } catch { /* malformed frontmatter → treat as absent; the body stays editable */ }
    }
    return { front, body: body.replace(/^\n+/, '').replace(/\n+$/, '') };
  };
  const skillVersion = (front) => {
    const meta = front.metadata;
    if (meta && typeof meta === 'object' && !Array.isArray(meta) && typeof meta.version === 'number') return meta.version;
    return null;
  };
  const readSkillFile = (file) => {
    const { front, body } = splitSkillFile(readFileSync(file, 'utf-8'));
    return {
      front,
      description: typeof front.description === 'string' ? front.description : '',
      content: body,
      disableModelInvocation: front['disable-model-invocation'] === true,
      version: skillVersion(front),
    };
  };
  // Overlay the fields the editor manages onto an existing frontmatter object, leaving every other key
  // (and its order) untouched. Serializing via the YAML library — not string interpolation — keeps a
  // description with a colon-space or a leading '#' valid.
  const applyManagedFields = (existing, name, description, disableModelInvocation) => {
    const fm = { ...existing };
    fm.name = name;
    fm.description = description.replaceAll('\n', ' ');
    if (disableModelInvocation) fm['disable-model-invocation'] = true;
    else delete fm['disable-model-invocation'];
    return fm;
  };
  // Bump metadata.version in place (absent/invalid → 1).
  const bumpVersion = (fm) => {
    const meta = (fm.metadata && typeof fm.metadata === 'object' && !Array.isArray(fm.metadata)) ? { ...fm.metadata } : {};
    meta.version = (typeof meta.version === 'number' ? meta.version : 0) + 1;
    fm.metadata = meta;
  };
  const buildSkillBody = (front, content) => `---\n${stringifyYaml(front).trimEnd()}\n---\n\n${content}\n`;
  const jsonRes = (body, status = 200) => ({ status, body });

  ctx.registerApiRoute({
    rootMount: '/plugins/skills/list', path: '', method: 'GET', access: 'admin',
    handler: async (req) => {
      if (req.path !== '') return jsonRes({ error: 'not found' }, 404);
      const out = [];
      for (const { dir, source } of [
        { dir: bundledDir, source: 'bundled' },
        { dir: userDir, source: 'user' },
      ]) {
        if (!dir || !existsSync(dir)) continue;
        for (const { name, file } of enumerateSkills(dir)) {
          const parsed = readSkillFile(file);
          out.push({
            name,
            description: parsed.description,
            source,
            scope: source === 'bundled' ? 'bundled/system' : 'user-defined',
            location: file,
            active: true, // this plugin is serving the request, so it is enabled by definition
            canDelete: source === 'user',
            disableModelInvocation: parsed.disableModelInvocation,
            version: parsed.version,
            // User skills carry their body so the web editor can prefill an edit; bundled skills are
            // read-only, so their (larger) content is left off the list payload.
            ...(source === 'user' ? { content: parsed.content } : {}),
          });
        }
      }
      return jsonRes(out);
    },
  });

  // Create (or overwrite) a user skill — the same file format CreateSkill writes. A name shadowing a
  // bundled skill is refused: the plugin registers both copies and the duplicate would silently fight
  // over the system prompt.
  ctx.registerApiRoute({
    rootMount: '/plugins/skills', path: '', method: 'POST', access: 'admin',
    handler: async (req) => {
      if (req.path !== '') return jsonRes({ error: 'not found' }, 404);
      let b;
      try { b = await req.json(); } catch { b = null; }
      const name = typeof b?.name === 'string' ? b.name.trim() : '';
      const description = typeof b?.description === 'string' ? b.description.trim() : '';
      const content = typeof b?.content === 'string' ? b.content : '';
      const disableModelInvocation = b?.disableModelInvocation === true;
      if (!NAME_RE.test(name)) return jsonRes({ error: 'name must be kebab-case (a-z, 0-9, dashes), max 64 chars' }, 400);
      if (RESERVED_NAMES.has(name)) return jsonRes({ error: `"${name}" is reserved (it collides with a core /plugins route)` }, 400);
      if (description === '' || content.trim() === '') return jsonRes({ error: 'description and content must be non-empty' }, 400);
      if (skillFileIn(bundledDir, name)) return jsonRes({ error: `a bundled skill named "${name}" already exists` }, 400);
      mkdirSync(userDir, { recursive: true });
      writeFileSync(join(userDir, `${name}.md`), buildSkillBody(applyManagedFields({}, name, description, disableModelInvocation), content), 'utf-8');
      ctx.requestReload?.(); // skills feed the brain's system prompt — apply live
      return jsonRes({ ok: true }, 201);
    },
  });

  // Edit a user skill (bundled skills are read-only). Partial: any of description/content/the
  // disable-model-invocation flag may be omitted to keep its current value. The flag toggle lets an
  // operator hide a skill from progressive disclosure while leaving `/skill:name` invocation intact.
  ctx.registerApiRoute({
    rootMount: '/plugins/skills/:name', path: '', method: 'PATCH', access: 'admin',
    handler: async (req) => {
      if (req.path !== '') return jsonRes({ error: 'not found' }, 404);
      const name = req.params.name ?? '';
      if (!NAME_RE.test(name)) return jsonRes({ error: 'invalid skill name' }, 400);
      if (skillFileIn(bundledDir, name)) return jsonRes({ error: 'bundled skills cannot be edited' }, 400);
      const file = skillFileIn(userDir, name);
      if (!file) return jsonRes({ error: 'unknown skill' }, 404);
      let b;
      try { b = await req.json(); } catch { b = null; }
      const cur = readSkillFile(file);
      const description = typeof b?.description === 'string' ? b.description.trim() : cur.description;
      const content = typeof b?.content === 'string' ? b.content : cur.content;
      const disableModelInvocation = typeof b?.disableModelInvocation === 'boolean' ? b.disableModelInvocation : cur.disableModelInvocation;
      if (description === '' || content.trim() === '') return jsonRes({ error: 'description and content must be non-empty' }, 400);
      const fm = applyManagedFields(cur.front, name, description, disableModelInvocation);
      // Bump the revision only when the editable content actually changed — a bare disclosure toggle
      // is an operational flag, not a new version of the skill.
      if (description !== cur.description || content !== cur.content) bumpVersion(fm);
      writeFileSync(file, buildSkillBody(fm, content), 'utf-8');
      ctx.requestReload?.();
      return jsonRes({ ok: true });
    },
  });

  ctx.registerApiRoute({
    rootMount: '/plugins/skills/:name', path: '', method: 'DELETE', access: 'admin',
    handler: async (req) => {
      if (req.path !== '') return jsonRes({ error: 'not found' }, 404);
      const name = req.params.name ?? '';
      if (!NAME_RE.test(name)) return jsonRes({ error: 'invalid skill name' }, 400);
      if (skillFileIn(bundledDir, name)) return jsonRes({ error: 'bundled skills cannot be deleted' }, 400);
      const file = skillFileIn(userDir, name);
      if (!file) return jsonRes({ error: 'unknown skill' }, 404);
      unlinkSync(file);
      // A directory-form skill leaves its folder behind; drop it if now empty, but keep it (with any
      // references/scripts support files) if something remains.
      const parent = dirname(file);
      if (parent !== userDir) { try { rmdirSync(parent); } catch { /* not empty → keep */ } }
      ctx.requestReload?.();
      return jsonRes({ ok: true });
    },
  });

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
