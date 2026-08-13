import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';

let dirs: string[] = [];
const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`;

// The '/plugins/skills/*' surface is served by the REAL skills plugin (root mounts), loaded from the
// repo's plugins dir — so the "bundled" fixtures below are the plugin's actual shipped skills
// ('skill-creation', 'elowen-control'), not synthetic ones: the .mjs resolves its bundled dir next to
// its own file, and copying it into a tmp scan root would break its bare-specifier imports.
const pluginsDir = join(process.cwd(), 'plugins');
const BUNDLED = 'skill-creation';

function setup(opts: { enabled?: string[] } = {}) {
  const dataRoot = tmpDir('skills-data');
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const amy = users.create('amy', 'pw');
  const provider = new PluginRegistryProvider(() => loadPlugins({
    dirs: [pluginsDir], enabled: opts.enabled ?? ['skills'], dataRoot,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }));
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    pluginDirs: [pluginsDir], pluginDataRoot: dataRoot,
    plugins: provider,
  });
  return { app, userDir: join(dataRoot, 'skills'), adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const del = (t: string) => ({ method: 'DELETE', headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

const skill = (extra: Record<string, unknown> = {}) => ({ name: 'deploy-checklist', description: 'When deploying.', content: 'Check twice.', ...extra });

describe('skills routes', () => {
  it('GET /plugins/skills/list returns bundled + user skills with parsed descriptions', async () => {
    const { app, userDir, adminTok } = setup();
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'my-skill.md'), skillMd('my-skill', 'A user skill.'));
    const res = await app.request('/plugins/skills/list', auth(adminTok));
    expect(res.status).toBe(200);
    const list = (await res.json()) as { name: string }[];
    expect(list).toContainEqual(expect.objectContaining({ name: BUNDLED, source: 'bundled', scope: 'bundled/system', active: true, canDelete: false }));
    expect(list).toContainEqual(expect.objectContaining({ name: 'my-skill', description: 'A user skill.', source: 'user', scope: 'user-defined', active: true, canDelete: true }));
  });

  it('GET lists bundled skills even when the user dir does not exist yet', async () => {
    const { app, adminTok } = setup();
    const res = await app.request('/plugins/skills/list', auth(adminTok));
    const list = (await res.json()) as { name: string; source: string }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((sk) => sk.source === 'bundled')).toBe(true);
    expect(list).toContainEqual(expect.objectContaining({ name: BUNDLED, canDelete: false }));
  });

  it('POST creates the user skill file in the CreateSkill format and GET lists it', async () => {
    const { app, userDir, adminTok } = setup();
    const res = await app.request('/plugins/skills', post(adminTok, skill()));
    expect(res.status).toBe(201);
    expect(readFileSync(join(userDir, 'deploy-checklist.md'), 'utf-8'))
      .toBe('---\nname: deploy-checklist\ndescription: When deploying.\n---\n\nCheck twice.\n');
    const list = (await (await app.request('/plugins/skills/list', auth(adminTok))).json()) as { name: string; source: string }[];
    expect(list).toContainEqual(expect.objectContaining({ name: 'deploy-checklist', description: 'When deploying.', source: 'user', canDelete: true }));
  });

  it('POST flattens newlines in the description (frontmatter stays one line)', async () => {
    const { app, userDir, adminTok } = setup();
    await app.request('/plugins/skills', post(adminTok, skill({ description: 'line one\nline two' })));
    expect(readFileSync(join(userDir, 'deploy-checklist.md'), 'utf-8')).toContain('description: line one line two\n');
  });

  it('POST rejects a bad name, empty description/content and a non-JSON body (400)', async () => {
    const { app, adminTok } = setup();
    for (const bad of [skill({ name: 'Bad Name' }), skill({ name: 'x' }), skill({ description: '' }), skill({ content: '  ' }), skill({ content: undefined })]) {
      expect((await app.request('/plugins/skills', post(adminTok, bad))).status, JSON.stringify(bad)).toBe(400);
    }
    const raw = await app.request('/plugins/skills', { method: 'POST', headers: { authorization: `Bearer ${adminTok}`, 'content-type': 'application/json' }, body: '{not json' });
    expect(raw.status).toBe(400);
  });

  it('POST refuses a name colliding with a bundled skill (400) but overwrites a user skill', async () => {
    const { app, adminTok } = setup();
    expect((await app.request('/plugins/skills', post(adminTok, skill({ name: BUNDLED })))).status).toBe(400);
    expect((await app.request('/plugins/skills', post(adminTok, skill()))).status).toBe(201);
    expect((await app.request('/plugins/skills', post(adminTok, skill({ content: 'v2' })))).status).toBe(201);
  });

  it('POST writes the disable-model-invocation flag and GET reports it', async () => {
    const { app, userDir, adminTok } = setup();
    await app.request('/plugins/skills', post(adminTok, skill({ disableModelInvocation: true })));
    expect(readFileSync(join(userDir, 'deploy-checklist.md'), 'utf-8')).toContain('disable-model-invocation: true\n');
    const list = (await (await app.request('/plugins/skills/list', auth(adminTok))).json()) as { name: string; disableModelInvocation: boolean; content?: string }[];
    const row = list.find((s) => s.name === 'deploy-checklist');
    expect(row?.disableModelInvocation).toBe(true);
    expect(row?.content).toBe('Check twice.'); // user skills carry their body so the editor can prefill
  });

  it('PATCH edits a user skill in place; partial fields keep their current value', async () => {
    const { app, userDir, adminTok } = setup();
    await app.request('/plugins/skills', post(adminTok, skill()));
    // Toggle the flag only — description/content are preserved.
    expect((await app.request('/plugins/skills/deploy-checklist', patch(adminTok, { disableModelInvocation: true }))).status).toBe(200);
    expect(readFileSync(join(userDir, 'deploy-checklist.md'), 'utf-8'))
      .toBe('---\nname: deploy-checklist\ndescription: When deploying.\ndisable-model-invocation: true\n---\n\nCheck twice.\n');
    // Edit body + description, and clear the flag. A content edit bumps metadata.version (absent → 1).
    expect((await app.request('/plugins/skills/deploy-checklist', patch(adminTok, { description: 'Updated.', content: 'New body.', disableModelInvocation: false }))).status).toBe(200);
    expect(readFileSync(join(userDir, 'deploy-checklist.md'), 'utf-8'))
      .toBe('---\nname: deploy-checklist\ndescription: Updated.\nmetadata:\n  version: 1\n---\n\nNew body.\n');
  });

  it('PATCH preserves unknown frontmatter fields (license/allowed-tools/metadata/compatibility)', async () => {
    const { app, userDir, adminTok } = setup();
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'claude-skill.md'),
      '---\nname: claude-skill\ndescription: "Quoted: with a colon"\nlicense: MIT\nallowed-tools:\n  - Read\n  - Grep\ncompatibility: pi>=1\nmetadata:\n  version: 3\n  author: sam\n---\n\nOriginal body.\n');
    // Toggle the disclosure flag only — nothing else may be lost, and the version must NOT bump.
    expect((await app.request('/plugins/skills/claude-skill', patch(adminTok, { disableModelInvocation: true }))).status).toBe(200);
    const raw = readFileSync(join(userDir, 'claude-skill.md'), 'utf-8');
    expect(raw).toContain('license: MIT\n');
    expect(raw).toContain('allowed-tools:\n  - Read\n  - Grep\n');
    expect(raw).toContain('compatibility: pi>=1\n');
    expect(raw).toContain('version: 3\n');
    expect(raw).toContain('author: sam\n');
    expect(raw).toContain('disable-model-invocation: true\n');
    // The quoted description parses cleanly (no surrounding quotes leak into the UI payload).
    const list = (await (await app.request('/plugins/skills/list', auth(adminTok))).json()) as { name: string; description: string; version: number | null }[];
    const row = list.find((s) => s.name === 'claude-skill');
    expect(row?.description).toBe('Quoted: with a colon');
    expect(row?.version).toBe(3);
  });

  it('PATCH bumps metadata.version on a content edit but not on a flag-only toggle', async () => {
    const { app, userDir, adminTok } = setup();
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'versioned.md'), '---\nname: versioned\ndescription: D.\nmetadata:\n  version: 5\n---\n\nBody.\n');
    // Flag-only toggle: version stays 5.
    await app.request('/plugins/skills/versioned', patch(adminTok, { disableModelInvocation: true }));
    expect(readFileSync(join(userDir, 'versioned.md'), 'utf-8')).toContain('version: 5\n');
    // Content edit: 5 → 6.
    await app.request('/plugins/skills/versioned', patch(adminTok, { content: 'Changed.' }));
    expect(readFileSync(join(userDir, 'versioned.md'), 'utf-8')).toContain('version: 6\n');
  });

  it('reads, edits and deletes the directory-form <name>/SKILL.md layout', async () => {
    const { app, userDir, adminTok } = setup();
    const skillDir = join(userDir, 'nested-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: nested-skill\ndescription: Nested.\n---\n\nNested body.\n');
    // A support file that must survive a delete of the skill.
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    writeFileSync(join(skillDir, 'references', 'notes.md'), 'keep me\n');

    const list = (await (await app.request('/plugins/skills/list', auth(adminTok))).json()) as { name: string; content?: string }[];
    expect(list).toContainEqual(expect.objectContaining({ name: 'nested-skill', content: 'Nested body.' }));

    expect((await app.request('/plugins/skills/nested-skill', patch(adminTok, { content: 'Edited.' }))).status).toBe(200);
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toContain('Edited.\n');

    expect((await app.request('/plugins/skills/nested-skill', del(adminTok))).status).toBe(200);
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(false);
    // Support files remain, so the folder is kept.
    expect(existsSync(join(skillDir, 'references', 'notes.md'))).toBe(true);
  });

  it('DELETE removes an empty directory-form skill folder entirely', async () => {
    const { app, userDir, adminTok } = setup();
    const skillDir = join(userDir, 'bare-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: bare-skill\ndescription: Bare.\n---\n\nBody.\n');
    expect((await app.request('/plugins/skills/bare-skill', del(adminTok))).status).toBe(200);
    expect(existsSync(skillDir)).toBe(false);
  });

  it('PATCH rejects a bundled skill (400), a missing skill (404) and empty content (400)', async () => {
    const { app, adminTok } = setup();
    await app.request('/plugins/skills', post(adminTok, skill()));
    expect((await app.request(`/plugins/skills/${BUNDLED}`, patch(adminTok, { content: 'x' }))).status).toBe(400);
    expect((await app.request('/plugins/skills/nope', patch(adminTok, { content: 'x' }))).status).toBe(404);
    expect((await app.request('/plugins/skills/deploy-checklist', patch(adminTok, { content: '  ' }))).status).toBe(400);
  });

  it('DELETE removes a user skill; bundled → 400, missing → 404, bad name → 400', async () => {
    const { app, userDir, adminTok } = setup();
    await app.request('/plugins/skills', post(adminTok, skill()));
    expect((await app.request(`/plugins/skills/${BUNDLED}`, del(adminTok))).status).toBe(400);
    expect((await app.request('/plugins/skills/nope', del(adminTok))).status).toBe(404);
    expect((await app.request('/plugins/skills/Bad%20Name', del(adminTok))).status).toBe(400);
    const res = await app.request('/plugins/skills/deploy-checklist', del(adminTok));
    expect(res.status).toBe(200);
    expect(existsSync(join(userDir, 'deploy-checklist.md'))).toBe(false);
  });

  it('rejects a non-admin (403) on list, create and delete', async () => {
    const { app, amyTok } = setup();
    expect((await app.request('/plugins/skills/list', auth(amyTok))).status).toBe(403);
    expect((await app.request('/plugins/skills', post(amyTok, skill()))).status).toBe(403);
    expect((await app.request('/plugins/skills/x', patch(amyTok, { content: 'y' }))).status).toBe(403);
    expect((await app.request('/plugins/skills/x', del(amyTok))).status).toBe(403);
  });

  it('keeps a --- line in the body as body, not a second frontmatter delimiter', async () => {
    const { app, userDir, adminTok } = setup();
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'rules.md'), '---\nname: rules\ndescription: R.\n---\nPart one.\n\n---\n\nPart two.\n');
    const list = (await (await app.request('/plugins/skills/list', auth(adminTok))).json()) as { name: string; description: string; content?: string }[];
    expect(list.find((s) => s.name === 'rules'))
      .toMatchObject({ description: 'R.', content: 'Part one.\n\n---\n\nPart two.' });
  });

  it('answers 503 "skills plugin is disabled" when the plugin is off', async () => {
    const { app, adminTok } = setup({ enabled: [] });
    const res = await app.request('/plugins/skills/list', auth(adminTok));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'skills plugin is disabled' });
    expect((await app.request('/plugins/skills', post(adminTok, skill()))).status).toBe(503);
  });

  it('parses a BOM-prefixed user skill and keeps its frontmatter through an edit', async () => {
    const { app, userDir, adminTok } = setup();
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'bom-skill.md'), '\uFEFF---\nname: bom-skill\ndescription: B.\nlicense: MIT\n---\nBody.\n');
    const list = (await (await app.request('/plugins/skills/list', auth(adminTok))).json()) as { name: string; description: string; content?: string }[];
    expect(list.find((s) => s.name === 'bom-skill')).toMatchObject({ description: 'B.', content: 'Body.' });
    // PATCH keeps the unknown license field — the frontmatter was actually parsed, not treated as body.
    expect((await app.request('/plugins/skills/bom-skill', patch(adminTok, { content: 'v2' }))).status).toBe(200);
    expect(readFileSync(join(userDir, 'bom-skill.md'), 'utf-8')).toContain('license: MIT\n');
  });
});
