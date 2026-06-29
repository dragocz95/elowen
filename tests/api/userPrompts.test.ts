import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { UserPromptStore } from '../../src/store/userPromptStore.js';
import { rawTemplate } from '../../src/prompts/index.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const bob = users.create('bob', 'pw');
  const userPrompts = new UserPromptStore(db);
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: new FakeTmuxDriver(),
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db), userPrompts,
  });
  return { app, userPrompts, adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id), bobId: bob.id };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const put = (t: string, body: unknown) => ({ method: 'PUT', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const del = (t: string) => ({ method: 'DELETE', headers: { authorization: `Bearer ${t}` } });

describe('GET /auth/me/prompts', () => {
  it('returns every editable template with its default and null override', async () => {
    const { app, adminTok } = setup();
    const res = await app.request('/auth/me/prompts', auth(adminTok));
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; default: string; override: string | null; jsonContract: boolean }[];
    const worker = body.find((p) => p.name === 'worker')!;
    expect(worker.default).toBe(rawTemplate('worker'));
    expect(worker.override).toBeNull();
    // The JSON-contract flag is surfaced (e.g. decision-question is parsed as JSON).
    expect(body.find((p) => p.name === 'decision-question')!.jsonContract).toBe(true);
  });

  it('reflects a saved override', async () => {
    const { app, adminTok, userPrompts } = setup();
    userPrompts.set((await (await app.request('/auth/me', auth(adminTok))).json()).user.id, 'worker', 'MINE');
    const body = await (await app.request('/auth/me/prompts', auth(adminTok))).json() as { name: string; override: string | null }[];
    expect(body.find((p) => p.name === 'worker')!.override).toBe('MINE');
  });
});

describe('PUT /auth/me/prompts/:name', () => {
  it('saves an override for the calling user only', async () => {
    const { app, bobTok, bobId, userPrompts } = setup();
    const res = await app.request('/auth/me/prompts/worker', put(bobTok, { content: 'bob worker' }));
    expect(res.status).toBe(200);
    expect(userPrompts.get(bobId, 'worker')).toBe('bob worker');
  });

  it('rejects an unknown / non-editable template name with 400', async () => {
    const { app, adminTok } = setup();
    expect((await app.request('/auth/me/prompts/planner-fallback', put(adminTok, { content: 'x' }))).status).toBe(400);
    expect((await app.request('/auth/me/prompts/nope', put(adminTok, { content: 'x' }))).status).toBe(400);
  });

  it('rejects an empty prompt with 400', async () => {
    const { app, adminTok } = setup();
    expect((await app.request('/auth/me/prompts/worker', put(adminTok, { content: '   ' }))).status).toBe(400);
  });
});

describe('DELETE /auth/me/prompts/:name', () => {
  it('resets an override back to the default', async () => {
    const { app, bobTok, bobId, userPrompts } = setup();
    userPrompts.set(bobId, 'worker', 'temp');
    const res = await app.request('/auth/me/prompts/worker', del(bobTok));
    expect(res.status).toBe(200);
    expect(userPrompts.get(bobId, 'worker')).toBeNull();
  });
});

describe('prompt overrides are per-user', () => {
  it("one user's override never leaks into another's view", async () => {
    const { app, adminTok, bobTok } = setup();
    await app.request('/auth/me/prompts/worker', put(bobTok, { content: 'BOB ONLY' }));
    const adminBody = await (await app.request('/auth/me/prompts', auth(adminTok))).json() as { name: string; override: string | null }[];
    expect(adminBody.find((p) => p.name === 'worker')!.override).toBeNull();
  });
});
