import { describe, it, expect, vi } from 'vitest';
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
import { UserSettingStore } from '../../src/store/userSettingStore.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const users = new UserStore(db);
  const amy = users.create('amy', 'pw');
  const config = new ConfigStore(db);
  const userSettings = new UserSettingStore(db);
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    userSettings,
    brain: { restart: vi.fn(async () => {}) } as never,
  });
  return { app, users, userSettings, amy, amyTok: users.issueToken(amy.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('GET/PATCH /auth/me/permissions', () => {
  it('GET returns empty rules + YOLO off by default', async () => {
    const { app, amyTok } = setup();
    const res = await app.request('/auth/me/permissions', auth(amyTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tools: {}, bash: {}, yolo: false });
  });

  it('PATCH round-trips rules + the persisted YOLO default, sanitizing junk', async () => {
    const { app, amyTok } = setup();
    const res = await app.request('/auth/me/permissions', patch(amyTok, {
      tools: { write_file: 'allow', junk: 'explode' },
      bash: { '*': 'ask', 'git *': 'allow' },
      yolo: true,
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tools: { write_file: 'allow' }, bash: { '*': 'ask', 'git *': 'allow' }, yolo: true });
    // A yolo-only patch keeps the stored rules (the web toggle sends just { yolo }).
    const res2 = await app.request('/auth/me/permissions', patch(amyTok, { yolo: false }));
    expect(await res2.json()).toEqual({ tools: { write_file: 'allow' }, bash: { '*': 'ask', 'git *': 'allow' }, yolo: false });
  });

  it('is per-user: one user PATCHing never leaks into another', async () => {
    const { app, users, amyTok } = setup();
    const bob = users.create('bob', 'pw');
    const bobTok = users.issueToken(bob.id);
    await app.request('/auth/me/permissions', patch(amyTok, { yolo: true }));
    expect((await app.request('/auth/me/permissions', auth(bobTok)).then((r) => r.json())).yolo).toBe(false);
  });

  it('rejects an unauthenticated caller', async () => {
    const { app } = setup();
    const res = await app.request('/auth/me/permissions');
    expect(res.status).toBe(401);
  });
});
