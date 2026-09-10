import { lstatSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { PROJECT_BASE_IMAGE_TAG, PROJECT_CONTAINERFILE } from '../../plugins/sandbox/lib/containerBaseImage.mjs';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import { environmentPublicationMigration } from '../../plugins/sandbox/lib/environmentDb.mjs';
import { createEnvironmentRuntime, publicationSocketName } from '../../plugins/sandbox/lib/environmentRuntime.mjs';
import type { PodmanClient } from '../../plugins/sandbox/lib/podman.mjs';
import type { ContainerStorage } from '../../plugins/sandbox/lib/containerStorage.mjs';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function setup(config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'env-test-'));
  const sql = openDb(':memory:');
  const db = makePluginDb(sql, 'sandbox', { canMigrate: true });
  const users = new Set([1, 2, 3]);
  const members = new Set([1, 2]);
  const project: any = { id: 7, slug: 'sales-dashboard', executionKind: 'managed', lifecycle: 'active', path: '/not-a-host-path' };
  const stores = { usersRead: { list: () => [...users].map((id) => ({ id })), isAdmin: (id: number) => id === 3, mayUsePlugin: () => true },
    userProjects: { canAccess: (id: number) => project.lifecycle === 'active' && (members.has(id) || id === 3), canManage: (id: number) => members.has(id) || id === 3 },
    projects: { get: (id: number) => id === 7 ? project : null, list: () => [project], beginDeletion: () => { project.lifecycle = 'deleting'; return true; }, finishDeletion: vi.fn(() => true) } };
  const warn = vi.fn();
  const ctx: any = { db: () => db, host: { stores: () => stores }, currentAccountUserId: () => null, currentAccess: () => ({ readOnly: false }), config, logger: { info: vi.fn(), warn, error: vi.fn() } };
  initSandboxDb(ctx);
  const containers = new Map<string, any>();
  // A publication's forwarder is a real listening unix socket in the guest; here it is a real one on the
  // host side of the same path, so the runtime's readiness probe and its socket-file checks are exercised
  // against the operating system rather than against a stub that always agrees.
  const forwarders = new Map<string, Server>();
  const publicationSocket = (spec: any, publicationId: string) => join(spec.storageRoot, 'broker', publicationSocketName(publicationId));
  /** What a container that died actually leaves behind: a socket FILE on the host side of the bind mount
   *  with nothing listening on it. Binding it again is refused until it is removed, which is the whole
   *  reason the runtime may not read presence as liveness. */
  const staleSocket = (path: string) => execFileSync('/usr/bin/python3', ['-c', 'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', path]);
  const endForwarders = async () => {
    const servers = [...forwarders.values()];
    forwarders.clear();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  };
  const podman = { ensureProjectImage: vi.fn(async () => 'localhost/elowen-project-base:test'),
    containerInventory: vi.fn(async () => new Map([...containers].map(([name, row]) => [name, row.state]))),
    inspect: vi.fn(async (spec: any) => containers.get(spec.name) ?? null), inspectBinding: vi.fn(async (spec: any) => containers.get(spec.name)),
    create: vi.fn(async (spec: any) => {
      if (spec.expectedId) throw new Error('An immutable container binding cannot be recreated');
      const row = { id: 'a'.repeat(64), state: 'created' }; containers.set(spec.name, row); return row;
    }),
    start: vi.fn(async (spec: any) => { containers.get(spec.name).state = 'running'; }),
    stop: vi.fn(async (spec: any) => {
      containers.get(spec.name).state = 'stopped';
      // The guest forwarder dies with the container and its socket file does not. Closing the listener
      // first is what makes the file left behind a socket with NOTHING bound to it, which is the state
      // this test needs: binding it again is refused until somebody removes it.
      const paths = [...forwarders.keys()].map((publicationId) => publicationSocket(spec, publicationId));
      await endForwarders();
      for (const path of paths) staleSocket(path);
    }),
    startPublication: vi.fn(async (spec: any, publicationId: string) => {
      const path = publicationSocket(spec, publicationId);
      // The broker directory is created by the storage preparation this harness stubs out; the real guest
      // binds it as /run/elowen, so the socket really is written there.
      mkdirSync(dirname(path), { recursive: true });
      const server = createServer(() => {});
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
      forwarders.set(publicationId, server);
    }),
    stopPublication: vi.fn(async (spec: any, publicationId: string) => { forwarders.get(publicationId)?.close(); forwarders.delete(publicationId); }),
    activePublications: vi.fn(async (_spec: any, publicationIds: string[]) => publicationIds.filter((publicationId) => forwarders.has(publicationId))),
    update: vi.fn(async () => {}),
    remove: vi.fn(async (spec: any) => { containers.delete(spec.name); }),
    exec: vi.fn(async () => ({ code: 0, stdout: '', stderr: '', truncated: false })),
    // A start waits for the guest system bus before anything runs through `systemd-run`.
    waitForSystemBus: vi.fn(async () => {}),
    cancelExecution: vi.fn(async () => ({ terminated: true })), releaseExecution: vi.fn(),
    prepareExecution: vi.fn(async () => ({ launch: { type: 'argv', file: '/usr/bin/podman', args: ['exec', 'owned'], env: { HOME: '/host-service' } } })),
    removeVolume: vi.fn(), removeStorage: vi.fn(), inspectVolume: vi.fn(),
    containerExists: vi.fn(async (spec: any) => containers.has(spec.name)),
  };
  const storage = { prepare: vi.fn(), adoptWorkspace: vi.fn(), snapshot: vi.fn(), readSnapshot: vi.fn(), restoreVolumes: vi.fn(), releaseWorkspace: vi.fn() };
  const dependencies = { ctx, db, dataDir: root, podman: podman as unknown as PodmanClient, storage: storage as unknown as ContainerStorage };
  const runtime = createEnvironmentRuntime({ ...dependencies, daemon: true });
  const fork = createEnvironmentRuntime({ ...dependencies, daemon: false });
  cleanup.push(() => { endForwarders(); runtime.dispose(); fork.dispose(); sql.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, fork, db, sql, ctx, podman, storage, members, users, project, stores, root, containers, warn, forwarders, publicationSocket, staleSocket, endForwarders };
}
const input = { project: { kind: 'managed', projectId: 7 }, accountUserId: 1 };

describe('durable managed environment lifecycle', () => {
  // The project is mounted under its own name, and a container created before that must never be adopted:
  // its specification identity changed, so adopting it would run the turn against an unverified container.
  it('mounts the project at its own name and refuses to adopt a container from the previous layout', async () => {
    const { runtime, podman, db, containers, warn } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'named-start', action: { kind: 'start' } });
    await runtime.reconcile();
    expect(podman.create.mock.calls[0]![0].workdir).toBe('/sales-dashboard');
    expect(podman.create.mock.calls[0]![0].mounts.map((mount: any) => mount.target)).toEqual(['/sales-dashboard', '/root', '/data', '/run/elowen']);

    // Rewind the row to what it looked like before this change: no mount point, container already bound.
    const row = db.prepare("SELECT * FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get() as any;
    const spec = JSON.parse(row.spec_json);
    delete spec.input.workspaceTarget;
    db.prepare("UPDATE p_sandbox_runtimes SET spec_json=?, state='stopped' WHERE kind='project' AND resource_id='7'").run(JSON.stringify(spec));

    await runtime.requestEnvironment({ ...input, requestId: 'legacy-start', action: { kind: 'start' } });
    await runtime.reconcile();
    const failed = await runtime.environmentFor(input);
    expect(failed.lastError).toMatch(/predates the named project mount/);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/must be recreated at \/sales-dashboard/);

    // Once the operator has removed that container, the environment is recreated at the new mount point
    // from the same storage volumes, so the project's files survive.
    containers.clear();
    podman.create.mockClear();
    await runtime.requestEnvironment({ ...input, requestId: 'recreate-start', action: { kind: 'start' } });
    await runtime.reconcile();
    expect(podman.create).toHaveBeenCalledOnce();
    expect(podman.create.mock.calls[0]![0].workdir).toBe('/sales-dashboard');
    expect((await runtime.environmentFor(input)).state).toBe('running');
  });

  // Reconcile sweeps publications of every running project without going through `rowFor`, so a running
  // row that predates the named mount must not bring the whole tick down before that backfill happens.
  it('keeps reconciling when a running environment predates the named project mount', async () => {
    const { runtime, db } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'named-start', action: { kind: 'start' } });
    await runtime.reconcile();
    const row = db.prepare("SELECT * FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get() as any;
    const spec = JSON.parse(row.spec_json);
    delete spec.input.workspaceTarget;
    db.prepare("UPDATE p_sandbox_runtimes SET spec_json=? WHERE kind='project' AND resource_id='7'").run(JSON.stringify(spec));

    await expect(runtime.reconcile()).resolves.toBeUndefined();
  });

  // A new project environment used to be pinned to the figures compiled into the plugin, with nowhere to
  // change them; the administrator's settings now decide what it is provisioned with.
  it('provisions a project environment with the administrator resource defaults', async () => {
    const { runtime, podman } = setup({ defaultCpus: 2.5, defaultMemoryMb: 4096, defaultPidsLimit: 1024 });
    const expected = { cpus: 2.5, memoryMb: 4096, pidsLimit: 1024 };
    // Reported before the environment exists, so the figures shown are the ones it would be created with.
    expect((await runtime.environmentFor(input)).limits).toEqual(expected);
    await runtime.requestEnvironment({ ...input, requestId: 'defaults-start', action: { kind: 'start' } });
    await runtime.reconcile();
    expect((await runtime.environmentFor(input)).limits).toEqual(expected);
    // And they reach the container, not just the record.
    expect(podman.create.mock.calls[0]![0].limits).toEqual({ cpus: 2.5, memoryMb: 4096, pidsLimit: 1024 });
  });

  it('keeps the built-in figure for a setting that is missing or unusable', async () => {
    const { runtime } = setup({ defaultCpus: 0, defaultMemoryMb: 4096, defaultPidsLimit: 'many' });
    expect((await runtime.environmentFor(input)).limits).toEqual({ cpus: 1, memoryMb: 4096, pidsLimit: 512 });
  });

  it('round-trips stored limits through the public read and write contract', async () => {
    const { runtime, db } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'round-trip-start', action: { kind: 'start' } });
    await runtime.reconcile();
    db.prepare("UPDATE p_sandbox_runtimes SET limits_json=? WHERE kind='project' AND resource_id='7'")
      .run(JSON.stringify({ cpus: 1, memoryMb: 1024, pidsLimit: 512, diskSoftMb: 10240 }));

    const actor = { ...input, accountUserId: 3 };
    const stored = (await runtime.environmentFor(actor)).limits;
    expect(stored).toEqual({ cpus: 1, memoryMb: 1024, pidsLimit: 512 });
    await expect(runtime.requestEnvironment({ ...actor, requestId: 'round-trip-limits', action: { kind: 'limits', limits: stored } }))
      .resolves.toMatchObject({ action: { kind: 'limits', limits: stored } });
  });

  it('uses one container inventory and skips full inspection for healthy environments', async () => {
    const { runtime, podman } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    podman.containerInventory.mockClear();
    podman.inspect.mockClear();

    await runtime.reconcile();

    expect(podman.containerInventory).toHaveBeenCalledOnce();
    expect(podman.inspect).not.toHaveBeenCalled();
  });

  it('recovers a desired running environment whose container was left created after a host reboot', async () => {
    const { runtime, containers, podman, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    containers.values().next().value.state = 'created';
    podman.start.mockClear();

    await runtime.reconcile();

    expect(podman.start).toHaveBeenCalledOnce();
    expect((await runtime.environmentFor(input)).state).toBe('running');
    expect(db.prepare("SELECT message FROM p_sandbox_runtime_logs WHERE kind='project' AND resource_id='7' ORDER BY id").all()
      .map((entry: any) => entry.message).join('\n')).toMatch(/container not running after host reboot/);
  });

  // A container that fails the ownership check (a pre-batch site container, say) is not ours to restart,
  // and one such row must not end the sweep before the environments behind it are looked at.
  it('skips an environment whose container cannot be verified and keeps sweeping the rest', async () => {
    const { runtime, containers, podman, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    containers.values().next().value.state = 'created';
    podman.inspect.mockImplementationOnce(async () => { throw new Error('Container ownership or runtime specification mismatch: labels, mounts'); });
    podman.start.mockClear();

    await expect(runtime.reconcile()).resolves.toBeUndefined();

    expect(podman.start).not.toHaveBeenCalled();
    expect(db.prepare("SELECT message FROM p_sandbox_runtime_logs WHERE kind='project' AND resource_id='7' ORDER BY id").all()
      .map((entry: any) => entry.message).join('\n')).toMatch(/Automatic recovery skipped: .*mismatch: labels, mounts/);

    await runtime.reconcile();
    expect(podman.start).toHaveBeenCalledOnce();
  });

  it('never inspects or recovers an environment that still carries the pre-mount layout', async () => {
    const { runtime, containers, podman, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    containers.values().next().value.state = 'created';
    const row = db.prepare("SELECT spec_json FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get() as any;
    db.prepare("UPDATE p_sandbox_runtimes SET spec_json=? WHERE kind='project' AND resource_id='7'").run(JSON.stringify({ ...JSON.parse(row.spec_json), legacyWorkspaceLayout: true }));
    podman.inspect.mockClear(); podman.start.mockClear();

    await runtime.reconcile();

    expect(podman.inspect).not.toHaveBeenCalled();
    expect(podman.start).not.toHaveBeenCalled();
  });

  it('recreates a missing limited container from its volumes and restores publications', async () => {
    const { runtime, containers, podman, root, endForwarders, staleSocket } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    const changed = { cpus: 2, memoryMb: 2048, pidsLimit: 1024 };
    await runtime.requestEnvironment({ ...input, accountUserId: 3, action: { kind: 'limits', limits: changed } }); await runtime.reconcile();
    const publication = await runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 8080 });
    const marker = join(root, 'projects/7/storage/1/data/preserved');
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, 'still here');

    containers.clear();
    await endForwarders();
    staleSocket(publication.socketPath);
    podman.create.mockClear();
    podman.startPublication.mockClear();

    await runtime.reconcile();

    expect(podman.create).toHaveBeenCalledOnce();
    const recreated = podman.create.mock.calls[0]![0];
    expect(recreated.expectedId).toBeUndefined();
    expect(recreated.limits).toEqual(changed);
    expect(recreated.creationLimits ?? recreated.limits).toEqual(changed);
    expect(readFileSync(marker, 'utf8')).toBe('still here');
    expect(podman.startPublication).toHaveBeenCalledWith(expect.anything(), 'shop', expect.anything());
    expect((await runtime.environmentFor(input)).state).toBe('running');
  });

  it('reaches recovery attempts one through four after short successful restarts and manual start resets them', async () => {
    vi.useFakeTimers();
    cleanup.push(() => vi.useRealTimers());
    const { runtime, containers, podman, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    podman.start.mockClear();
    const stopAgain = () => { containers.values().next().value.state = 'created'; };

    stopAgain(); await runtime.reconcile();
    stopAgain(); await vi.advanceTimersByTimeAsync(30_000); await runtime.reconcile();
    stopAgain(); await vi.advanceTimersByTimeAsync(120_000); await runtime.reconcile();
    stopAgain(); await vi.advanceTimersByTimeAsync(600_000); await runtime.reconcile();

    expect(db.prepare("SELECT json_extract(checkpoint_json,'$.autoRecovery.attempt') AS attempt FROM p_sandbox_runtime_operations WHERE request_key LIKE 'autostart:%' ORDER BY rowid").all())
      .toEqual([{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }, { attempt: 4 }]);
    expect(podman.start).toHaveBeenCalledTimes(4);

    stopAgain(); await runtime.reconcile();
    expect((await runtime.environmentFor(input))).toMatchObject({ state: 'failed', lastError: expect.stringMatching(/automatic recovery failed after 4 attempts/i) });

    await runtime.requestEnvironment({ ...input, requestId: 'manual-recovery', action: { kind: 'start' } }); await runtime.reconcile();
    expect((await runtime.environmentFor(input)).state).toBe('running');
    stopAgain(); await runtime.reconcile();
    expect(db.prepare("SELECT json_extract(checkpoint_json,'$.autoRecovery.attempt') AS attempt FROM p_sandbox_runtime_operations WHERE request_key LIKE 'autostart:%' ORDER BY rowid DESC LIMIT 1").get())
      .toEqual({ attempt: 1 });
  });

  it('backs off repeated automatic recovery failures and eventually marks the environment failed', async () => {
    vi.useFakeTimers();
    cleanup.push(() => vi.useRealTimers());
    const { runtime, containers, podman, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    containers.values().next().value.state = 'created';
    podman.start.mockRejectedValue(new Error('container exited during boot'));
    podman.start.mockClear();

    await runtime.reconcile();
    await runtime.reconcile();
    expect(podman.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999); await runtime.reconcile();
    expect(podman.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await runtime.reconcile();
    expect(podman.start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(119_999); await runtime.reconcile();
    expect(podman.start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); await runtime.reconcile();
    expect(podman.start).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(599_999); await runtime.reconcile();
    expect(podman.start).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1); await runtime.reconcile();
    expect(podman.start).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(3_600_000); await runtime.reconcile();
    expect(podman.start).toHaveBeenCalledTimes(4);
    expect(db.prepare("SELECT state,error FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get()).toMatchObject({
      state: 'failed', error: expect.stringMatching(/automatic recovery failed after 4 attempts/i),
    });
  });

  it('resets automatic recovery attempts after the stability window', async () => {
    vi.useFakeTimers();
    cleanup.push(() => vi.useRealTimers());
    const { runtime, containers, podman, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    containers.values().next().value.state = 'created';
    await runtime.reconcile();
    await vi.advanceTimersByTimeAsync(900_000);
    containers.values().next().value.state = 'created';
    podman.start.mockClear();

    await runtime.reconcile();

    expect(podman.start).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT json_extract(checkpoint_json,'$.autoRecovery.attempt') AS attempt FROM p_sandbox_runtime_operations WHERE request_key LIKE 'autostart:%' ORDER BY rowid").all())
      .toEqual([{ attempt: 1 }, { attempt: 1 }]);
  });

  it('leaves explicit stopped and deleted intents untouched during runtime recovery', async () => {
    const { runtime, containers, podman, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    containers.values().next().value.state = 'created';
    podman.start.mockClear();

    db.prepare("UPDATE p_sandbox_runtimes SET desired_state='stopped',state='stopped' WHERE kind='project' AND resource_id='7'").run();
    await runtime.reconcile();
    db.prepare("UPDATE p_sandbox_runtimes SET desired_state='deleted',state='deleting' WHERE kind='project' AND resource_id='7'").run();
    await runtime.reconcile();

    expect(podman.start).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_runtime_operations WHERE request_key LIKE 'autostart:%'").get()).toEqual({ n: 0 });
  });

  it('lets explicit stop and delete replace a pending automatic recovery', async () => {
    for (const action of ['stop', 'delete'] as const) {
      const { runtime, db } = setup();
      await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
      db.prepare(`INSERT INTO p_sandbox_runtime_operations
        (id,kind,resource_id,user_id,request_key,generation,action_json,status,checkpoint_json)
        VALUES(?,?,?,?,?,?,?,'pending',?)`).run(`env_auto_${action}`, 'project', '7', 1, `autostart:1:1:${action}`, 1,
          JSON.stringify({ kind: 'start' }), JSON.stringify({ autoRecovery: { attempt: 1, queuedAt: Date.now() } }));

      const explicit = await runtime.requestEnvironment({ ...input, requestId: `explicit-${action}`, action: { kind: action } });

      expect(explicit.status).toBe('pending');
      expect(db.prepare('SELECT status,error FROM p_sandbox_runtime_operations WHERE id=?').get(`env_auto_${action}`)).toEqual({
        status: 'failed', error: `Superseded by explicit ${action}`,
      });
      expect(db.prepare("SELECT request_key FROM p_sandbox_runtime_operations WHERE status='pending' AND kind='project' AND resource_id='7'").get())
        .toEqual({ request_key: `explicit-${action}` });
    }
  });

  it('does not duplicate an active lifecycle operation during runtime recovery', async () => {
    const { runtime, fork, containers, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    containers.values().next().value.state = 'created';
    await fork.requestEnvironment({ ...input, requestId: 'manual-restart', action: { kind: 'restart' } });

    await runtime.reconcile();

    expect(db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_runtime_operations WHERE request_key LIKE 'autostart:%'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_runtime_operations WHERE request_key='manual-restart'").get()).toEqual({ n: 1 });
  });

  it('only the daemon executes a fork-recorded idempotent start', async () => {
    const { runtime, fork, podman } = setup();
    const op = await fork.requestEnvironment({ ...input, requestId: 'start-one', action: { kind: 'start' } });
    expect(op.status).toBe('pending');
    expect(await fork.requestEnvironment({ ...input, requestId: 'start-one', action: { kind: 'start' } })).toEqual(op);
    await fork.reconcile();
    expect(podman.create).not.toHaveBeenCalled();
    await runtime.reconcile();
    expect((await runtime.environmentOperation({ operationId: op.id, accountUserId: 1 }))?.status).toBe('succeeded');
    expect((await runtime.environmentFor(input)).state).toBe('running');
    expect(podman.create).toHaveBeenCalledOnce();
    await runtime.reconcile();
    expect(podman.create).toHaveBeenCalledOnce();
  });
  it('rechecks membership and generation before dispatching durable work', async () => {
    const { runtime, fork, members, podman } = setup();
    const op = await fork.requestEnvironment({ ...input, action: { kind: 'start' } });
    members.delete(1);
    await runtime.reconcile();
    expect(podman.create).not.toHaveBeenCalled();
    expect((await runtime.environmentOperation({ operationId: op.id, accountUserId: 3 }))?.status).toBe('failed');
    await expect(runtime.environmentFor(input)).rejects.toThrow(/access/i);
  });
  it('preserves the same container across explicit stop/start and refuses implicit restart', async () => {
    const { runtime, podman } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    await runtime.requestEnvironment({ ...input, action: { kind: 'stop' } }); await runtime.reconcile();
    await expect(runtime.prepareExecution({ command: { type: 'shell', command: 'true' }, cwd: '/workspace', projectRef: input.project, leaseKind: 'terminal' }, 1)).rejects.toThrow(/stopped/i);
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    expect(podman.create).toHaveBeenCalledOnce();
    expect(podman.stop).toHaveBeenCalledOnce();
  });
  it('revokes tracked actor work without stopping shared project services', async () => {
    const { runtime, members, podman, sql } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    const prepared = await runtime.prepareExecution({ command: { type: 'shell', command: 'sleep 5' }, cwd: '/workspace', projectRef: input.project, leaseKind: 'terminal' }, 1);
    expect(prepared.mode).toBe('managed');
    // The shell script is the bootstrap's declared prefix, written once, so anything the caller sends
    // after it stays on stdin for the program rather than being swallowed by the shell.
    expect(prepared.stdin.equals(Buffer.from('sleep 5'))).toBe(true);
    expect(podman.prepareExecution).toHaveBeenCalledWith(expect.anything(), expect.any(String),
      ['/usr/bin/python3', '-c', expect.stringContaining('memfd_create'), '7'], expect.anything());
    members.delete(1);
    await runtime.revokeProjectAccess({ projectId: 7, accountUserId: 1 });
    expect(podman.cancelExecution).toHaveBeenCalled();
    expect(podman.stop).not.toHaveBeenCalled();
    // 2 records a cancellation whose termination was PROVEN, which is what the release below reads.
    expect(sql.prepare('SELECT cancel_requested FROM p_sandbox_execution_leases WHERE id=?').get(prepared.lease.id)).toMatchObject({ cancel_requested: 2 });

    // The terminal releases its lease in a `finally`, so this release follows the revocation above. It
    // must retire the lease and nothing else: a normal release ends in an unmask, and unmasking the
    // cancellation's tombstone would reopen the late-launch race that cancelling had just closed.
    await prepared.lease.release();
    expect(podman.releaseExecution).not.toHaveBeenCalled();
    expect(podman.cancelExecution).toHaveBeenCalledOnce();
    expect(sql.prepare('SELECT 1 FROM p_sandbox_execution_leases WHERE id=?').get(prepared.lease.id)).toBeUndefined();
  });
  // Cancelling and releasing the same execution race in practice: the terminal cancels a running command
  // and then releases the lease in its `finally`, and a user closing the tab can do both at once.
  it('serializes a concurrent cancel and release into one cancellation and one lease deletion', async () => {
    const { runtime, podman, sql } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    const prepared = await runtime.prepareExecution({ command: { type: 'shell', command: 'sleep 5' }, cwd: '/workspace', projectRef: input.project, leaseKind: 'terminal' }, 1);

    await Promise.all([prepared.lease.cancel(), prepared.lease.release()]);

    // Whichever order they settle in, the guest is cancelled once and never un-cancelled, and the lease
    // is retired exactly once.
    expect(podman.cancelExecution).toHaveBeenCalledOnce();
    expect(podman.releaseExecution).not.toHaveBeenCalled();
    expect(sql.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases WHERE id=?').get(prepared.lease.id)).toEqual({ n: 0 });
  });

  it('cancels once however many times it is asked', async () => {
    const { runtime, podman } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    const prepared = await runtime.prepareExecution({ command: { type: 'shell', command: 'sleep 5' }, cwd: '/workspace', projectRef: input.project, leaseKind: 'terminal' }, 1);

    await prepared.lease.cancel();
    await prepared.lease.cancel();
    await Promise.all([prepared.lease.cancel(), prepared.lease.cancel()]);
    expect(podman.cancelExecution).toHaveBeenCalledOnce();
  });

  // A cancellation that could not be PROVEN is not a cancellation. It must not record itself as one, and
  // the release behind it has to fall back to the fully verified path so recovery still has its footing.
  it('keeps the verified fallback when a cancellation cannot be proven', async () => {
    const { runtime, podman, sql } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    const prepared = await runtime.prepareExecution({ command: { type: 'shell', command: 'sleep 5' }, cwd: '/workspace', projectRef: input.project, leaseKind: 'terminal' }, 1);
    podman.inspect.mockResolvedValue({ id: 'a'.repeat(64), state: 'paused' });

    await expect(prepared.lease.cancel()).rejects.toThrow(/cannot be verified/i);
    expect(podman.cancelExecution).not.toHaveBeenCalled();
    // Requested, never proven — so the lease still fences the environment.
    expect(sql.prepare('SELECT cancel_requested FROM p_sandbox_execution_leases WHERE id=?').get(prepared.lease.id)).toMatchObject({ cancel_requested: 1 });

    await expect(prepared.lease.release()).rejects.toThrow(/cannot be verified/i);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases WHERE id=?').get(prepared.lease.id)).toEqual({ n: 1 });
  });

  it('refuses a stale generation, read-only mutation and spoofed actor', async () => {
    const { runtime, ctx } = setup();
    await expect(runtime.requestEnvironment({ ...input, expectedGeneration: 8, action: { kind: 'start' } })).rejects.toThrow(/generation/i);
    ctx.currentAccess = () => ({ readOnly: true });
    await expect(runtime.requestEnvironment({ ...input, action: { kind: 'start' } })).rejects.toThrow(/read.only/i);
    ctx.currentAccess = () => ({ readOnly: false }); ctx.currentAccountUserId = () => 2;
    await expect(runtime.environmentFor(input)).rejects.toThrow(/actor/i);
  });
  it('rechecks generation inside the deletion intent transaction after asynchronous publication preflight', async () => {
    const { runtime, sql, project } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    runtime.connectSitesRuntime({ resolve: async () => null, beforeStart: async () => {}, afterStop: async () => {},
      projectDependents: async () => {
        sql.prepare("UPDATE p_sandbox_runtimes SET generation=2 WHERE kind='project' AND resource_id='7'").run();
        return [];
      },
    });
    await expect(runtime.requestEnvironment({ ...input, expectedGeneration: 1, requestId: 'stale-delete', action: { kind: 'delete' } })).rejects.toThrow(/generation/i);
    expect(project.lifecycle).toBe('active');
    expect(sql.prepare("SELECT generation,desired_state FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get()).toMatchObject({ generation: 2, desired_state: 'running' });
    expect(sql.prepare("SELECT id FROM p_sandbox_runtime_operations WHERE request_key='stale-delete'").get()).toBeUndefined();
  });
  it('answers a failed guest upload from a fixed table rather than forwarding guest text', async () => {
    const { runtime, podman, root } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    const real = async (...args: any[]) => {
      const argv = args[2]; const options = args[3];
      const result = spawnSync(argv[0], argv.slice(1), { input: options.input, encoding: 'utf8', maxBuffer: 2 ** 21,
        env: { ...process.env, ELOWEN_UPLOAD_ROOT: join(root, 'uploads') } });
      return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, truncated: false };
    };
    podman.exec.mockImplementation(real);
    const path = join(root, 'uploaded');
    const files = (operation: any) => runtime.projectFiles({ ...input, accountUserId: 1, operation });
    const { uploadId } = await files({ kind: 'write-begin', path, expectedVersion: null, size: 4 });

    // A guest failure carries whatever the operating system put in it: the staging directory, the candidate
    // file, an errno. The guest's failures are raised from inside the transfer, so its text is a running
    // commentary on a private staging area — none of which the caller can act on or should be shown.
    const guestSays = (error: unknown) => { podman.exec.mockImplementation(async () =>
      ({ code: 1, stdout: JSON.stringify({ ok: false, error }), stderr: '', truncated: false })); };
    const rejection = async (operation: any) => {
      try { await files(operation); } catch (raised) { return raised as { code?: string; status?: number; message: string }; }
      throw new Error('the upload was expected to fail');
    };
    const chunk = { kind: 'write-chunk', path, uploadId, offset: 0, base64: Buffer.from('abcd').toString('base64') };
    const staging = "[Errno 20] Not a directory: '/data/.elowen-uploads/ab12cd34/.elowen-upload-ab12cd34'";

    guestSays({ code: 'not_directory', message: staging });
    const known = await rejection(chunk);
    expect(known).toMatchObject({ code: 'not_directory', status: 409 });
    expect(known.message).not.toContain('.elowen-upload');
    expect(known.message).not.toContain('/data/.elowen-uploads');
    expect(known.message).not.toMatch(/Errno|errno/);

    // A code nobody agreed on is the guest off contract, which is ours to answer for and not something the
    // caller can fix by sending the request differently. It is internal, and it says nothing else.
    guestSays({ code: 'shutil_exploded', message: `${staging} while removing staging` });
    const unknown = await rejection(chunk);
    expect(unknown).toMatchObject({ code: 'guest_upload_error', status: 500 });
    expect(unknown.message).toBe('The guest could not complete this upload');

    // A reply with no error at all must not become an empty or undefined code.
    guestSays(undefined);
    expect(await rejection(chunk)).toMatchObject({ code: 'guest_upload_error', status: 500 });

    // A table reached by property lookup answers for every key Object.prototype carries, so these used to
    // find an "entry", skip the unknown branch entirely and come back with the guest's own code and no
    // status at all. They are not codes; they must land exactly where any other unrecognised code lands.
    for (const forged of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      guestSays({ code: forged, message: staging });
      const smuggled = await rejection(chunk);
      expect(smuggled).toMatchObject({ code: 'guest_upload_error', status: 500 });
      expect(smuggled.message).toBe('The guest could not complete this upload');
    }
    // A non-string code cannot match either, however object-shaped it is.
    guestSays({ code: { toString: () => 'not_directory' }, message: staging });
    expect(await rejection(chunk)).toMatchObject({ code: 'guest_upload_error', status: 500 });

    // The permission-shaped code keeps its own status: a refusal is understood and declined, not internal.
    guestSays({ code: 'upload_forbidden', message: staging });
    const refused = await rejection(chunk);
    expect(refused).toMatchObject({ code: 'upload_forbidden', status: 403 });
    expect(refused.message).not.toContain('.elowen-upload');

    // A reply that is not a reply is the guest breaking the response contract — also internal, never a
    // conflict, because nothing the caller sent explains it and repeating the request will not help.
    podman.exec.mockImplementation(async () => ({ code: 0, stdout: 'not json at all', stderr: '', truncated: false }));
    expect(await rejection(chunk)).toMatchObject({ code: 'guest_protocol', status: 500 });
    podman.exec.mockImplementation(async () => ({ code: 0, stdout: JSON.stringify({ ok: true, result: { kind: 'write-commit' } }), stderr: '', truncated: false }));
    expect(await rejection(chunk)).toMatchObject({ code: 'guest_protocol', status: 500 });
    podman.exec.mockImplementation(async () => ({ code: 0, stdout: '{}', stderr: '', truncated: true }));
    expect(await rejection(chunk)).toMatchObject({ code: 'guest_protocol', status: 500 });

    podman.exec.mockImplementation(real);
  });

  it('routes chunk uploads through the canonical actor and generation bound file control', async () => {
    const { runtime, podman, root, sql, ctx } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    podman.exec.mockImplementation(async (...args: any[]) => {
      const argv = args[2]; const options = args[3];
      const result = spawnSync(argv[0], argv.slice(1), { input: options.input, encoding: 'utf8', maxBuffer: 2 ** 21,
        env: { ...process.env, ELOWEN_UPLOAD_ROOT: join(root, 'uploads') } });
      if (result.error) throw result.error;
      return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, truncated: false };
    });
    const path = join(root, 'uploaded');
    const files = (operation: any, accountUserId = 1) => runtime.projectFiles({ ...input, accountUserId, operation });
    const begin = await files({ kind: 'write-begin', path, expectedVersion: null, size: 524289 });
    expect(begin.kind).toBe('write-begin');
    const uploadId = begin.uploadId;
    const calls = podman.exec.mock.calls.length;
    await expect(files({ kind: 'write-abort', path, uploadId }, 2)).rejects.toThrow(/another account/);
    expect(podman.exec.mock.calls.length).toBe(calls);
    await expect(files({ kind: 'write-chunk', path, uploadId, offset: 1, base64: 'YQ==' })).rejects.toThrow(/offset/);
    ctx.currentAccess = () => ({ readOnly: true });
    await expect(files({ kind: 'write-abort', path, uploadId })).rejects.toThrow(/read.only/);
    ctx.currentAccess = () => ({ readOnly: false });
    await files({ kind: 'write-chunk', path, uploadId, offset: 524288, base64: 'YQ==' });
    await files({ kind: 'write-chunk', path, uploadId, offset: 0, base64: Buffer.alloc(524288).toString('base64') });
    const done = await files({ kind: 'write-commit', path, uploadId });
    expect(done.entry.size).toBe(524289);
    expect(readFileSync(path).length).toBe(524289);
    expect(await files({ kind: 'write-commit', path, uploadId })).toEqual(done);
    const next = await files({ kind: 'write-begin', path, expectedVersion: done.entry.version, size: 0 });
    expect(next.uploadId).not.toBe(uploadId);
    writeFileSync(path, 'concurrent');
    await expect(files({ kind: 'write-commit', path, uploadId: next.uploadId })).rejects.toThrow(/version/);
    expect(readFileSync(path, 'utf8')).toBe('concurrent');
    await runtime.revokeProjectAccess({ projectId: 7, accountUserId: 1 });
    expect(sql.prepare('SELECT id FROM p_sandbox_file_uploads').all()).toEqual([]);
  });
  it('keeps a failed delete checkpoint and does not finalize the core Project', async () => {
    const { runtime, podman, stores } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    podman.removeStorage.mockRejectedValueOnce(new Error('disk busy'));
    const op = await runtime.requestEnvironment({ ...input, action: { kind: 'delete' } }); await runtime.reconcile();
    expect((await runtime.environmentOperation({ operationId: op.id, accountUserId: 1 }))?.status).toBe('failed');
    expect(stores.projects.finishDeletion).not.toHaveBeenCalled();
  });
});

describe('project base image binding', () => {
  // Adding a package to the recipe changes the tag, because the tag IS the hash of the recipe. That is how
  // a NEW environment picks the package up without a version to bump — and it is also the moment an
  // existing environment could be broken, if the runtime treated the new tag as the one it should be on.
  it('names an image derived from the recipe, and the recipe carries the PDF tools Read advertises', () => {
    expect(PROJECT_CONTAINERFILE).toMatch(/\bpoppler-utils\b/);
    const digest = createHash('sha256').update(PROJECT_CONTAINERFILE).digest('hex').slice(0, 16);
    expect(PROJECT_BASE_IMAGE_TAG).toBe(`localhost/elowen-project-base:${digest}`);

    // The same recipe without the package hashes elsewhere, so no existing image is silently redefined:
    // the older environments keep referring to a tag that still means what it always meant.
    const previous = PROJECT_CONTAINERFILE.replace(' poppler-utils', '');
    expect(previous).not.toBe(PROJECT_CONTAINERFILE);
    expect(createHash('sha256').update(previous).digest('hex').slice(0, 16)).not.toBe(digest);
  });

  it('stamps a NEW environment with the current recipe and builds it', async () => {
    const { runtime, podman } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'fresh', action: { kind: 'start' } });
    await runtime.reconcile();
    // The build only runs for a row that names the CURRENT recipe, so reaching it is itself the proof that
    // a project created now was stamped with the tag carrying the new package.
    expect(podman.ensureProjectImage).toHaveBeenCalledTimes(1);
    expect(podman.ensureProjectImage.mock.results[0]!.type).toBe('return');
  });

  it('leaves an environment bound to an older recipe on the image it was built with', async () => {
    const { runtime, podman, sql } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'initial', action: { kind: 'start' } });
    await runtime.reconcile();
    expect((await runtime.environmentFor(input)).state).toBe('running');

    // Put the row into the state every already-provisioned project is in the moment the recipe changes:
    // its stored specification names the image the earlier recipe produced.
    const stale = 'localhost/elowen-project-base:0000000000000000';
    const row = sql.prepare('SELECT kind, resource_id, spec_json FROM p_sandbox_runtimes').get() as any;
    const spec = JSON.parse(row.spec_json);
    spec.input.image = stale;
    sql.prepare('UPDATE p_sandbox_runtimes SET spec_json=? WHERE kind=? AND resource_id=?')
      .run(JSON.stringify(spec), row.kind, row.resource_id);

    podman.ensureProjectImage.mockClear();
    podman.create.mockClear();
    podman.remove.mockClear();
    await runtime.requestEnvironment({ ...input, requestId: 'cycle-stop', action: { kind: 'stop' } });
    await runtime.reconcile();
    await runtime.requestEnvironment({ ...input, requestId: 'cycle-start', action: { kind: 'start' } });
    await runtime.reconcile();

    // No build for the new recipe was attempted on this project's behalf, nothing was removed, and nothing
    // was recreated: the container it had is the container it still has.
    expect(podman.ensureProjectImage).not.toHaveBeenCalled();
    expect(podman.create).not.toHaveBeenCalled();
    expect(podman.remove).not.toHaveBeenCalled();
    expect(podman.start.mock.calls.at(-1)![0].image).toBe(stale);
    expect((await runtime.environmentFor(input)).state).toBe('running');

    // And the stored specification still names the old image afterwards — nothing rewrote it in passing.
    const after = JSON.parse((sql.prepare('SELECT spec_json FROM p_sandbox_runtimes').get() as any).spec_json);
    expect(after.input.image).toBe(stale);
  });
});

describe('adopted workspace rollback', () => {
  it('removes the provisioned environment and moves its workspace back through storage', async () => {
    const { runtime, podman, storage, project, sql, root } = setup();
    project.adoptedPath = join(root, 'host-project');
    await runtime.requestEnvironment({ ...input, requestId: 'adopted-start', action: { kind: 'start' } });
    await runtime.reconcile();

    await runtime.releaseAdoptedWorkspace(input);

    expect(podman.stop).toHaveBeenCalledOnce();
    expect(podman.remove).toHaveBeenCalledOnce();
    expect(podman.removeVolume).toHaveBeenCalledTimes(3);
    expect(storage.releaseWorkspace).toHaveBeenCalledWith(expect.anything(), project.adoptedPath);
    expect(podman.removeStorage).toHaveBeenCalledOnce();
    expect(sql.prepare("SELECT * FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get()).toBeUndefined();
  });
});

describe('durable project publications', () => {
  // The publication record shares the table the environments live in, so the migration that widens its
  // kind CHECK rebuilds a table that holds live rows. This is the upgrade a database in the field takes:
  // the v5 table as the previous migration left it, a row in it, then the step that adds the kind.
  it('adds the publication kind without losing the environments already recorded', () => {
    const sql = openDb(':memory:');
    try {
      sql.exec(`CREATE TABLE p_sandbox_runtimes (
        kind TEXT NOT NULL CHECK(kind IN ('project','site')), resource_id TEXT NOT NULL, project_id INTEGER NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'unprovisioned', desired_state TEXT NOT NULL DEFAULT 'running',
        spec_json TEXT NOT NULL, limits_json TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(kind,resource_id))`);
      sql.prepare("INSERT INTO p_sandbox_runtimes(kind,resource_id,project_id,generation,state,spec_json,limits_json,error) VALUES('project','7',7,3,'running','{\"input\":{\"generation\":3}}','{\"cpus\":1,\"memoryMb\":1024,\"pidsLimit\":512}',NULL)").run();
      environmentPublicationMigration.up({ exec: (statement: string) => sql.exec(statement) });
      expect(sql.prepare('SELECT * FROM p_sandbox_runtimes').all()).toMatchObject([
        { kind: 'project', resource_id: '7', project_id: 7, generation: 3, state: 'running', desired_state: 'running',
          spec_json: '{"input":{"generation":3}}', limits_json: '{"cpus":1,"memoryMb":1024,"pidsLimit":512}', error: null },
      ]);
      // The widened CHECK accepts the publication record and still refuses a kind nobody defined.
      sql.prepare("INSERT INTO p_sandbox_runtimes(kind,resource_id,project_id,spec_json,limits_json) VALUES('publication','shop',7,'{\"port\":8080}','{}')").run();
      expect(() => sql.prepare("INSERT INTO p_sandbox_runtimes(kind,resource_id,project_id,spec_json,limits_json) VALUES('nonsense','x',7,'{}','{}')").run())
        .toThrow(/CHECK/);
    } finally { sql.close(); }
  });

  const starting = async (runtime: any) => {
    await runtime.requestEnvironment({ ...input, requestId: 'publication-start', action: { kind: 'start' } });
    await runtime.reconcile();
  };
  const records = (sql: any) => sql.prepare("SELECT kind,resource_id,project_id FROM p_sandbox_runtimes WHERE kind='publication'").all();

  it('records a publication by project and publication and puts it back after a container restart', async () => {
    const { runtime, podman, sql, publicationSocket } = setup();
    await starting(runtime);
    const binding = await runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 8080 });
    const socketPath = publicationSocket(podman.create.mock.calls[0]![0], 'shop');
    expect(binding).toEqual({ generation: 1, socketPath });
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    // Keyed by the project and the publication: no account is named in the record, and none can be.
    expect(records(sql)).toEqual([{ kind: 'publication', resource_id: 'shop', project_id: 7 }]);
    expect(sql.prepare('PRAGMA table_info(p_sandbox_runtimes)').all().map((column: any) => column.name)).not.toContain('user_id');

    // A restart of the environment takes the guest forwarder with it. The record is what puts it back.
    await runtime.requestEnvironment({ ...input, requestId: 'publication-stop', action: { kind: 'stop' } });
    await runtime.reconcile();
    await runtime.requestEnvironment({ ...input, requestId: 'publication-restart', action: { kind: 'start' } });
    await runtime.reconcile();
    expect(podman.startPublication).toHaveBeenCalledTimes(2);
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    // The same publication, established again: one forwarder, one record.
    expect(records(sql)).toHaveLength(1);
  });

  it('restores only publications that belong to the project being started', async () => {
    const { runtime, podman, sql } = setup();
    await starting(runtime);
    sql.prepare("INSERT INTO p_sandbox_runtimes(kind,resource_id,project_id,state,desired_state,spec_json,limits_json) VALUES('publication','foreign',8,'running','running','{\"port\":9090}','{}')").run();
    await runtime.requestEnvironment({ ...input, requestId: 'scoped-stop', action: { kind: 'stop' } });
    await runtime.reconcile();
    await runtime.requestEnvironment({ ...input, requestId: 'scoped-start', action: { kind: 'start' } });
    await runtime.reconcile();
    expect(podman.startPublication.mock.calls.map((call: any[]) => call[1])).not.toContain('foreign');
  });

  it('keeps UUID publication transports within host limits and matches liveness by publication id', async () => {
    const publicationId = '6cd4e63e-5c4b-4f74-8b91-d61cd8da4d90';
    const realisticStorageRoot = '/var/www/.config/elowen/plugins-data/sandbox/projects/123456789/storage';
    expect(Buffer.byteLength(join(realisticStorageRoot, 'broker', publicationSocketName(publicationId)))).toBeLessThanOrEqual(107);

    const { runtime, podman } = setup();
    await starting(runtime);
    const binding = await runtime.projectPublicationBinding({ ...input, publicationId, port: 8080 });
    expect(Buffer.byteLength(binding.socketPath)).toBeLessThanOrEqual(107);
    podman.activePublications.mockClear();

    await runtime.reconcile();

    expect(podman.activePublications).toHaveBeenCalledWith(expect.anything(), [publicationId]);
  });

  it('shares one in-flight publication establishment between a request and reconciliation', async () => {
    const { runtime, podman } = setup();
    await starting(runtime);
    const startPublication = podman.startPublication.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    podman.startPublication.mockImplementation(async (spec: any, publicationId: string, argv: string[]) => {
      if (first) { first = false; await gate; }
      return await (startPublication as any)(spec, publicationId, argv);
    });

    const binding = runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 8080 });
    await vi.waitFor(() => expect(podman.startPublication).toHaveBeenCalledTimes(1));
    const reconciling = runtime.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const callsWhileBlocked = podman.startPublication.mock.calls.length;
    release();
    const results = await Promise.allSettled([binding, reconciling]);

    expect(callsWhileBlocked).toBe(1);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(podman.startPublication).toHaveBeenCalledTimes(1);
  });

  it('restores a lost forwarder on reconciliation and keeps serving for an account that lost access', async () => {
    const { runtime, podman, members, forwarders, staleSocket, publicationSocket } = setup();
    await starting(runtime);
    await runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 8080 });
    const socketPath = publicationSocket(podman.create.mock.calls[0]![0], 'shop');
    expect(podman.startPublication).toHaveBeenCalledTimes(1);

    // A cycle with nothing to do costs no guest round trip: the socket file is the whole test.
    await runtime.reconcile();
    expect(podman.startPublication).toHaveBeenCalledTimes(1);

    // The forwarder is gone, but an unclean exit can leave a socket inode behind with nobody listening.
    const dying = forwarders.get('shop')!;
    await new Promise<void>((resolve) => dying.close(() => resolve()));
    forwarders.delete('shop');
    staleSocket(socketPath);
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    await runtime.reconcile();
    expect(podman.startPublication).toHaveBeenCalledTimes(2);
    expect(lstatSync(socketPath).isSocket()).toBe(true);

    // Nobody's account owns it: the visitor it answers is not a member of anything.
    members.delete(1);
    await runtime.reconcile();
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    expect(podman.stopPublication).not.toHaveBeenCalled();
  });

  it('refuses an unusable publication and releases it after its owner account is removed', async () => {
    const { runtime, podman, sql, containers, users } = setup();
    await starting(runtime);
    await expect(runtime.projectPublicationBinding({ ...input, publicationId: 'Shop 1', port: 8080 })).rejects.toThrow(/token/i);
    await expect(runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 0 })).rejects.toThrow(/port/i);
    const binding = await runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 8080 });

    users.delete(1);
    await expect(runtime.projectPublicationBinding({ project: input.project, publicationId: 'shop', port: 8080 })).resolves.toEqual(binding);
    await runtime.projectPublicationRelease({ project: input.project, publicationId: 'shop' });
    expect(podman.stopPublication).toHaveBeenCalledWith(expect.anything(), 'shop');
    expect(records(sql)).toEqual([]);
    expect(() => lstatSync(binding.socketPath)).toThrow();
    expect(podman.startPublication.mock.calls.at(-1)![1]).toBe('shop');

    // Deleting the environment takes every publication of the project with it, so no dead record is left
    // behind for reconciliation to chase.
    const remaining = { project: input.project, accountUserId: 2 };
    await runtime.projectPublicationBinding({ ...remaining, publicationId: 'shop', port: 8080 });
    await runtime.requestEnvironment({ ...remaining, requestId: 'publication-delete', action: { kind: 'delete' } });
    await runtime.reconcile();
    expect(records(sql)).toEqual([]);
    expect(containers.size).toBe(0);
  });
});
