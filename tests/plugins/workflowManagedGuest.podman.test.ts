import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { it, expect } from 'vitest';
import { PodmanClient, SpawnExecutor, isolatedPodmanOptions } from '../../plugins/sandbox/lib/podman.mjs';
import { createEnvironmentRuntime } from '../../plugins/sandbox/lib/environmentRuntime.mjs';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import { buildBrainCore } from '../../src/daemon/brainCore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { currentAccountUserId, currentSessionId } from '../../src/plugins/policyContext.js';
import { currentAccess } from '../../src/plugins/pathGuard.js';
import { isPluginAllowedForUser } from '../../src/shared/pluginAccess.js';
import type { KnownControls, PluginControl } from '../../src/plugins/api.js';
import type { BrainEvent } from '../../src/brain/events.js';
import {
  startScriptedModel, contentText, MARKERS, NODE_ID, NODE_TASK, GUEST_MARKER, GUEST_MARKER_PATH, GUEST_NODES_PATH,
} from '../helpers/managedWorkflowModel.mjs';

/** The workflow engine inside a MANAGED project, end to end, against a real guest.
 *
 *  The unit suites pin the branch (workflowEngine.test.ts) and the registry seam over a guest stand-in
 *  (pluginControls.test.ts). Neither can show that the documented sequence — Write the definition, call
 *  WorkflowStart on that path, have the node run — completes inside a real environment, and that gap is
 *  exactly where WorkflowStart was broken: Write routed into the guest, WorkflowStart read the host.
 *
 *  Everything on the path under test is real: the production core (`buildBrainCore`, the same factory the
 *  daemon calls) with the REAL plugin loader, the real `files` and `subagent` plugins, a real BrainService
 *  turn driven by a scripted model, the real workflow engine, a real delegated child spawned through the
 *  host's own platform handler, and the real Sandbox environment runtime over a real Podman container.
 *
 *  What is NOT the daemon's: the Podman store. The bundled `sandbox` plugin builds its client with the
 *  service account's defaults (`plugins/sandbox/index.mjs`), so it is deliberately NOT enabled here; the
 *  environment runtime is constructed in this test around a client pinned to a private, exclusive-create
 *  store, and registered as the `sandbox` control the loaded plugins resolve at call time. A guarding
 *  executor proves every Podman invocation this process makes carries that private prefix, so no path —
 *  the parent's Write, the engine's read, the child's Read, the teardown — can reach the account store.
 *
 *  The forked sub-agent runner is excluded on purpose: no `subagentRunner` is handed to the core and the
 *  switch is pinned off, so the node runs in this process. A runner process would load its own sandbox
 *  plugin with the default store, which this harness must never allow. Runner dispatch is therefore not
 *  covered here. */

const ACTOR = 1;
const TURN_DEADLINE_MS = 900_000;
const ENVIRONMENT_DEADLINE_MS = 900_000;

it.runIf(process.env.ELOWEN_TEST_PODMAN === '1')('runs a managed-project workflow from a guest definition through a real child', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wfm-'));
  const isolation = isolatedPodmanOptions(join(scratch, 'pm'), `wfm-${randomBytes(6).toString('hex')}`, { useUserSessionBus: true });
  const paths = isolation.isolation;
  const expectedPrefix = ['--root', paths.storage, '--runroot', paths.runroot, '--tmpdir', paths.tmp, '--storage-driver', 'vfs'];
  const native = new SpawnExecutor();
  /** Every Podman call this process makes, checked BEFORE it runs: the private prefix and the private
   *  environment, or the whole test fails on the spot. */
  const podmanCalls: string[][] = [];
  const guarded = { run: async (file: string, args: string[], options: any) => {
    assert.equal(file, '/usr/bin/podman');
    assert.deepEqual(args.slice(0, expectedPrefix.length), expectedPrefix);
    assert.equal(options.env.HOME, paths.home);
    assert.equal(options.env.XDG_RUNTIME_DIR, paths.runtime);
    assert.equal(options.env.TMPDIR, paths.tmp);
    for (const key of ['CONTAINER_HOST', 'CONTAINER_CONNECTION', 'CONTAINERS_STORAGE_CONF']) assert.equal(options.env[key], undefined);
    podmanCalls.push(args.slice(expectedPrefix.length, expectedPrefix.length + 2));
    return native.run(file, args, options);
  } };
  const client = new PodmanClient({ ...isolation, executor: guarded });

  const began = Date.now();
  let stage = 'engine';
  const enter = (next: string) => { stage = next; console.log(`[${String(Math.round((Date.now() - began) / 1000)).padStart(4)}s] ${next}`); };

  let engineVerified = false;
  let model: Awaited<ReturnType<typeof startScriptedModel>> | undefined;
  let core: Awaited<ReturnType<typeof buildBrainCore>> | undefined;
  let runtime: ReturnType<typeof createEnvironmentRuntime> | undefined;
  let projectId: number | undefined;
  try {
    // ISOLATION FIRST. Podman itself reports where this client's store lives, before a project, a model
    // server or a core exists. Nothing below is allowed to start on a client whose roots are not private.
    const info = await client.info();
    assert.equal(info.graphRoot, paths.storage);
    assert.equal(info.runRoot, paths.runroot);
    engineVerified = true;
    console.log('Isolated rootless engine:', JSON.stringify(info));

    enter('core');
    model = await startScriptedModel();
    core = await buildBrainCore({
      dbPath: join(scratch, 'elowen.db'),
      project: { id: 1, slug: 'home', path: scratch },
      tmux: new FakeTmuxDriver(),
      bootstrap: { username: 'owner', password: 'pw-for-test-only' },
      pluginDirs: [join(process.cwd(), 'plugins'), join(scratch, 'user-plugins')],
      // No `subagentRunner`: the delegated child runs in this process, see the header.
    });
    if (!core.brain) throw new Error('the core built no BrainService');
    const brain = core.brain;
    // Every config change BEFORE the registry is fetched: a change re-loads the plugins, which would
    // replace the registry the sandbox control is about to be registered on.
    core.config.update({
      plugins: { enabled: ['files', 'subagent'] },
      runtime: { subagentRunnerEnabled: false },
      brain: { providers: [{ id: 'e2e-workflow-managed', label: 'E2E Model', type: 'openai', baseUrl: model.baseUrl, models: ['mock-model'], apiKey: 'e2e-test-key' }] },
    });
    const registry = await core.pluginProvider.get();
    // The bundled sandbox plugin must not exist in this process: it is the only thing that would build a
    // default-store client.
    expect([...registry.loadedNames].sort()).toEqual(['files', 'subagent']);
    expect(registry.control('sandbox')).toBeUndefined();
    expect(core.config.get().runtime.subagentRunnerEnabled).toBe(false);

    enter('environment runtime over the private store');
    const users = core.users;
    const sandboxDb = makePluginDb(core.db, 'sandbox', { canMigrate: true });
    /** The runtime's context reads the SAME ambient turn scope the daemon's sandbox plugin reads, and the
     *  same durable stores: membership, project rows and grants are the core's own, so `authorize()` inside
     *  the runtime decides on real rows for whichever account the turn stamped. Recorded so the child's
     *  membership check can be asserted rather than inferred. */
    const membershipChecks: { userId: number; projectId: number }[] = [];
    const runtimeCtx: any = {
      db: () => sandboxDb, config: {},
      currentAccountUserId, currentAccess,
      host: { stores: () => ({
        projects: core!.projects,
        userProjects: {
          canAccess: (userId: number, id: number) => { membershipChecks.push({ userId, projectId: id }); return core!.userProjects.canAccess(userId, id); },
          canManage: (userId: number, id: number) => core!.userProjects.canManage(userId, id),
        },
        usersRead: {
          list: () => users.list().map((u) => ({ id: u.id, isAdmin: !!u.is_admin })),
          isAdmin: (id: number) => users.isAdmin(id),
          mayUsePlugin: (id: number, plugin: string) => {
            const user = users.list().find((u) => u.id === id);
            return user ? isPluginAllowedForUser(user, { name: plugin, userGrantable: registry.userGrantable.has(plugin) }) : false;
          },
        },
      }) },
    };
    initSandboxDb(runtimeCtx);
    runtime = createEnvironmentRuntime({ ctx: runtimeCtx, db: sandboxDb, dataDir: join(scratch, 'sandbox'), namespace: paths.namespace, podman: client, daemon: true });

    /** Every guest file operation that reached the provider, with the turn it came from. The scope proof
     *  below reads these: the CHILD session must be the one that read the marker, on the actor's account,
     *  against this project. */
    const guestOps: { session: string | undefined; accountUserId: number; projectId: number; kind: string; path: string }[] = [];
    const unreachable = (name: string) => () => { throw new Error(`${name} is a host-worktree operation and must not be reached in a managed turn`); };
    // The control the daemon's sandbox plugin registers, with its managed half REAL (the runtime above)
    // and its host-worktree half answering as it does for an account with no worktrees: none to list, none
    // active. Those methods stand outside the managed path; the ones that would bind a worktree throw, so
    // reaching them is a failure rather than a silent detour.
    const sandboxControl = {
      ...runtime.control,
      projectFiles: (input: any) => {
        guestOps.push({ session: currentSessionId(), accountUserId: input.accountUserId, projectId: input.project?.projectId, kind: input.operation?.kind, path: input.operation?.path });
        return runtime!.control.projectFiles(input);
      },
      prepareExecution: (input: any, options?: { accountUserId?: number }) => {
        const projectRef = input.projectRef ?? currentAccess().projectRef;
        if (projectRef?.kind !== 'managed') throw new Error('host execution is not available in the managed workflow harness');
        return runtime!.prepareExecution({ ...input, projectRef }, options?.accountUserId ?? currentAccountUserId());
      },
      workspaceRoots: () => [],
      workspacesFor: () => [],
      activeWorkspace: () => null,
      activeSessionWorkspace: () => null,
      releaseSessionWorkspaces: () => ({ released: 0 }),
      resolveWorkspace: unreachable('resolveWorkspace'),
      acquireDelegationLease: unreachable('acquireDelegationLease'),
    } as unknown as KnownControls['sandbox'];
    registry.contextFor('sandbox', {}, { info() {}, warn() {}, error() {} }).registerControl('sandbox', sandboxControl as unknown as PluginControl);
    expect(registry.control('sandbox')).toBe(sandboxControl);

    enter('managed project and environment start');
    const project = core.projects.createManaged({ slug: `wf-managed-${Date.now()}`, creatorUserId: ACTOR });
    projectId = project.id;
    const projectRef = { kind: 'managed' as const, projectId };
    expect(project.executionKind).toBe('managed');
    const started = await runtime.requestEnvironment({ project: projectRef, accountUserId: ACTOR, action: { kind: 'start' } });
    const envUntil = Date.now() + ENVIRONMENT_DEADLINE_MS;
    let startOp = await runtime.environmentOperation({ accountUserId: ACTOR, operationId: started.id });
    while (startOp?.status !== 'succeeded') {
      if (startOp?.status === 'failed') throw new Error(`environment start failed: ${startOp.error}`);
      if (Date.now() > envUntil) throw new Error(`environment start did not finish (${startOp?.status})`);
      await runtime.reconcile();
      startOp = await runtime.environmentOperation({ accountUserId: ACTOR, operationId: started.id });
    }
    expect((await runtime.environmentFor({ project: projectRef, accountUserId: ACTOR })).state).toBe('running');
    // A fresh guest: neither file the parent is about to write exists yet, so a later presence is the
    // parent's doing and nothing else's.
    for (const path of [GUEST_MARKER_PATH, GUEST_NODES_PATH]) {
      expect((await runtime.control.projectFiles({ project: projectRef, accountUserId: ACTOR, operation: { kind: 'stat', path } })).entry).toBeNull();
    }

    enter('conversation bound to the project');
    // The subagent platform's handler is captured on startPlatforms; without it the engine has no way to
    // run a node. Narrowed to that one platform: plugin services belong to a daemon, not to a test core.
    const platformErrors: string[] = [];
    await brain.startPlatforms({ info() {}, error(message: string) { platformErrors.push(message); } }, ['subagent']);
    expect(platformErrors).toEqual([]);
    const { sessionId: session } = await brain.start(ACTOR, { fresh: true });
    expect(brain.selectProjectExecution(ACTOR, projectRef, session).workDir).toBe('/workspace');
    expect(core.brainStore.getProjectExecution(session)).toEqual(projectRef);
    // Write is an "ask" tool. The session-scoped override the other real-turn suites use: ask rules
    // auto-approve for this one throwaway conversation, deny rules still deny, the persisted default is
    // untouched.
    expect(brain.setYolo(ACTOR, true, session)).toEqual({ yolo: true });
    const events: BrainEvent[] = [];
    const unsubscribe = brain.subscribe(ACTOR, (event) => { events.push(event); });

    enter('the one turn that does everything');
    let turnTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        brain.send({ userId: ACTOR, text: 'Run the managed workflow.', session }),
        new Promise<never>((_, reject) => { turnTimer = setTimeout(() => reject(new Error('the parent turn did not settle')), TURN_DEADLINE_MS); }),
      ]);
    } finally {
      if (turnTimer) clearTimeout(turnTimer);
      unsubscribe();
    }
    const settled = JSON.stringify(core.brainStore.getSettledMessages(session).map((row) => row.content));
    const diagnostics = () => {
      const requests = model!.requests.map((r: any, i: number) => {
        const messages = r?.body?.messages ?? [];
        const kind = messages.map(contentText).join('\n').includes('You are a focused sub-agent') ? 'node' : 'parent';
        return `#${i} ${kind} last=${messages.at(-1)?.role ?? '-'} toolResults=${messages.filter((m: any) => m?.role === 'tool').length}`;
      }).join('\n  ');
      return `model requests:\n  ${requests}\ntranscript: ${settled.slice(0, 2000)}`;
    };

    enter('the workflow ran and its result came back into the parent turn');
    expect(settled, diagnostics()).toContain(MARKERS.parentDone);
    expect(settled, diagnostics()).toMatch(/status:\s*done/i);
    expect(settled, diagnostics()).toContain(MARKERS.nodeResult);
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events.some((event) => event.type === 'workflow' && JSON.stringify(event).includes(NODE_ID))).toBe(true);

    enter('the definition and the marker live in the guest, and only there');
    for (const path of [GUEST_MARKER_PATH, GUEST_NODES_PATH]) {
      const entry = (await runtime.control.projectFiles({ project: projectRef, accountUserId: ACTOR, operation: { kind: 'stat', path } })).entry;
      expect(entry?.kind, path).toBe('file');
      expect(existsSync(path)).toBe(false);
    }
    // The parent's Write of the definition was the guest provider's doing, on the parent's own session.
    const definitionWrite = guestOps.find((op) => op.kind === 'write' && op.path === GUEST_NODES_PATH);
    expect(definitionWrite).toMatchObject({ session, accountUserId: ACTOR, projectId });

    enter('the node kept the managed project and account scope');
    expect(settled, diagnostics()).toContain(MARKERS.scopeKept);
    expect(settled).not.toContain(MARKERS.scopeLost);
    // The guest bytes reached the child on the wire: its second request carries the marker as a tool result.
    expect(model.nodeRequests.length, diagnostics()).toBe(2);
    expect(model.nodeRequests.every((body: any) => (body?.messages ?? []).some((m: any) => contentText(m).includes(NODE_TASK)))).toBe(true);
    expect(model.nodeRequests.some((body: any) => (body?.messages ?? []).some((m: any) => m?.role === 'tool' && contentText(m).includes(GUEST_MARKER)))).toBe(true);
    // The scope itself, observed at the provider boundary rather than inferred from the read succeeding:
    // the marker read arrived from a persisted sub-agent session, on the actor's account, for this project.
    const childReads = guestOps.filter((op) => op.kind === 'read' && op.path === GUEST_MARKER_PATH);
    expect(childReads.length).toBeGreaterThan(0);
    for (const read of childReads) {
      expect(read.session, JSON.stringify(read)).toMatch(/^brain-ch-subagent-/);
      expect(read.accountUserId).toBe(ACTOR);
      expect(read.projectId).toBe(projectId);
    }
    const childSession = childReads[0]!.session!;
    const childRow = core.brainStore.getSession(childSession);
    expect(childRow?.user_id, 'the child session is not persisted for the actor').toBe(ACTOR);
    expect(core.brainStore.getProjectExecution(childSession)).toEqual(projectRef);
    expect(core.brainStore.getSession(session)?.user_id).toBe(ACTOR);
    // The engine's own read of the definition went through the guest seam on the PARENT session — the
    // host path guard has nothing to say in a managed turn.
    const definitionRead = guestOps.find((op) => op.kind === 'read' && op.path === GUEST_NODES_PATH);
    expect(definitionRead).toMatchObject({ session, accountUserId: ACTOR, projectId });
    // Membership was resolved for the actor against this project during the turn, on the runtime's real
    // rows — the provider refuses any account the project does not admit.
    expect(membershipChecks.some((check) => check.userId === ACTOR && check.projectId === projectId)).toBe(true);
    expect(membershipChecks.every((check) => check.projectId === projectId)).toBe(true);
    // The child ran in this process against this control: nothing else ever answered a guest operation.
    expect(guestOps.every((op) => op.projectId === projectId && op.accountUserId === ACTOR)).toBe(true);

    enter('teardown');
    const deleted = await runtime.requestEnvironment({ project: projectRef, accountUserId: ACTOR, action: { kind: 'delete' } });
    const deleteUntil = Date.now() + 180_000;
    let deleteOp = await runtime.environmentOperation({ accountUserId: ACTOR, operationId: deleted.id });
    while (deleteOp?.status !== 'succeeded') {
      if (deleteOp?.status === 'failed') throw new Error(`environment delete failed: ${deleteOp.error}`);
      if (Date.now() > deleteUntil) throw new Error(`environment delete did not finish (${deleteOp?.status})`);
      await runtime.reconcile();
      deleteOp = await runtime.environmentOperation({ accountUserId: ACTOR, operationId: deleted.id });
    }
    console.log(`Podman calls, all under the private prefix: ${podmanCalls.length}`);
  } catch (error) {
    console.error(`Managed workflow stage failed: ${stage}`);
    throw error;
  } finally {
    try { await runtime?.dispose(); } catch { /* best effort */ }
    try { await model?.close(); } catch { /* best effort */ }
    try { core?.db.close(); } catch { /* best effort */ }
    if (engineVerified) {
      // The private store, and only it: the same explicit prefix every call above carried.
      const reset = await native.run('/usr/bin/podman',
        [...expectedPrefix, 'system', 'reset', '--force'],
        { env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: paths.home, XDG_RUNTIME_DIR: paths.runtime, TMPDIR: paths.tmp,
          ...(paths.userBus ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=${paths.userBus.path}` } : {}) },
          timeoutMs: 180_000, outputLimitBytes: 1024 * 1024 });
      if (reset.code !== 0) throw new Error(`private Podman cleanup failed; retained ${scratch}: ${reset.stderr}`);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}, 1_800_000);
