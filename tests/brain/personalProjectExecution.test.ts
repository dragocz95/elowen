import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { LiveSessionSpawner } from '../../src/brain/service/spawner.js';
import { BrainSessionFactory } from '../../src/brain/session/factory.js';
import { ConversationLifecycle } from '../../src/brain/service/lifecycle.js';
import { ClientAttachments } from '../../src/brain/service/attachments.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import type { LiveBrain, SpawnOpts } from '../../src/brain/session/liveBrain.js';
import { preparePersonalProject } from '../../src/brain/service/personalProject.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import { effectiveTurnWorkDir } from '../../src/brain/service/workDir.js';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { resolvePolicy } from '../../src/plugins/policy.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { assertPathAllowed, currentAccess, defaultCwd } from '../../src/plugins/pathGuard.js';
import type { SandboxControl } from '../../src/plugins/api.js';

let runtime: ModelRuntime;
const databases: Db[] = [];
const roots: string[] = [];
beforeAll(async () => { runtime = await inMemoryModelRuntime(); });
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const db = openDb(':memory:'); databases.push(db);
  const root = mkdtempSync(join(tmpdir(), 'personal-project-')); roots.push(root);
  const store = new BrainStore(db);
  const projects = new ProjectStore(db);
  const users = new UserStore(db);
  users.create('admin', 'password');
  const user = users.create('member', 'password');
  const userProjects = new UserProjectStore(db);
  const policy = (id: number) => resolvePolicy({ projects, userProjects }, id);
  const resourceLoader = vi.fn(() => undefined);
  const createSession = vi.fn(async () => ({ session: {
    sessionId: 'fake-pi', agent: {}, messages: [], systemPrompt: 'Elowen',
    subscribe: () => () => {}, getAllTools: () => [], getActiveToolNames: () => [],
    setActiveToolsByName: vi.fn(), setSteeringMode: vi.fn(), dispose: vi.fn(),
  } }));
  const factory = new BrainSessionFactory({ store, createSession: createSession as never, resourceLoaderFactory: resourceLoader });
  const spawner = new LiveSessionSpawner({
    store, projects, policy, runtime, users,
    config: { providers: [{ id: 'test', label: 'Test', type: 'openai', baseUrl: 'https://invalid.example/v1', models: ['gpt-5'], apiKey: 'unused' }] },
    toolAuthorityFor: () => undefined,
    prompts: { render: () => 'Elowen' } as never,
    plugins: async () => undefined, factory, sessionTaps: () => [], url: 'http://127.0.0.1',
    cwd: root, projectPath: () => root, liveRecallBudget: undefined, chatImagesDir: undefined,
  });
  const spawn = (id: string, clientCwd?: string, extra: Partial<SpawnOpts> = {}) => spawner.spawn({ sessionId: id, ownerUserId: user.id, selection: {}, policy: policy(user.id), autoCompact: false, ...(clientCwd === undefined ? {} : { clientCwd }), ...extra });
  const sessions = new LiveSessionRegistry<LiveBrain>();
  const lifecycle = new ConversationLifecycle({
    store, sessions, policy, attachments: new ClientAttachments(),
    elicitation: { cancelForSession: vi.fn() },
    goals: { cancelGoalContinuation: vi.fn(), reconcileGoal: vi.fn() },
    spawn: (opts: SpawnOpts) => spawner.spawn(opts), selectionAllowed: () => true,
  } as never);
  return { store, projects, users, user, userProjects, policy, spawn, root, resourceLoader, lifecycle, sessions };
}

const readyControl = () => ({
  prepareExecution: vi.fn(), environmentFor: vi.fn(), requestEnvironment: vi.fn(),
  environmentOperation: vi.fn(), projectFiles: vi.fn(), revokeProjectAccess: vi.fn(),
  // Required by the current control contract (ENVIRONMENT_CONTROL_METHODS); these metadata-only tests
  // never provision, so any real call is an unexpected one.
  environmentSnapshots: async () => { throw new Error('environmentSnapshots is not expected in this fixture'); },
  environmentLogs: async () => { throw new Error('environmentLogs is not expected in this fixture'); },
  managedWorktrees: async () => { throw new Error('managedWorktrees is not expected in this fixture'); },
  projectPreviewBinding: async () => { throw new Error('projectPreviewBinding is not expected in this fixture'); },
} as unknown as SandboxControl);

describe('new personal conversation execution defaults', () => {
  it('persists a private managed target and refreshes policy before the first tool without provisioning', async () => {
    const h = setup();
    expect(h.policy(h.user.id).allowedProjectIds).toEqual(new Set());
    const { sessionId } = await h.lifecycle.start(h.user.id, { surface: 'web' });
    const live = h.sessions.get(sessionId)!;
    const ref = h.store.getProjectExecution(sessionId);
    const projectId = h.users.get(h.user.id)?.default_project_id;
    expect(ref).toEqual({ kind: 'managed', projectId });
    expect(projectId).toBeTypeOf('number');
    expect(h.userProjects.forProject(projectId!)).toEqual([h.user.id]);
    expect(live.policy.allowedProjectIds).toEqual(new Set([projectId]));
    expect(live.policy.canAccessProject?.(projectId!)).toBe(true);
    // The project is mounted under its own name, so the conversation's directory IS the project.
    const root = `/${h.projects.get(projectId!)!.slug}`;
    expect(live.workDir).toBe(root);
    expect(h.resourceLoader).toHaveBeenCalledWith(expect.objectContaining({ cwd: root, contextFiles: false }));
    const sandbox = readyControl();
    const effective = effectiveTurnWorkDir({ policy: live.policy, accountUserId: h.user.id, sessionId: live.sessionId, projectRef: ref, projects: h.projects, sandbox, baseWorkDir: h.root });
    runWithPolicy(live.policy, () => {
      expect(currentAccess().projectRef).toEqual(ref);
      expect(defaultCwd()).toBe(root);
      expect(() => assertPathAllowed(h.root)).toThrow(/guest filesystem/);
    }, { projectRef: effective.projectRef, workDir: effective.workDir });
    expect(sandbox.requestEnvironment).not.toHaveBeenCalled();
    expect(sandbox.environmentFor).not.toHaveBeenCalled();
    expect(sandbox.prepareExecution).not.toHaveBeenCalled();
  });

  it('refuses the first tool target when the runtime is absent instead of selecting the host', async () => {
    const h = setup(); const live = await h.spawn('brain-no-provider');
    expect(() => effectiveTurnWorkDir({ policy: live.policy, accountUserId: h.user.id, sessionId: live.sessionId, projectRef: h.store.getProjectExecution(live.sessionId), projects: h.projects, baseWorkDir: h.root })).toThrow(/environment provider unavailable/);
  });

  it('uses the same metadata-only default in a direct personal conversation', async () => {
    const h = setup();
    const live = await h.spawn('brain-ch-dm', undefined, { channel: true, direct: true });
    expect(h.store.getProjectExecution(live.sessionId)).toEqual({ kind: 'managed', projectId: h.users.get(h.user.id)?.default_project_id });
    expect(live.policy.canAccessProject?.(h.users.get(h.user.id)!.default_project_id!)).toBe(true);
  });

  it('adds only the default membership without relaxing the caller policy', async () => {
    const h = setup();
    const other = h.projects.createManaged({ slug: 'other', creatorUserId: h.user.id });
    const restricted = { ...h.policy(h.user.id), canExecuteHost: () => false, allowedProjectIds: new Set<number>() };
    const live = await h.spawn('brain-narrow', undefined, { policy: restricted });
    expect(live.policy.allowedProjectIds).toEqual(new Set([h.users.get(h.user.id)?.default_project_id]));
    expect(live.policy.canAccessProject?.(other.id)).toBe(false);
    expect(live.policy.canExecuteHost?.()).toBe(false);
  });

  it.each([
    { channel: true }, { scheduled: true }, { parentSessionId: 'parent' },
    { pathView: { root: '/workspace' } },
  ])('never assigns a personal default to a scoped or non-personal spawn %j', (extra) => {
    const h = setup(); const policy = h.policy(h.user.id);
    const prepared = preparePersonalProject(h, { sessionId: 'excluded', ownerUserId: h.user.id, selection: {}, policy, autoCompact: false, ...extra } as SpawnOpts);
    expect(prepared.policy).toBe(policy);
    expect(prepared.initialRef).toBeUndefined();
    expect(h.projects.list()).toHaveLength(0);
    expect(h.users.get(h.user.id)?.default_project_id).toBeNull();
  });

  it('refuses new personal creation when trusted metadata is not wired', () => {
    const h = setup();
    expect(() => preparePersonalProject({ store: h.store, projects: h.projects }, { sessionId: 'missing', ownerUserId: h.user.id, selection: {}, policy: h.policy(h.user.id), autoCompact: false })).toThrow('personal project metadata unavailable');
    expect(h.store.getSession('missing')).toBeUndefined();
  });

  it('keeps resumed legacy conversations unchanged, including cwd-less rows', async () => {
    const h = setup();
    h.store.createSession({ id: 'brain-legacy', userId: h.user.id, model: 'gpt-5', provider: 'test' });
    const live = await h.spawn('brain-legacy');
    expect(h.store.getProjectExecution(live.sessionId)).toBeUndefined();
    expect(h.users.get(h.user.id)?.default_project_id).toBeNull();
    expect(h.projects.list()).toHaveLength(0);
    expect(live.workDir).toBe(h.root);
  });

  it('preserves an explicit host directory on a new conversation', async () => {
    const h = setup();
    const host = h.projects.create({ slug: 'host', path: h.root });
    h.userProjects.assign(h.user.id, host.id);
    const live = await h.spawn('brain-explicit', h.root);
    expect(h.store.getProjectExecution(live.sessionId)).toBeUndefined();
    expect(h.users.get(h.user.id)?.default_project_id).toBeNull();
    expect(live.workDir).toBe(h.root);
  });

  it('keeps an existing selected managed project rather than replacing it with a default', async () => {
    const h = setup();
    const project = h.projects.createManaged({ slug: 'chosen', creatorUserId: h.user.id });
    h.store.createSession({ id: 'brain-selected', userId: h.user.id, model: 'gpt-5', provider: 'test' });
    h.store.setProjectExecution('brain-selected', h.user.id, { kind: 'managed', projectId: project.id });
    const live = await h.spawn('brain-selected');
    expect(h.store.getProjectExecution(live.sessionId)).toEqual({ kind: 'managed', projectId: project.id });
    expect(h.users.get(h.user.id)?.default_project_id).toBeNull();
    expect(live.workDir).toBe('/chosen');
    h.lifecycle.stampWorkDir('brain-selected', h.root, h.policy(h.user.id));
    expect(h.store.getSession('brain-selected')?.work_dir).toBe('');
  });

  it('does not retarget a healthy live host conversation when another client reconnects without cwd', async () => {
    const h = setup();
    const host = h.projects.create({ slug: 'host', path: h.root });
    h.userProjects.assign(h.user.id, host.id);
    const { sessionId } = await h.lifecycle.start(h.user.id, { surface: 'cli', cwd: h.root });
    const live = h.sessions.get(sessionId);
    await h.lifecycle.ensureLive(h.user.id, sessionId);
    expect(h.sessions.get(sessionId)).toBe(live);
    expect(h.store.getProjectExecution(sessionId)).toBeUndefined();
    expect(h.users.get(h.user.id)?.default_project_id).toBeNull();
  });

  it('rejects a second independent execution authority on a delegated row', () => {
    const h = setup();
    h.store.createSession({ id: 'parent', userId: h.user.id, model: 'gpt-5' });
    expect(() => h.store.createSession({ id: 'child', userId: h.user.id, model: 'gpt-5', parentSessionId: 'parent', executionRef: { kind: 'host' } })).toThrow(/belongs in its access scope/);
    expect(h.store.getSession('child')).toBeUndefined();
  });
});
