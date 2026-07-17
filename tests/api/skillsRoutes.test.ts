import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`;

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'elowen-skills-data-'));
  // A plugin scan root shaped like the real one: <root>/skills is the plugin folder, its bundled
  // .md skills live one level deeper in <root>/skills/skills.
  const pluginsRoot = mkdtempSync(join(tmpdir(), 'elowen-skills-plugins-'));
  const bundledDir = join(pluginsRoot, 'skills', 'skills');
  mkdirSync(bundledDir, { recursive: true });
  writeFileSync(join(bundledDir, 'greeting.md'), skillMd('greeting', 'How to greet.'));
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const amy = users.create('amy', 'pw');
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    pluginDirs: [pluginsRoot], pluginDataRoot: dataRoot,
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
    expect(await res.json()).toEqual([
      expect.objectContaining({ name: 'greeting', description: 'How to greet.', source: 'bundled', scope: 'bundled/system', active: true, canDelete: false }),
      expect.objectContaining({ name: 'my-skill', description: 'A user skill.', source: 'user', scope: 'user-defined', active: true, canDelete: true }),
    ]);
  });

  it('GET lists bundled skills even when the user dir does not exist yet', async () => {
    const { app, adminTok } = setup();
    const res = await app.request('/plugins/skills/list', auth(adminTok));
    expect(await res.json()).toEqual([expect.objectContaining({ name: 'greeting', description: 'How to greet.', source: 'bundled', canDelete: false })]);
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
    expect((await app.request('/plugins/skills', post(adminTok, skill({ name: 'greeting' })))).status).toBe(400);
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
    // Edit body + description, and clear the flag.
    expect((await app.request('/plugins/skills/deploy-checklist', patch(adminTok, { description: 'Updated.', content: 'New body.', disableModelInvocation: false }))).status).toBe(200);
    expect(readFileSync(join(userDir, 'deploy-checklist.md'), 'utf-8'))
      .toBe('---\nname: deploy-checklist\ndescription: Updated.\n---\n\nNew body.\n');
  });

  it('PATCH rejects a bundled skill (400), a missing skill (404) and empty content (400)', async () => {
    const { app, adminTok } = setup();
    await app.request('/plugins/skills', post(adminTok, skill()));
    expect((await app.request('/plugins/skills/greeting', patch(adminTok, { content: 'x' }))).status).toBe(400);
    expect((await app.request('/plugins/skills/nope', patch(adminTok, { content: 'x' }))).status).toBe(404);
    expect((await app.request('/plugins/skills/deploy-checklist', patch(adminTok, { content: '  ' }))).status).toBe(400);
  });

  it('DELETE removes a user skill; bundled → 400, missing → 404, bad name → 400', async () => {
    const { app, userDir, adminTok } = setup();
    await app.request('/plugins/skills', post(adminTok, skill()));
    expect((await app.request('/plugins/skills/greeting', del(adminTok))).status).toBe(400);
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
});
