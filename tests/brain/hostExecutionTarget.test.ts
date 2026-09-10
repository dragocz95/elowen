import { describe, expect, it, vi } from 'vitest';
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
import { BrainStore } from '../../src/store/brainStore.js';
import { BrainService } from '../../src/brain/brainService.js';
import { preparePersonalProject } from '../../src/brain/service/personalProject.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';

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

/** Minimal BrainService deps, in the shape brainServiceYolo.test.ts uses, plus the project registry and
 *  the environment control a managed selection needs. */
function serviceFixture() {
  const db = openDb(':memory:'); databases.push(db);
  const store = new BrainStore(db);
  const projects = new ProjectStore(db);
  const users = new UserStore(db);
  const owner = users.create('owner', 'password');
  users.setAdmin(owner.id, true);
  const userProjects = new UserProjectStore(db);
  const piSession = {
    prompt: vi.fn(async () => {}), subscribe: () => () => {}, dispose: vi.fn(), abort: vi.fn(async () => {}),
    messages: [], isStreaming: false, getContextUsage: () => undefined, agent: {}, systemPrompt: '',
    getAllTools: () => [], getActiveToolNames: () => [], setActiveToolsByName: vi.fn(),
    supportsThinking: () => false, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    setSteeringMode: vi.fn(),
  };
  const sandbox = {
    prepareExecution: vi.fn(), environmentFor: vi.fn(), requestEnvironment: vi.fn(),
    environmentOperation: vi.fn(), projectFiles: vi.fn(), revokeProjectAccess: vi.fn(),
    environmentSnapshots: vi.fn(), environmentLogs: vi.fn(), managedWorktrees: vi.fn(),
    projectPreviewBinding: vi.fn(),
  };
  const d = {
    store, projects, userProjects,
    runtime: undefined,
    users: { ensureAdvisorToken: () => 'tok', get: () => ({ name: 'Filip', username: 'filip', is_admin: 1 }), isAdmin: () => true },
    policy: (id: number) => resolvePolicy({ projects, userProjects }, id),
    config: { providers: [{ id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'http://x/v1', models: ['m'], apiKey: 'k' }] },
    prompts: { render: () => 'PERSONA' },
    url: 'http://x',
    createSession: vi.fn(async () => ({ session: piSession })),
    resourceLoaderFactory: () => undefined,
    plugins: {
      peek: () => ({ control: (name: string) => (name === 'sandbox' ? sandbox : undefined), toolOwner: new Map(), userGrantable: new Map(), loadedNames: new Set() }),
      get: async () => undefined,
    },
  };
  return { d, store, projects, owner };
}

describe('the execution-change marker', () => {
  // `/workspace` is the path inside the project's own container: it names nothing a reader recognizes,
  // and truncated in a status line it reads as no name at all.
  it('names the managed project rather than its container path', async () => {
    const h = serviceFixture();
    h.d.runtime = await inMemoryModelRuntime() as never;
    const project = h.projects.createForUser(h.owner.id, { slug: 'sales-dashboard' });
    const service = new BrainService(h.d as never);
    const { sessionId } = await service.start(h.owner.id);
    // A marker only lands on a conversation that has already spoken; without a turn there is nothing to
    // annotate (see recordSessionEvent's empty-conversation guard).
    h.store.appendMessage({ id: 'm1', sessionId, parentId: null, role: 'user', content: { role: 'user', content: 'hi' } });
    const appended = vi.spyOn(h.store, 'appendSessionEvent');
    expect((await service.selectProjectExecution(h.owner.id, { kind: 'managed', projectId: project.id }, sessionId)).workDir).toBe('/sales-dashboard');
    expect(appended).toHaveBeenCalledWith(sessionId, 'cwd', 'sales-dashboard');
  });
});

// The owner watched "Ukládání" spin forever on a project switch: the answer waited on an environment that
// was being built, and a daemon restart in that window took the request with it. The switch now RECORDS
// the intent and hands back the operation to follow, so neither outcome is reachable.
describe('selecting a managed project does not wait for its container', () => {
  const managedFixture = async () => {
    const h = serviceFixture();
    h.d.runtime = await inMemoryModelRuntime() as never;
    const project = h.projects.createForUser(h.owner.id, { slug: 'sales-dashboard' });
    const service = new BrainService(h.d as never);
    const { sessionId } = await service.start(h.owner.id);
    return { ...h, project, service, sessionId, sandbox: h.d.plugins.peek()!.control('sandbox') as never as Record<string, ReturnType<typeof vi.fn>> };
  };

  it('returns the enqueued operation instead of blocking on the environment', async () => {
    const h = await managedFixture();
    h.sandbox.environmentFor.mockResolvedValue({ state: 'unprovisioned' });
    // A pending operation is what "enqueued, not performed" looks like: the container work has not run.
    h.sandbox.requestEnvironment.mockResolvedValue({ id: 'env_op_1', status: 'pending' });
    const result = await h.service.selectProjectExecution(h.owner.id, { kind: 'managed', projectId: h.project.id }, h.sessionId);
    expect(result.operationId).toBe('env_op_1');
    expect(result.workDir).toBe('/sales-dashboard');
    expect(h.sandbox.requestEnvironment).toHaveBeenCalledWith(expect.objectContaining({ action: { kind: 'start' } }));
  });

  it('uses one idempotency key per conversation and project, so a repeated switch rejoins its operation', async () => {
    const h = await managedFixture();
    h.sandbox.environmentFor.mockResolvedValue({ state: 'stopped' });
    h.sandbox.requestEnvironment.mockResolvedValue({ id: 'env_op_1', status: 'pending' });
    await h.service.selectProjectExecution(h.owner.id, { kind: 'managed', projectId: h.project.id }, h.sessionId);
    await h.service.selectProjectExecution(h.owner.id, { kind: 'managed', projectId: h.project.id }, h.sessionId);
    const keys = h.sandbox.requestEnvironment.mock.calls.map(([call]) => (call as { requestId: string }).requestId);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toContain(String(h.project.id));
  });

  it('asks for nothing when the environment is already running', async () => {
    const h = await managedFixture();
    h.sandbox.environmentFor.mockResolvedValue({ state: 'running' });
    const result = await h.service.selectProjectExecution(h.owner.id, { kind: 'managed', projectId: h.project.id }, h.sessionId);
    expect(result.operationId).toBeUndefined();
    expect(h.sandbox.requestEnvironment).not.toHaveBeenCalled();
  });

  // The selection is durable before the environment is asked for anything, so a refusal there cannot
  // undo a switch the person already made.
  it('still completes the switch when the environment request is refused', async () => {
    const h = await managedFixture();
    h.sandbox.environmentFor.mockRejectedValue(new Error('environment busy'));
    const result = await h.service.selectProjectExecution(h.owner.id, { kind: 'managed', projectId: h.project.id }, h.sessionId);
    expect(result.operationId).toBeUndefined();
    expect(result.projectRef).toEqual({ kind: 'managed', projectId: h.project.id });
  });
});

describe('a new conversation with no project chosen', () => {
  const spawnOpts = (h: ReturnType<typeof setup>, userId: number) => ({
    sessionId: `brain-${userId}-new`, ownerUserId: userId, selection: {},
    policy: h.policy(userId), autoCompact: false,
  });

  // Before project environments an administrator's chat simply ran on the host. Binding them to a private
  // managed project took away every file, tool and skill they had, which is what Chetty saw.
  it('leaves an administrator on the host, unrestricted', () => {
    const h = setup();
    const prepared = preparePersonalProject(
      { store: new BrainStore(h.db), projects: h.projects, policy: h.policy },
      spawnOpts(h, h.admin.id) as never,
    );
    expect(prepared.projectRef).toBeUndefined();
    expect(prepared.initialRef).toBeUndefined();
    expect(prepared.policy.allowedProjectIds).toBe('all');
    expect(h.users.get(h.admin.id)?.default_project_id).toBeNull();
  });

  it('opens a member in their assigned project, the lowest id when there are several', () => {
    const h = setup();
    const first = h.projects.create({ slug: 'first', path: h.root });
    const second = h.projects.create({ slug: 'second', path: h.root });
    h.userProjects.assign(h.member.id, second.id);
    h.userProjects.assign(h.member.id, first.id);
    const prepared = preparePersonalProject(
      { store: new BrainStore(h.db), projects: h.projects, policy: h.policy },
      spawnOpts(h, h.member.id) as never,
    );
    expect(prepared.projectRef).toEqual({ kind: 'host', projectId: first.id });
    expect(h.users.get(h.member.id)?.default_project_id).toBeNull();
  });

  it('falls back to the private default project for a member with no assignment', () => {
    const h = setup();
    const prepared = preparePersonalProject(
      { store: new BrainStore(h.db), projects: h.projects, policy: h.policy },
      spawnOpts(h, h.member.id) as never,
    );
    const defaultId = h.users.get(h.member.id)?.default_project_id;
    expect(defaultId).toBeTypeOf('number');
    expect(prepared.projectRef).toEqual({ kind: 'managed', projectId: defaultId });
  });
});
