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
function setup(sandbox?: Record<string, (input: never) => unknown>) {
  const db = openDb(':memory:'); databases.push(db);
  const users = new UserStore(db); const projects = new ProjectStore(db); const userProjects = new UserProjectStore(db);
  const home = projects.create({ slug: 'host', path: '/host' });
  const admin = users.create('admin', 'test-password'); const member = users.create('member', 'test-password'); const peer = users.create('peer', 'test-password');
  const token = users.issueToken(member.id); const peerToken = users.issueToken(peer.id);
  const plugins = sandbox ? { get: async () => ({ control: (name: string) => name === 'sandbox' ? sandbox : undefined }) } as never : undefined;
  const app = createServer({ bus: new EventBus(), engine: null as never, spawn: null as never, tmux: null as never, project: home, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db), users, projects, userProjects, plugins });
  return { users, projects, userProjects, admin, member, peer, home, token, peerToken, adminToken: users.issueToken(admin.id), app };
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
  /** A teardown already under way, a stale generation, a deleting environment: the provider signals all of
   *  them with a code and a 4xx status, and the second click during a teardown is exactly that case
   *  (no client sends the requestId the documented retry needs). `internal error` told the caller nothing
   *  and read as a server fault. */
  it('answers a provider refusal on delete with its code rather than a 500', async () => {
    const refusal = Object.assign(new Error('An environment lifecycle operation is already pending'), { code: 'environment_busy', status: 409 });
    const sandbox = { requestEnvironment: () => { throw refusal; } };
    const { app, projects, member, token } = setup(sandbox); const p = projects.ensureDefault(member.id);
    const response = await app.request(`/projects/${p.id}`, request(token, 'DELETE'));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'An environment lifecycle operation is already pending', code: 'environment_busy' });
    expect(projects.get(p.id)?.lifecycle).toBe('active');
  });
  it('keeps a genuine provider failure a 500', async () => {
    const sandbox = { requestEnvironment: () => { throw new Error('podman socket closed'); } };
    const { app, projects, member, token } = setup(sandbox); const p = projects.ensureDefault(member.id);
    expect((await app.request(`/projects/${p.id}`, request(token, 'DELETE'))).status).toBe(500);
  });
  /** The same store limit two routes above is a clean 409, so the default route answering 500 was the
   *  outlier. Reachable once an administrator lowers the limit below the current managed count. */
  it('answers the project limit with a 409 on the default route', async () => {
    const { app, users, projects, admin, member, token } = setup();
    users.setProjectPermissions(admin.id, member.id, { projectLimit: 1 });
    projects.beginDeletion(projects.ensureDefault(member.id).id);
    const response = await app.request('/projects/default', request(token, 'POST'));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'project creation limit reached' });
  });
  /** Authorization before validation, as /fs/dirs does it: an account that may create nothing must not be
   *  able to probe the body schema. */
  it('refuses a caller without the creation grant before it validates the body', async () => {
    const { app, token } = setup();
    const response = await app.request('/projects', request(token, 'POST', { slug: '', executionKind: 'nonsense' }));
    expect(response.status).toBe(403);
  });
  /** Adopting is not metadata editing: it hands the project's directory to the sandbox and moves its
   *  execution off this host, so it is its own admin-only door, and the daemon's own checkout is refused
   *  before anything else is considered. */
  it('adopts a host project as managed, admin-only, and refuses what cannot be adopted', async () => {
    const { app, projects, home, member, token, adminToken } = setup();
    const host = projects.create({ slug: 'kolin', path: '/var/www/kolin' });
    expect((await app.request(`/projects/${host.id}/adopt`, request(token, 'POST'))).status).toBe(403);
    expect((await app.request(`/projects/${home.id}/adopt`, request(adminToken, 'POST'))).status).toBe(400);
    expect((await app.request('/projects/9999/adopt', request(adminToken, 'POST'))).status).toBe(404);
    const adopted = await app.request(`/projects/${host.id}/adopt`, request(adminToken, 'POST'));
    expect(adopted.status).toBe(200);
    expect(await adopted.json()).toMatchObject({ executionKind: 'managed', path: '', adoptedPath: '/var/www/kolin', guestRoot: '/kolin' });
    // Adopting twice, and a slug that could never be mounted, are both refusals of the project itself.
    expect((await app.request(`/projects/${host.id}/adopt`, request(adminToken, 'POST'))).status).toBe(409);
    expect((await app.request(`/projects/${projects.ensureDefault(member.id).id}/adopt`, request(adminToken, 'POST'))).status).toBe(409);
    expect((await app.request(`/projects/${projects.create({ slug: 'workspace', path: '/data/ws' }).id}/adopt`, request(adminToken, 'POST'))).status).toBe(400);
    expect((await app.request(`/projects/${projects.create({ slug: 'shop', path: '/var/www/shop' }).id}/adopt`, request(adminToken, 'POST', { undo: 'yes' }))).status).toBe(400);
  });

  /** The rollback is refused once the sandbox has taken the directory, because reversing the row then
   *  would hand the project back pointing at a path that no longer holds anything. Before that the
   *  environment is unprovisioned and the way back is open. */
  it('releases an adoption only while the environment has not taken the directory', async () => {
    // No provider loaded at all: without one the environment cannot be asked, so the rollback is refused.
    const bare = setup();
    const bareHost = bare.projects.create({ slug: 'kolin', path: '/var/www/kolin' });
    await bare.app.request(`/projects/${bareHost.id}/adopt`, request(bare.adminToken, 'POST'));
    expect((await bare.app.request(`/projects/${bareHost.id}/adopt`, request(bare.adminToken, 'POST', { undo: true }))).status).toBe(503);
    expect(bare.projects.get(bareHost.id)?.executionKind).toBe('managed');

    const seen: Record<string, unknown>[] = [];
    const state = { value: 'unprovisioned' };
    const sandbox = { environmentFor: (input: Record<string, unknown>) => { seen.push(input); return { state: state.value }; } };
    const { app, projects, admin, adminToken } = setup(sandbox);
    const target = projects.create({ slug: 'kolin', path: '/var/www/kolin' });
    await app.request(`/projects/${target.id}/adopt`, request(adminToken, 'POST'));
    state.value = 'running';
    expect((await app.request(`/projects/${target.id}/adopt`, request(adminToken, 'POST', { undo: true }))).status).toBe(409);
    expect(projects.get(target.id)?.executionKind).toBe('managed');
    // Asked before the row is touched, as the acting account, about the project being released.
    expect(seen).toEqual([{ project: { kind: 'managed', projectId: target.id }, accountUserId: admin.id }]);
    state.value = 'unprovisioned';
    const released = await app.request(`/projects/${target.id}/adopt`, request(adminToken, 'POST', { undo: true }));
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({ executionKind: 'host', path: '/var/www/kolin' });
    expect(seen).toHaveLength(2);
    // And once released it is an ordinary host project again, so a second undo is refused rather than
    // silently blanking a path the store never recorded.
    expect((await app.request(`/projects/${target.id}/adopt`, request(adminToken, 'POST', { undo: true }))).status).toBe(409);
    expect(projects.get(target.id)?.path).toBe('/var/www/kolin');
  });

  /** The membership row is BOTH the permission the account is judged by and the handle a retry needs, so
   *  the runtime teardown runs before it goes away: deleting it first left a failed revocation with the
   *  guest still able to reach the environment and nothing left to revoke it against. The refusal names the
   *  half that did NOT happen. */
  it('keeps the membership when the runtime cannot drop the guest access', async () => {
    const sandbox = { requestEnvironment: () => ({ id: 'op', status: 'pending' }), revokeProjectAccess: () => { throw new Error('provider unreachable'); } };
    const { app, users, projects, userProjects, admin, member, peer, token } = setup(sandbox);
    const p = projects.ensureDefault(member.id);
    users.setProjectPermissions(admin.id, member.id, { canShareProjects: true });
    expect((await app.request(`/users/${peer.id}/projects`, request(token, 'POST', { projectId: p.id }))).status).toBe(200);
    const response = await app.request(`/users/${peer.id}/projects/${p.id}`, request(token, 'DELETE'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'runtime cleanup failed; membership kept' });
    expect(userProjects.canAccess(peer.id, p.id)).toBe(true);
  });
  it('keeps the membership when no runtime provider is loaded', async () => {
    const { app, users, projects, userProjects, admin, member, peer, token } = setup();
    const p = projects.ensureDefault(member.id);
    users.setProjectPermissions(admin.id, member.id, { canShareProjects: true });
    expect((await app.request(`/users/${peer.id}/projects`, request(token, 'POST', { projectId: p.id }))).status).toBe(200);
    const response = await app.request(`/users/${peer.id}/projects/${p.id}`, request(token, 'DELETE'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'runtime cleanup unavailable; membership kept' });
    expect(userProjects.canAccess(peer.id, p.id)).toBe(true);
  });
  /** The teardown acts on another account's running environment, and a core route reaches a plugin control
   *  without an identity scope — so the provider cannot be the gate that stops a non-member reaching it. */
  it('refuses a non-member before the runtime teardown is asked', async () => {
    let asked = 0;
    const sandbox = { requestEnvironment: () => ({ id: 'op', status: 'pending' }), revokeProjectAccess: () => { asked += 1; } };
    const { app, projects, userProjects, member, peerToken } = setup(sandbox);
    const p = projects.ensureDefault(member.id);
    const response = await app.request(`/users/${member.id}/projects/${p.id}`, request(peerToken, 'DELETE'));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'project access denied' });
    expect(asked).toBe(0);
    expect(userProjects.canAccess(member.id, p.id)).toBe(true);
  });
  it('removes the membership once the runtime has dropped the guest access', async () => {
    const revoked: number[] = [];
    const sandbox = { requestEnvironment: () => ({ id: 'op', status: 'pending' }), revokeProjectAccess: (input: { accountUserId: number }) => { revoked.push(input.accountUserId); } };
    const { app, users, projects, userProjects, admin, member, peer, token } = setup(sandbox);
    const p = projects.ensureDefault(member.id);
    users.setProjectPermissions(admin.id, member.id, { canShareProjects: true });
    expect((await app.request(`/users/${peer.id}/projects`, request(token, 'POST', { projectId: p.id }))).status).toBe(200);
    expect((await app.request(`/users/${peer.id}/projects/${p.id}`, request(token, 'DELETE'))).status).toBe(200);
    expect(revoked).toEqual([peer.id]);
    expect(userProjects.canAccess(peer.id, p.id)).toBe(false);
  });
  it('rejects a malformed idempotency key instead of forwarding it', async () => {
    const sandbox = { requestEnvironment: () => { throw new Error('must not be reached'); } };
    const { app, projects, member, token } = setup(sandbox); const p = projects.ensureDefault(member.id);
    expect((await app.request(`/projects/${p.id}`, request(token, 'DELETE', { requestId: 'bad key!' }))).status).toBe(400);
    expect((await app.request(`/projects/${p.id}`, request(token, 'DELETE', { expectedGeneration: -1 }))).status).toBe(400);
  });
});
