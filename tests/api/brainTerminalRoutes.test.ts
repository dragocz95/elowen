import { describe, it, expect } from 'vitest';
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
import { BrainStore } from '../../src/store/brainStore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { BrainTerminalService } from '../../src/brain/terminalService.js';
import { classifySession } from '../../src/overseer/sessionInfo.js';
import { freshUserSessionId, brainTerminalName } from '../../src/brain/sessionId.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // id 1, is_admin
  const admin2 = users.create('admin2', 'pw'); // id 2
  users.setAdmin(admin2.id, true);            // a SECOND admin (foreign to admin's session)
  const bob = users.create('bob', 'pw');       // id 3, ordinary full-scope non-admin
  const userProjects = new UserProjectStore(db);
  userProjects.assign(bob.id, 1);
  const brainStore = new BrainStore(db);
  // An admin-owned continuable conversation.
  const sessionId = freshUserSessionId(admin.id);
  brainStore.createSession({ id: sessionId, userId: admin.id, model: 'm' });
  const tmux = new FakeTmuxDriver();
  const brainTerminal = new BrainTerminalService({
    tmux, users, store: brainStore, url: 'http://localhost:4400', cliArgv: ['elowen'],
    terminalDir: (id) => `/tmp/terminal/${id}`,
  });
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: tmux as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects,
    brain: {} as never, brainTerminal, brainStore,
  });
  return {
    app, brainTerminal, tmux, users, brainStore, sessionId,
    adminTok: users.issueToken(admin.id),
    admin2Tok: users.issueToken(admin2.id),
    bobTok: users.issueToken(bob.id),
    agentTok: users.issueToken(admin.id, 'agent'),
    adminId: admin.id, admin2Id: admin2.id,
  };
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (app: ReturnType<typeof setup>['app'], tok: string, body: unknown) =>
  app.request('/brain/terminal', { method: 'POST', headers: { ...auth(tok), 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /brain/terminal RBAC + idempotence', () => {
  it('rejects an ordinary full-scope non-admin (403)', async () => {
    const { app, bobTok, sessionId } = setup();
    expect((await post(app, bobTok, { session: sessionId })).status).toBe(403);
  });

  it('rejects an agent-scoped token (403)', async () => {
    const { app, agentTok, sessionId } = setup();
    expect((await post(app, agentTok, { session: sessionId })).status).toBe(403);
  });

  it('rejects a foreign admin with 404 (ownership miss)', async () => {
    const { app, admin2Tok, sessionId } = setup();
    const res = await post(app, admin2Tok, { session: sessionId });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('unknown session');
  });

  it('404s a missing session and 400s a malformed body', async () => {
    const { app, adminTok } = setup();
    expect((await post(app, adminTok, { session: 'brain-9999' })).status).toBe(404);
    expect((await post(app, adminTok, {})).status).toBe(400);
    expect((await post(app, adminTok, { session: 5 })).status).toBe(400);
  });

  it('opens for the owner admin (201 created:true), repeat is created:false, and never leaks the token', async () => {
    const { app, adminTok, sessionId, adminId } = setup();
    const first = await post(app, adminTok, { session: sessionId });
    expect(first.status).toBe(201);
    const body = await first.json();
    expect(body).toEqual({ terminal: brainTerminalName(adminId, sessionId), created: true });
    // Invariant 5: the response carries ONLY { terminal, created } — no token field of any name.
    expect(Object.keys(body).sort()).toEqual(['created', 'terminal']);
    expect(JSON.stringify(body)).not.toContain('ELOWEN_TOKEN');
    const second = await post(app, adminTok, { session: sessionId });
    expect(second.status).toBe(201);
    expect((await second.json()).created).toBe(false);
  });

  it('a tmux launch failure returns a sanitized 409 whose body never carries the token (invariant 5)', async () => {
    const { app, adminTok, tmux, brainStore, sessionId } = setup();
    tmux.failArgvSpawn = true; // the real driver failure would echo `-e ELOWEN_TOKEN=<token>`
    const res = await post(app, adminTok, { session: sessionId });
    expect(res.status).toBe(409);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({ error: 'terminal launch failed' }); // constant message, no argv/token
    expect(raw).not.toContain('ELOWEN_TOKEN');
    expect(raw).not.toContain('tmux');
    // The binding minted for the failed launch was dropped — nothing usable lingers (token revoke is
    // asserted precisely in the BrainTerminalService unit test).
    expect(brainStore.listBrainTerminals()).toHaveLength(0);
  });
});

describe('derived running state via GET /sessions', () => {
  const names = async (app: ReturnType<typeof setup>['app'], tok: string) =>
    ((await (await app.request('/sessions', { headers: auth(tok) })).json()) as { name: string }[]).map((s) => s.name);

  it('shows the chat terminal to its owner admin and hides it from a foreign admin / non-admin', async () => {
    const { app, adminTok, admin2Tok, bobTok, sessionId, adminId } = setup();
    await post(app, adminTok, { session: sessionId });
    const terminal = brainTerminalName(adminId, sessionId);
    expect(await names(app, adminTok)).toContain(terminal);
    expect(await names(app, admin2Tok)).not.toContain(terminal); // invariant 4: no admin bypass on chat
    expect(await names(app, bobTok)).not.toContain(terminal);
  });
});

describe('DELETE /sessions/:name tears the chat terminal down', () => {
  const del = (app: ReturnType<typeof setup>['app'], tok: string, name: string) =>
    app.request(`/sessions/${name}`, { method: 'DELETE', headers: auth(tok) });

  it('refuses a non-owner (403) and, for the owner, revokes the token + drops the binding', async () => {
    const { app, adminTok, admin2Tok, tmux, users, brainStore, sessionId, adminId } = setup();
    await post(app, adminTok, { session: sessionId });
    const terminal = brainTerminalName(adminId, sessionId);
    const token = tmux.argvSpawnFor(terminal)!.env.ELOWEN_TOKEN;

    expect((await del(app, admin2Tok, terminal)).status).toBe(403); // foreign admin refused
    expect(brainStore.getBrainTerminal(terminal)).toBeDefined();     // still intact

    expect((await del(app, adminTok, terminal)).status).toBe(200);   // owner tears it down
    expect(await tmux.list()).not.toContain(terminal);
    expect(users.userForToken(token)).toBeNull();
    expect(brainStore.getBrainTerminal(terminal)).toBeUndefined();
  });
});

describe('classifySession chat role', () => {
  it('extracts the owner userId', () => {
    expect(classifySession('elowen-chat-7-abc')).toMatchObject({ role: 'chat', userId: 7 });
    expect(classifySession('elowen-chat-7-default')).toMatchObject({ role: 'chat', userId: 7 });
  });
  it('leaves userId undefined for a malformed name', () => {
    expect(classifySession('elowen-chat-x-abc')).toMatchObject({ role: 'chat', userId: undefined });
  });
});
