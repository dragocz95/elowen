import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
  const root = mkdtempSync(join(tmpdir(), 'host-target-')); roots.push(root);
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
    // The daemon's primary project root: what a host target with no directory of its own falls back to.
    projectPath: () => root,
    users: { ensureAdvisorToken: () => 'tok', get: () => ({ name: 'Filip', username: 'filip', is_admin: true }), isAdmin: () => true },
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
  return { d, store, projects, owner, root };
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

  // A key that was stable for the life of a conversation-project pair made the provider hand back the
  // FIRST start it ever ran: after a manual stop, switching back returned that historical success,
  // queued nothing, and the next turn died on `environment_stopped`. The switch therefore carries no
  // key and leans on the provider's own dedupe of a live operation.
  it('starts a stopped environment again instead of rejoining a start that already finished', async () => {
    const h = await managedFixture();
    // The provider's rule, as `plugins/sandbox/lib/environmentRuntime.mjs:307-321` implements it: a
    // stored key answers with its operation whatever its status, while a keyless request rejoins only
    // an operation that is still live.
    const operations: { id: string; requestId?: string; status: string }[] = [];
    h.sandbox.requestEnvironment.mockImplementation(({ requestId }: { requestId?: string }) => {
      const prior = requestId ? operations.find((op) => op.requestId === requestId) : operations.find((op) => op.status === 'pending');
      if (prior) return prior;
      const created = { id: `env_op_${operations.length + 1}`, ...(requestId ? { requestId } : {}), status: 'pending' };
      operations.push(created);
      return created;
    });
    h.sandbox.environmentFor.mockResolvedValue({ state: 'unprovisioned' });
    const first = await h.service.selectProjectExecution(h.owner.id, { kind: 'managed', projectId: h.project.id }, h.sessionId);
    operations[0]!.status = 'succeeded';
    // …the environment then ran, the owner stopped it by hand, and the same switch is made again.
    h.sandbox.environmentFor.mockResolvedValue({ state: 'stopped' });
    const second = await h.service.selectProjectExecution(h.owner.id, { kind: 'managed', projectId: h.project.id }, h.sessionId);
    expect(second.operationId).not.toBe(first.operationId);
    expect(operations).toHaveLength(2);
  });

  it('rejoins the start that is still running rather than queueing a second one', async () => {
    const h = await managedFixture();
    h.sandbox.environmentFor.mockResolvedValue({ state: 'stopped' });
    h.sandbox.requestEnvironment.mockResolvedValue({ id: 'env_op_1', status: 'pending' });
    const first = await h.service.selectProjectExecution(h.owner.id, { kind: 'managed', projectId: h.project.id }, h.sessionId);
    const second = await h.service.selectProjectExecution(h.owner.id, { kind: 'managed', projectId: h.project.id }, h.sessionId);
    expect([first.operationId, second.operationId]).toEqual(['env_op_1', 'env_op_1']);
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

describe('an execution selection the resolver does not accept', () => {
  // `POST /brain/execution` accepts any well-formed ref, and the resolver answers a managed ref that
  // names a host project by running the conversation on the host. Storing the caller's ref anyway left
  // the row claiming a project the conversation would never execute in.
  it('refuses a managed ref that names a host project instead of persisting it', async () => {
    const h = serviceFixture();
    h.d.runtime = await inMemoryModelRuntime() as never;
    const root = mkdtempSync(join(tmpdir(), 'host-target-')); roots.push(root);
    const host = h.projects.create({ slug: 'legacy', path: root });
    const service = new BrainService(h.d as never);
    const { sessionId } = await service.start(h.owner.id);
    await expect(service.selectProjectExecution(h.owner.id, { kind: 'managed', projectId: host.id }, sessionId))
      .rejects.toThrow(/not available/);
    expect(h.store.getProjectExecution(sessionId)).toBeUndefined();
  });

  // Every other move persists the conversation's durable home; a host project switch set only the live
  // cwd, so the next cold respawn restored the directory the conversation had left.
  it('writes the durable home when the conversation moves into a host project', async () => {
    const h = serviceFixture();
    h.d.runtime = await inMemoryModelRuntime() as never;
    const root = mkdtempSync(join(tmpdir(), 'host-target-')); roots.push(root);
    const host = h.projects.create({ slug: 'legacy', path: root });
    const service = new BrainService(h.d as never);
    const { sessionId } = await service.start(h.owner.id);
    const result = await service.selectProjectExecution(h.owner.id, { kind: 'host', projectId: host.id }, sessionId);
    expect(result.workDir).toBe(root);
    expect(h.store.getSession(sessionId)?.work_dir).toBe(root);
  });

  // The nameless host target has no directory of its own, so it took the live cwd as its base — and a
  // managed project's live cwd is a path inside its own container. The switch therefore resolved to, and
  // persisted, `/sales-dashboard`, a directory this machine does not have: the next turn and every cold
  // respawn ran there.
  it('leaves a managed project for a host directory that exists', async () => {
    const h = serviceFixture();
    h.d.runtime = await inMemoryModelRuntime() as never;
    const project = h.projects.createForUser(h.owner.id, { slug: 'sales-dashboard' });
    const service = new BrainService(h.d as never);
    const { sessionId } = await service.start(h.owner.id);
    expect((await service.selectProjectExecution(h.owner.id, { kind: 'managed', projectId: project.id }, sessionId)).workDir).toBe('/sales-dashboard');
    const result = await service.selectProjectExecution(h.owner.id, { kind: 'host' }, sessionId);
    expect(result.workDir).toBe(h.root);
    expect(h.store.getSession(sessionId)?.work_dir).toBe(h.root);
  });
});

// A stored managed ref can outlive its project. Every turn of that conversation then resolves on the
// host (see `effectiveTurnWorkDir` and the Chetty shape in personalProjectExecution.test.ts), so the
// gates that still read the ROW as managed refuse a conversation that is no longer in a container.
describe('a managed ref whose project is gone', () => {
  it('allows the conversation to move its directory again', async () => {
    const h = serviceFixture();
    h.d.runtime = await inMemoryModelRuntime() as never;
    const service = new BrainService(h.d as never);
    const { sessionId } = await service.start(h.owner.id);
    h.store.setProjectExecution(sessionId, h.owner.id, { kind: 'managed', projectId: 4242 });
    expect(service.noteWorkDir(h.owner.id, h.root, sessionId).workDir).toBe(realpathSync(h.root));
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
