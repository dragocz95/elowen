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
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // first → admin
  const amy = users.create('amy', 'pw');
  const bob = users.create('bob', 'pw');
  const tmux = new FakeTmuxDriver();
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: tmux as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
  });
  return {
    app, tmux,
    adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id), bobTok: users.issueToken(bob.id),
    amyId: amy.id,
  };
}
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('advisor session input access', () => {
  it('owner can send raw input; other user is forbidden; admin allowed', async () => {
    const { app, tmux, amyTok, bobTok, adminTok, amyId } = setup();
    const name = `orca-advisor-${amyId}`;
    expect((await app.request(`/sessions/${name}/input`, post(amyTok, { data: 'hi' }))).status).toBe(200);
    expect((await app.request(`/sessions/${name}/input`, post(bobTok, { data: 'x' }))).status).toBe(403);
    expect((await app.request(`/sessions/${name}/input`, post(adminTok, { data: 'y' }))).status).toBe(200);
    expect(tmux.sentRaw(name)).toEqual(['hi', 'y']); // bob's forbidden call never reached the driver
  });

  it('rejects an empty/missing data field with 400', async () => {
    const { app, amyTok, amyId } = setup();
    const name = `orca-advisor-${amyId}`;
    expect((await app.request(`/sessions/${name}/input`, post(amyTok, {}))).status).toBe(400);
    expect((await app.request(`/sessions/${name}/input`, post(amyTok, { data: '' }))).status).toBe(400);
  });
});
