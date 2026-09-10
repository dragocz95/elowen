import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { PROJECT_BASE_IMAGE_TAG, PROJECT_CONTAINERFILE } from '../../plugins/sandbox/lib/containerBaseImage.mjs';
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
  const project: any = { id: 7, slug: 'sales-dashboard', executionKind: 'managed', lifecycle: 'active', path: '/not-a-host-path' };
  const stores = { usersRead: { list: () => [...users].map((id) => ({ id })), isAdmin: (id: number) => id === 3, mayUsePlugin: () => true },
    userProjects: { canAccess: (id: number) => project.lifecycle === 'active' && (members.has(id) || id === 3), canManage: (id: number) => members.has(id) || id === 3 },
    projects: { get: (id: number) => id === 7 ? project : null, list: () => [project], beginDeletion: () => { project.lifecycle = 'deleting'; return true; }, finishDeletion: vi.fn(() => true) } };
  const warn = vi.fn();
  const ctx: any = { db: () => db, host: { stores: () => stores }, currentAccountUserId: () => null, currentAccess: () => ({ readOnly: false }), config, logger: { info: vi.fn(), warn, error: vi.fn() } };
  initSandboxDb(ctx);
  const containers = new Map<string, any>();
  const podman = { ensureProjectImage: vi.fn(async () => 'localhost/elowen-project-base:test'),
    inspect: vi.fn(async (spec: any) => containers.get(spec.name) ?? null), inspectBinding: vi.fn(async (spec: any) => containers.get(spec.name)),
    create: vi.fn(async (spec: any) => { const row = { id: 'a'.repeat(64), state: 'created' }; containers.set(spec.name, row); return row; }),
    start: vi.fn(async (spec: any) => { containers.get(spec.name).state = 'running'; }),
    stop: vi.fn(async (spec: any) => { containers.get(spec.name).state = 'stopped'; }),
    remove: vi.fn(async (spec: any) => { containers.delete(spec.name); }),
    exec: vi.fn(async () => ({ code: 0, stdout: '', stderr: '', truncated: false })),
    // A start waits for the guest system bus before anything runs through `systemd-run`.
    waitForSystemBus: vi.fn(async () => {}),
    cancelExecution: vi.fn(async () => ({ terminated: true })), releaseExecution: vi.fn(),
    prepareExecution: vi.fn(async () => ({ launch: { type: 'argv', file: '/usr/bin/podman', args: ['exec', 'owned'], env: { HOME: '/host-service' } } })),
    removeVolume: vi.fn(), removeStorage: vi.fn(), inspectVolume: vi.fn(),
    containerExists: vi.fn(async (spec: any) => containers.has(spec.name)),
  };
  const storage = { prepare: vi.fn(), snapshot: vi.fn(), readSnapshot: vi.fn(), restoreVolumes: vi.fn() };
  const dependencies = { ctx, db, dataDir: root, podman: podman as unknown as PodmanClient, storage: storage as unknown as ContainerStorage };
  const runtime = createEnvironmentRuntime({ ...dependencies, daemon: true });
  const fork = createEnvironmentRuntime({ ...dependencies, daemon: false });
  cleanup.push(() => { runtime.dispose(); fork.dispose(); sql.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, fork, db, sql, ctx, podman, storage, members, users, project, stores, root, containers, warn };
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

  // A new project environment used to be pinned to the figures compiled into the plugin, with nowhere to
  // change them; the administrator's settings now decide what it is provisioned with.
  it('provisions a project environment with the administrator resource defaults', async () => {
    const { runtime, podman } = setup({ defaultCpus: 2.5, defaultMemoryMb: 4096, defaultPidsLimit: 1024 });
    // The disk figure is not an administrator setting: nothing enforces it, so it keeps the built-in
    // value the Sites contract still carries.
    const expected = { cpus: 2.5, memoryMb: 4096, pidsLimit: 1024, diskSoftMb: 10240 };
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
