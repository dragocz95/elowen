import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import { createEnvironmentRuntime } from '../../plugins/sandbox/lib/environmentRuntime.mjs';
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
  const project: any = { id: 7, executionKind: 'managed', lifecycle: 'active', path: '/not-a-host-path' };
  const stores = { usersRead: { list: () => [...users].map((id) => ({ id })), isAdmin: (id: number) => id === 3, mayUsePlugin: () => true },
    userProjects: { canAccess: (id: number) => project.lifecycle === 'active' && (members.has(id) || id === 3), canManage: (id: number) => members.has(id) || id === 3 },
    projects: { get: (id: number) => id === 7 ? project : null, list: () => [project], beginDeletion: () => { project.lifecycle = 'deleting'; return true; }, finishDeletion: vi.fn(() => true) } };
  const ctx: any = { db: () => db, host: { stores: () => stores }, currentAccountUserId: () => null, currentAccess: () => ({ readOnly: false }), config };
  initSandboxDb(ctx);
  const containers = new Map<string, any>();
  const podman = { ensureProjectImage: vi.fn(async () => 'localhost/elowen-project-base:test'),
    inspect: vi.fn(async (spec: any) => containers.get(spec.name) ?? null), inspectBinding: vi.fn(async (spec: any) => containers.get(spec.name)),
    create: vi.fn(async (spec: any) => { const row = { id: 'a'.repeat(64), state: 'created' }; containers.set(spec.name, row); return row; }),
    start: vi.fn(async (spec: any) => { containers.get(spec.name).state = 'running'; }),
    stop: vi.fn(async (spec: any) => { containers.get(spec.name).state = 'stopped'; }),
    remove: vi.fn(async (spec: any) => { containers.delete(spec.name); }),
    exec: vi.fn(async () => ({ code: 0, stdout: '', stderr: '', truncated: false })),
    cancelExecution: vi.fn(async () => ({ terminated: true })), releaseExecution: vi.fn(),
    prepareExecution: vi.fn(async () => ({ launch: { type: 'argv', file: '/usr/bin/podman', args: ['exec', 'owned'], env: { HOME: '/host-service' } } })),
    removeVolume: vi.fn(), removeStorage: vi.fn(), inspectVolume: vi.fn(),
  };
  const storage = { prepare: vi.fn(), snapshot: vi.fn(), readSnapshot: vi.fn(), restoreVolumes: vi.fn() };
  const dependencies = { ctx, db, dataDir: root, podman: podman as unknown as PodmanClient, storage: storage as unknown as ContainerStorage };
  const runtime = createEnvironmentRuntime({ ...dependencies, daemon: true });
  const fork = createEnvironmentRuntime({ ...dependencies, daemon: false });
  cleanup.push(() => { runtime.dispose(); fork.dispose(); sql.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, fork, db, sql, ctx, podman, storage, members, users, project, stores, root };
}
const input = { project: { kind: 'managed', projectId: 7 }, accountUserId: 1 };

describe('durable managed environment lifecycle', () => {
  // A new project environment used to be pinned to the figures compiled into the plugin, with nowhere to
  // change them; the administrator's settings now decide what it is provisioned with.
  it('provisions a project environment with the administrator resource defaults', async () => {
    const { runtime, podman } = setup({ defaultCpus: 2.5, defaultMemoryMb: 4096, defaultPidsLimit: 1024, defaultDiskSoftMb: 20480 });
    const expected = { cpus: 2.5, memoryMb: 4096, pidsLimit: 1024, diskSoftMb: 20480 };
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
    expect((await runtime.environmentFor(input)).limits).toEqual({ cpus: 1, memoryMb: 4096, pidsLimit: 512, diskSoftMb: 10240 });
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
