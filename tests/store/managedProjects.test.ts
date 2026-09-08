import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';

const databases: Db[] = [];
function fixture() {
  const db = openDb(':memory:'); databases.push(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'test-password');
  const member = users.create('member', 'test-password');
  const peer = users.create('peer', 'test-password');
  return { db, users, admin, member, peer, projects: new ProjectStore(db), memberships: new UserProjectStore(db) };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('managed project foundation', () => {
  it('preserves host records and creates managed records without host paths', () => {
    const { projects, member } = fixture();
    expect(projects.create({ slug: 'legacy', path: '/legacy' })).toMatchObject({ executionKind: 'host', lifecycle: 'active' });
    const p = projects.createManaged({ slug: 'managed', creatorUserId: member.id });
    expect(p).toMatchObject({ executionKind: 'managed', path: '', creatorUserId: member.id, lifecycle: 'active' });
    expect(() => projects.update(p.id, { path: '/etc' })).toThrow(/managed/);
  });
  it('provisions one private default project idempotently, not a runtime', () => {
    const { projects, member, users, memberships } = fixture();
    const first = projects.ensureDefault(member.id);
    expect(projects.ensureDefault(member.id).id).toBe(first.id);
    expect(users.get(member.id)?.default_project_id).toBe(first.id);
    expect(memberships.forProject(first.id)).toEqual([member.id]);
    expect(first.executionKind).toBe('managed');
  });
  it('checks the inviting member grant rather than the creator grant', () => {
    const { projects, member, peer, admin, users, memberships } = fixture();
    const project = projects.ensureDefault(member.id);
    users.setProjectPermissions(admin.id, member.id, { canShareProjects: true });
    memberships.addMember(member.id, peer.id, project.id);
    expect(() => memberships.addMember(peer.id, admin.id, project.id)).toThrow(/sharing/);
    memberships.removeMember(peer.id, member.id, project.id);
    expect(memberships.canAccess(member.id, project.id)).toBe(false);
    expect(memberships.canAccess(peer.id, project.id)).toBe(true);
  });
  it('does not allow a member to grant its own creation/sharing permissions', () => {
    const { users, member } = fixture();
    expect(() => users.setProjectPermissions(member.id, member.id, { canCreateProjects: true })).toThrow(/administrator/);
    expect(users.get(member.id)).toMatchObject({ can_create_projects: false, can_share_projects: false });
  });
  it('retains a deleting project and denies access until cleanup is acknowledged', () => {
    const { projects, member, memberships } = fixture();
    const p = projects.ensureDefault(member.id);
    projects.beginDeletion(p.id);
    expect(projects.get(p.id)?.lifecycle).toBe('deleting');
    expect(memberships.canAccess(member.id, p.id)).toBe(false);
    expect(memberships.canManage(member.id, p.id)).toBe(true);
    expect(() => projects.remove(p.id)).toThrow(/cleanup/);
    expect(projects.finishDeletion(p.id)).toBe(true);
    expect(projects.get(p.id)).toBeNull();
  });
});
