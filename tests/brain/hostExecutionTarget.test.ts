import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { effectiveTurnWorkDir } from '../../src/brain/service/workDir.js';
import { normalizeDelegatedExecutionScope } from '../../src/brain/delegatedScope.js';
import { openDb, type Db } from '../../src/store/db.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { resolvePolicy } from '../../src/plugins/policy.js';

const databases: Db[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const db = openDb(':memory:'); databases.push(db);
  const root = mkdtempSync(join(tmpdir(), 'host-target-')); roots.push(root);
  const projects = new ProjectStore(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'password');
  const member = users.create('member', 'password');
  users.setAdmin(admin.id, true);
  const userProjects = new UserProjectStore(db);
  const policy = (id: number) => resolvePolicy({ projects, userProjects }, id);
  return { db, root, projects, users, admin, member, userProjects, policy };
}

describe('host execution targets', () => {
  // A member assigned to a host project already reaches its files through allowedPaths(). Refusing to
  // SELECT it as the execution target was the contradiction that left pre-existing projects unusable.
  it('lets an assigned member run in a host project without administrator rights', () => {
    const h = setup();
    const project = h.projects.create({ slug: 'legacy', path: h.root });
    h.userProjects.assign(h.member.id, project.id);
    const effective = effectiveTurnWorkDir({
      policy: h.policy(h.member.id), accountUserId: h.member.id, sessionId: 'brain-member',
      projects: h.projects, projectRef: { kind: 'host', projectId: project.id }, baseWorkDir: h.root,
    });
    expect(effective.workDir).toBe(h.root);
    expect(effective.projectRef).toEqual({ kind: 'host', projectId: project.id });
  });

  it('still refuses the nameless host target to a member', () => {
    const h = setup();
    expect(() => effectiveTurnWorkDir({
      policy: h.policy(h.member.id), accountUserId: h.member.id, sessionId: 'brain-member',
      projects: h.projects, projectRef: { kind: 'host' }, baseWorkDir: h.root,
    })).toThrow(/administrator permission/);
  });

  it('refuses a host project the caller is not assigned to', () => {
    const h = setup();
    const project = h.projects.create({ slug: 'other', path: h.root });
    expect(() => effectiveTurnWorkDir({
      policy: h.policy(h.member.id), accountUserId: h.member.id, sessionId: 'brain-member',
      projects: h.projects, projectRef: { kind: 'host', projectId: project.id }, baseWorkDir: h.root,
    })).toThrow(/host project unavailable/);
  });

  // The Chetty failure: the conversation kept a managed ref to a project that had since been deleted, so
  // host paths were refused as "managed" while the environment no longer existed — no files either way.
  it('resolves a managed ref whose project is gone on the host instead of failing closed', () => {
    const h = setup();
    const project = h.projects.create({ slug: 'assigned', path: h.root });
    h.userProjects.assign(h.member.id, project.id);
    const effective = effectiveTurnWorkDir({
      policy: h.policy(h.member.id), accountUserId: h.member.id, sessionId: 'brain-member',
      projects: h.projects, projectRef: { kind: 'managed', projectId: 4242 }, baseWorkDir: h.root,
    });
    expect(effective.workDir).toBe(h.root);
    expect(effective.projectRef).toBeUndefined();
  });

  it('carries a named host project into a delegated scope without administrator rights', () => {
    const scope = normalizeDelegatedExecutionScope({
      admin: false, owner: true, projectIds: [7], contributionUserId: 3, permissionBoundary: null,
      projectRef: { kind: 'host', projectId: 7 },
    });
    expect(scope?.projectRef).toEqual({ kind: 'host', projectId: 7 });
    expect(normalizeDelegatedExecutionScope({
      admin: false, owner: true, projectIds: [7], contributionUserId: 3, permissionBoundary: null,
      projectRef: { kind: 'host' },
    })).toBeUndefined();
  });
});
