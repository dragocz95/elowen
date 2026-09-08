import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { EventBus } from '../../src/api/sse.js';
import { FakeClock } from '../../src/shared/clock.js';
import { createServer } from '../../src/api/server.js';

const databases: Db[] = [];
const request = (token: string, method = 'GET', body?: unknown) => ({ method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
function setup() {
  const db = openDb(':memory:'); databases.push(db);
  const users = new UserStore(db); const projects = new ProjectStore(db); const userProjects = new UserProjectStore(db);
  const home = projects.create({ slug: 'host', path: '/host' });
  const admin = users.create('admin', 'test-password'); const member = users.create('member', 'test-password'); const peer = users.create('peer', 'test-password');
  const token = users.issueToken(member.id); const peerToken = users.issueToken(peer.id);
  const app = createServer({ bus: new EventBus(), engine: null as never, spawn: null as never, tmux: null as never, project: home, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db), users, projects, userProjects });
  return { users, projects, userProjects, admin, member, peer, token, peerToken, app };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('managed project API', () => {
  it('requires creation permission and never accepts a managed host path', async () => {
    const { app, users, admin, member, token } = setup();
    expect((await app.request('/projects', request(token, 'POST', { slug: 'denied', executionKind: 'managed' }))).status).toBe(403);
    users.setProjectPermissions(admin.id, member.id, { canCreateProjects: true });
    const response = await app.request('/projects', request(token, 'POST', { slug: 'work', executionKind: 'managed' }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ executionKind: 'managed', path: '', creatorUserId: member.id });
    expect((await app.request('/projects', request(token, 'POST', { slug: 'escape', executionKind: 'managed', path: '/etc' }))).status).toBe(400);
  });
  it('lets equal members manage a project while invitations check their own grant', async () => {
    const { app, users, projects, userProjects, admin, member, peer, token, peerToken } = setup();
    const p = projects.ensureDefault(member.id);
    users.setProjectPermissions(admin.id, member.id, { canShareProjects: true });
    expect((await app.request(`/users/${peer.id}/projects`, request(token, 'POST', { projectId: p.id }))).status).toBe(200);
    expect(userProjects.canAccess(peer.id, p.id)).toBe(true);
    expect((await app.request(`/projects/${p.id}`, request(peerToken, 'PATCH', { notes: 'peer edit' }))).status).toBe(200);
    expect((await app.request(`/users/${admin.id}/projects`, request(peerToken, 'POST', { projectId: p.id }))).status).toBe(403);
    expect((await app.request(`/projects/${p.id}`, request(peerToken, 'PATCH', { path: '/etc' }))).status).toBe(400);
  });
  it('does not delete managed metadata when its cleanup provider is unavailable', async () => {
    const { app, projects, member, token } = setup(); const p = projects.ensureDefault(member.id);
    expect((await app.request(`/projects/${p.id}`, request(token, 'DELETE'))).status).toBe(503);
    expect(projects.get(p.id)?.lifecycle).toBe('active');
  });
});
