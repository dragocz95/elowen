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
function setup(sandbox?: { requestEnvironment: (input: unknown) => unknown }) {
  const db = openDb(':memory:'); databases.push(db);
  const users = new UserStore(db); const projects = new ProjectStore(db); const userProjects = new UserProjectStore(db);
  const home = projects.create({ slug: 'host', path: '/host' });
  const admin = users.create('admin', 'test-password'); const member = users.create('member', 'test-password'); const peer = users.create('peer', 'test-password');
  const token = users.issueToken(member.id); const peerToken = users.issueToken(peer.id);
  const plugins = sandbox ? { get: async () => ({ control: (name: string) => name === 'sandbox' ? sandbox : undefined }) } as never : undefined;
  const app = createServer({ bus: new EventBus(), engine: null as never, spawn: null as never, tmux: null as never, project: home, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db), users, projects, userProjects, plugins });
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
    // A slug that would mount over a base-image directory is refused at creation: the project could be
    // created, could never start, and its slug cannot be patched afterwards.
    expect((await app.request('/projects', request(token, 'POST', { slug: 'etc', executionKind: 'managed' }))).status).toBe(400);
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
  it('forwards the caller idempotency key and generation to the single deletion owner', async () => {
    const seen: Record<string, unknown>[] = [];
    // The provider owns the deletion intent and records `beginDeletion` inside its own transaction; this
    // stub deliberately does not, so a lifecycle left at 'active' proves core stopped recording it too.
    const sandbox = { requestEnvironment: (input: Record<string, unknown>) => { seen.push(input); return { id: 'op-1', requestId: 'req-1', status: 'pending' }; } };
    const { app, projects, member, token } = setup(sandbox); const p = projects.ensureDefault(member.id);
    const response = await app.request(`/projects/${p.id}`, request(token, 'DELETE', { requestId: 'req-1', expectedGeneration: 4 }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ operation: { id: 'op-1', requestId: 'req-1', status: 'pending' } });
    expect(seen).toEqual([{ project: { kind: 'managed', projectId: p.id }, accountUserId: member.id, action: { kind: 'delete' }, requestId: 'req-1', expectedGeneration: 4 }]);
    expect(projects.get(p.id)?.lifecycle).toBe('active');
  });
  // A managed project IS its environment, so creating one starts it. The caller gets the operation that
  // start produced and follows it in the same progress window every other lifecycle action uses.
  it('starts the environment as part of creating a managed project', async () => {
    const seen: Record<string, unknown>[] = [];
    const sandbox = { requestEnvironment: (input: Record<string, unknown>) => { seen.push(input); return { id: 'op-start', requestId: 'project-create', status: 'pending' }; } };
    const { app, users, admin, member, token } = setup(sandbox);
    users.setProjectPermissions(admin.id, member.id, { canCreateProjects: true });
    const response = await app.request('/projects', request(token, 'POST', { slug: 'work', executionKind: 'managed' }));
    expect(response.status).toBe(201);
    const created = await response.json() as { id: number; environmentOperationId?: string };
    expect(created.environmentOperationId).toBe('op-start');
    expect(seen).toEqual([{ project: { kind: 'managed', projectId: created.id }, accountUserId: member.id,
      action: { kind: 'start' }, requestId: `project-create:${created.id}` }]);
  });
  // The project is already durable when the start is asked for: a provider that refuses costs the caller
  // the progress window, never the project.
  it('still creates the project when its environment start is refused', async () => {
    const sandbox = { requestEnvironment: () => { throw new Error('provider down'); } };
    const { app, users, projects, admin, member, token } = setup(sandbox);
    users.setProjectPermissions(admin.id, member.id, { canCreateProjects: true });
    const response = await app.request('/projects', request(token, 'POST', { slug: 'work', executionKind: 'managed' }));
    expect(response.status).toBe(201);
    expect(await response.json()).not.toHaveProperty('environmentOperationId');
    expect(projects.list().some((p) => p.slug === 'work')).toBe(true);
  });
  it('rejects a malformed idempotency key instead of forwarding it', async () => {
    const sandbox = { requestEnvironment: () => { throw new Error('must not be reached'); } };
    const { app, projects, member, token } = setup(sandbox); const p = projects.ensureDefault(member.id);
    expect((await app.request(`/projects/${p.id}`, request(token, 'DELETE', { requestId: 'bad key!' }))).status).toBe(400);
    expect((await app.request(`/projects/${p.id}`, request(token, 'DELETE', { expectedGeneration: -1 }))).status).toBe(400);
  });
});
