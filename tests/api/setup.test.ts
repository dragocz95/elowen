import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { RefMissions, RefReadiness, RefTaskStore } from '../helpers/refStores.js';

// A fresh daemon with no users yet: the API is open (setup mode) so onboarding can run before login.
function makeApp() {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const app = createServer({
    tasks: new RefTaskStore(db), readiness: new RefReadiness(db), missions: new RefMissions(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
  });
  return { app, users };
}
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('setup mode (no users)', () => {
  it('GET /setup reports needsSetup until the first user exists', async () => {
    const { app, users } = makeApp();
    expect((await (await app.request('/setup')).json()).needsSetup).toBe(true);
    users.create('admin', 'pw');
    expect((await (await app.request('/setup')).json()).needsSetup).toBe(false);
  });

  it('creates the first admin and saves config without a token, then locks down', async () => {
    const { app } = makeApp();
    // Onboarding can save config in setup mode (no token).
    expect((await app.request('/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allowedExecs: ['sonnet'] }) })).status).toBe(200);
    // Create the first user (becomes the bootstrap admin) with no token.
    const res = await app.request('/users', json({ username: 'admin', password: 'adminpass' })); // ≥8 chars: the bootstrap admin obeys the password policy too
    expect(res.status).toBe(201);
    expect((await res.json()).is_admin).toBe(true);
    // Auth now re-engages: a protected route without a token is rejected.
    expect((await app.request('/setup')).status).toBe(200);          // public, still reachable
    expect((await app.request('/tasks')).status).toBe(401);          // protected, now enforced
    expect((await app.request('/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allowedExecs: [] }) })).status).toBe(401);
  });
});
