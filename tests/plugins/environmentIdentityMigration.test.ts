import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import { createEnvironmentRuntime } from '../../plugins/sandbox/lib/environmentRuntime.mjs';
import { NspawnClient, UID_RANGE_SIZE, envelopePaths, unitFor } from '../../plugins/sandbox/lib/nspawn.mjs';
import { ContainerStorage } from '../../plugins/sandbox/lib/containerStorage.mjs';
import { PROJECT_ARTIFACT, SITE_ARTIFACTS, artifactReference } from '../../plugins/sandbox/lib/rootfsCatalog.mjs';

/** Moving an existing environment off a container-image tag and onto the artifact identity it should
 *  have carried, WITHOUT replacing a byte of its root filesystem.
 *
 *  Only the executor is faked. The real `NspawnClient`, the real `ContainerStorage` and the real
 *  environment runtime sit above it, so the disk record, the machine's identity record and the ownership
 *  proof under test are the shipped ones. The privileged side below models what the helper does with the
 *  request it is given — it writes the identity record from the request's OWN fields and it leaves the
 *  tree alone during an ownership pass — which is what makes "the fingerprint did not move" evidence
 *  rather than an assumption about a stub. */

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

const PROJECT_ROOTFS = artifactReference(PROJECT_ARTIFACT);
/** The reference the live production environment actually carries, read from the host. */
const LEGACY_PROJECT_IMAGE = 'localhost/elowen-project-base:5e0fbd26bb5339e7';
/** Its disk record's `sourceImageId`: bare hex, no `sha256:` prefix, exactly as the container runtime
 *  wrote it. The migration carries it across verbatim and never reinterprets it. */
const LEGACY_PROJECT_IMAGE_ID = '4af222d4cd5c6d49ac4b20717dde2601fe255289087453d41d60dabf65dfd691';
const LEGACY_SITE_IMAGE = 'localhost/elowen-site-static:8d1c0a7742f1b0c4';
const UID_BASE = 1077542912;

const verdict = (stdout = '', exitCode = 0) => ({ ok: true, exitCode, signal: null, timedOut: false,
  truncated: false, stdout: Buffer.from(stdout).toString('base64'), stderr: '' });
/** What `systemctl show` inside the guest says about a leased unit that settled and was collected. */
const COLLECTED = 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\n';

/** The same facts `DISK_TREE_FINGERPRINT_PY` hashes — path, kind, size, uid, gid, mode and mtime — plus
 *  the file's bytes, so a tree that was re-materialized from an artifact rather than kept cannot produce
 *  the same digest even if its metadata happened to line up. */
function fingerprintTree(root: string) {
  const hash = createHash('sha256');
  let logicalBytes = 0;
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      logicalBytes += stat.size;
      hash.update(JSON.stringify([relative(root, path), stat.isDirectory() ? 'directory' : 'file', stat.size,
        stat.uid, stat.gid, stat.mode & 0o7777, String(stat.mtimeMs)]));
      if (stat.isDirectory()) walk(path); else hash.update(readFileSync(path));
    }
  };
  walk(root);
  return { logicalBytes, allocatedBytes: logicalBytes, digest: hash.digest('hex') };
}

interface Call { file: string; args: string[]; request?: any }

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'env-identity-')));
  const configRoot = join(root, 'config');
  const sql = openDb(':memory:');
  const db = makePluginDb(sql, 'sandbox', { canMigrate: true });
  const project: any = { id: 62, slug: 'atlas', executionKind: 'managed', lifecycle: 'active', path: '/not-a-host-path' };
  const stores = {
    usersRead: { list: () => [{ id: 1 }, { id: 3 }], isAdmin: (id: number) => id === 3, mayUsePlugin: () => true },
    userProjects: { canAccess: () => true, canManage: () => true },
    projects: { get: (id: number) => (id === 62 ? project : null), list: () => [project], beginDeletion: () => true, finishDeletion: vi.fn(() => true) },
  };
  const ctx: any = { db: () => db, host: { stores: () => stores }, currentAccountUserId: () => null,
    currentAccess: () => ({ readOnly: false }), config: {}, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  initSandboxDb(ctx);

  const calls: Call[] = [];
  /** Every machine this host holds, as the manager reports it. Written only by `write-envelope`, so a
   *  specification no envelope was written for cannot pass its own ownership proof. */
  const machines = new Map<string, { unit: Record<string, string>; rootfs: string }>();
  /** Where a request's disk directory is, derived the way `nspawnDiskPaths` derives it in the privileged
   *  helper: from the trusted roots plus the validated resource and disk id, never from a path the request
   *  names. A restored generation therefore lands in its own directory without the test being told. */
  const diskDirectoryFor = (request: any) => join(request.kind === 'project'
    ? join(root, 'projects', request.resource) : join(root, 'sites', request.resource, 'environment'),
  'disks', request.diskId);

  const writeIdentity = (request: any, directory: string) => {
    mkdirSync(join(directory, '.elowen'), { recursive: true, mode: 0o750 });
    writeFileSync(join(directory, '.elowen', 'identity.json'), JSON.stringify({
      namespace: request.namespace, kind: request.kind, resource: request.resource, generation: request.generation,
      diskId: request.diskId, machine: request.machine, runtime: 'nspawn', specHash: request.specHash,
      uidBase: UID_BASE, uidSize: UID_RANGE_SIZE, updatedAt: new Date().toISOString(),
    }, null, 2), { mode: 0o640 });
  };

  const helper = async (request: any, input?: Buffer) => {
    if (request.op === 'status' || request.op === 'provision') {
      return { ok: true, ready: true, items: [{ id: 'unit:elowen-machine', label: 'Machine unit template', ok: true, detail: 'installed and loaded' }] };
    }
    if (request.op === 'write-envelope') {
      const envelope = envelopePaths(request.machine, configRoot);
      for (const path of Object.values(envelope)) mkdirSync(dirname(path), { recursive: true });
      writeFileSync(envelope.nspawn, `[Exec]\nPrivateUsers=${UID_BASE}:${UID_RANGE_SIZE}\n`, { mode: 0o644 });
      writeFileSync(envelope.dropIn, `[Service]\nCPUQuota=${request.limits.cpus * 100}%\n`, { mode: 0o644 });
      const directory = diskDirectoryFor(request);
      const rootfs = realpathSync(join(directory, 'rootfs'));
      writeIdentity(request, directory);
      machines.set(request.machine, { rootfs, unit: {
        LoadState: 'loaded',
        FragmentPath: join(configRoot, '/etc/systemd/system/elowen-machine@.service'),
        DropInPaths: envelope.dropIn,
        Environment: `ELOWEN_MACHINE_DIRECTORY=${rootfs}`,
        ActiveState: 'inactive', SubState: 'dead', FreezerState: 'running',
        MemoryMax: String(request.limits.memoryMb * 1024 * 1024), TasksMax: String(request.limits.pidsLimit),
        CPUQuotaPerSecUSec: request.limits.cpus === 1 ? '1s' : `${request.limits.cpus * 1000}ms`, Slice: 'machine.slice',
      } });
      return { ok: true };
    }
    if (request.op === 'shift-ownership') {
      // The real pass lchowns only where the ids actually differ, so a second pass over an in-range tree
      // changes nothing at all. Touching no file here is that case, which is the one this migration is in.
      writeIdentity(request, diskDirectoryFor(request));
      return { ok: true, uidBase: UID_BASE, uidSize: UID_RANGE_SIZE };
    }
    if (request.op === 'materialize') {
      mkdirSync(request.targetPath, { recursive: true, mode: 0o755 });
      writeFileSync(join(request.targetPath, 'materialized-from-artifact'), 'fresh');
      return { ok: true };
    }
    if (request.op === 'tree-fingerprint') return { ok: true, ...fingerprintTree(request.path) };
    // The same command the privileged helper runs, so a copied tree really does carry the source's own
    // ownership, modes and modification times — which is what makes a fingerprint comparison meaningful.
    if (request.op === 'tree-copy') { execFileSync('/bin/cp', ['-a', '--', `${request.sourcePath}/.`, `${request.targetPath}/`]); return { ok: true }; }
    if (request.op === 'tree-sync') return { ok: true };
    if (request.op === 'tree-remove') { rmSync(request.path, { recursive: true, force: true }); return { ok: true }; }
    if (request.op === 'tree-preflight') {
      const filesystem = statfsSync(request.destinationPath);
      return { ok: true, requiredBytes: 0, marginBytes: 0, freeBytes: filesystem.bavail * filesystem.bsize };
    }
    // A freeze is only a freeze once the manager reports the cgroup frozen, which is what the client
    // verifies; a stub that merely acknowledged it would let a snapshot run against a live guest.
    if (request.op === 'freeze') { machines.get(request.machine)!.unit.FreezerState = 'frozen'; return { ok: true }; }
    if (request.op === 'thaw') { machines.get(request.machine)!.unit.FreezerState = 'running'; return { ok: true }; }
    if (request.op === 'destroy') {
      // An envelope IS its two configuration files: removal is verified by their absence, not by a map.
      for (const path of Object.values(envelopePaths(request.machine, configRoot))) rmSync(path, { force: true });
      machines.delete(request.machine);
      return { ok: true };
    }
    if (request.op === 'exec') {
      // A leased guest unit settles and is collected, which is the release probe's proven-absence answer.
      if (request.argv?.[0] === '/usr/bin/systemctl') return verdict(request.argv.includes('show') ? COLLECTED : '');
      // The guest file helper answers the operation it was handed on stdin, so a caller cannot silently
      // be served a different kind than the one it asked for.
      if (request.argv?.[0] === '/usr/bin/python3' && input?.length) {
        const operation = JSON.parse(input.toString('utf8'));
        return verdict(JSON.stringify({ ok: true, result: { kind: operation.kind, entry: { path: operation.path, kind: 'directory', size: 0, modifiedAt: '2026-01-01T00:00:00Z', version: 'v0' } } }));
      }
      return verdict();
    }
    return { ok: true };
  };

  const executor = {
    run: vi.fn(async (file: string, argv: string[], options: any) => {
      const call: Call = { file, args: argv.slice() };
      calls.push(call);
      const reply = (code: number, stdout = '') => ({ code, stdout, stderr: '', truncated: false });
      const render = (record: Record<string, string>) => Object.entries(record).map(([key, value]) => `${key}=${value}`).join('\n');
      if (file === '/usr/bin/systemctl') {
        const machine = machines.get(String(argv[1] ?? '').replace(/^elowen-machine@|\.service$/g, ''));
        if (argv[0] === 'show') return reply(0, machine ? render(machine.unit) : '');
        if (argv[0] === 'start' && machine) { machine.unit.ActiveState = 'active'; machine.unit.SubState = 'running'; return reply(0); }
        if (argv[0] === 'stop' && machine) { machine.unit.ActiveState = 'inactive'; machine.unit.SubState = 'dead'; return reply(0); }
        return reply(0);
      }
      if (file === '/usr/bin/machinectl') {
        const machine = machines.get(String(argv[1] ?? ''));
        if (argv[0] === 'show') {
          if (!machine || machine.unit.ActiveState !== 'active') return reply(1, '');
          return reply(0, render({ Unit: unitFor(String(argv[1])), RootDirectory: machine.rootfs }));
        }
        if (argv[0] === 'list') {
          return reply(0, [...machines].filter(([, value]) => value.unit.ActiveState === 'active')
            .map(([name]) => `${name} container systemd-nspawn`).join('\n'));
        }
        return reply(0);
      }
      if (file === '/usr/bin/sudo') {
        const frame: Buffer = Buffer.isBuffer(options?.input) ? options.input : Buffer.from(String(options?.input ?? ''));
        const length = Number(frame.subarray(0, 8).toString('latin1'));
        const request = JSON.parse(frame.subarray(9, 9 + length).toString('utf8'));
        call.request = request;
        return reply(0, JSON.stringify(await helper(request, frame.subarray(9 + length))));
      }
      return reply(0);
    }),
  };

  const artifacts = { status: vi.fn(() => ({ published: true, present: true, digest: `sha256:${'a'.repeat(64)}`, sizeBytes: 1024 })),
    ensure: vi.fn(async () => ({ path: join(root, 'blob.tar.gz'), digest: `sha256:${'a'.repeat(64)}` })), collect: vi.fn(() => []) };
  const nspawn = new NspawnClient({ executor: executor as never, artifacts, configRoot, namespace: 'elowen' });
  const storage = new ContainerStorage(nspawn);
  const runtime = createEnvironmentRuntime({ ctx, db, dataDir: root, nspawn, storage, daemon: true });
  cleanup.push(() => { runtime.dispose(); sql.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, db, sql, ctx, root, calls, executor, artifacts, nspawn, storage, project,
    machines, helperOps: () => calls.filter((call) => call.request).map((call) => call.request.op) };
}

type Harness = ReturnType<typeof setup>;

const projectInput = { project: { kind: 'managed', projectId: 62 }, accountUserId: 1 } as const;
const adminInput = { project: { kind: 'managed', projectId: 62 }, accountUserId: 3 } as const;

const storedSpec = (state: Harness, kind = 'project', id = '62') =>
  JSON.parse((state.db.prepare('SELECT spec_json FROM p_sandbox_runtimes WHERE kind=? AND resource_id=?').get(kind, id) as { spec_json: string }).spec_json);
const writeSpec = (state: Harness, spec: unknown, kind = 'project', id = '62') =>
  state.db.prepare('UPDATE p_sandbox_runtimes SET spec_json=? WHERE kind=? AND resource_id=?').run(JSON.stringify(spec), kind, id);
const diskRecord = (spec: any) => JSON.parse(readFileSync(join(dirname(spec.input.disk.rootfsPath), 'disk.json'), 'utf8'));
const identityRecord = (spec: any) => JSON.parse(readFileSync(join(dirname(spec.input.disk.rootfsPath), '.elowen', 'identity.json'), 'utf8'));

/** Replace the random disk id with the one the live environment actually carries, everywhere the disk
 *  record names it. `createContainerSpec` re-derives the layout from the id and refuses a record whose
 *  paths do not match, so a wrong substitution fails loudly rather than producing a plausible fixture. */
function withDiskId(disk: any, diskId: string) {
  const replaced = JSON.parse(JSON.stringify(disk).split(disk.id).join(diskId));
  return { ...replaced, id: diskId };
}

/** An environment as the container runtime left it: a real root filesystem with the user's own files in
 *  it, a disk record naming the container image tag, and a machine whose identity record was written from
 *  that same specification. Nothing here is a shortcut — the start below runs the shipped path. */
async function legacyProject(state: Harness, { diskId, image = LEGACY_PROJECT_IMAGE }: { diskId?: string; image?: string } = {}) {
  await state.runtime.requestEnvironment({ ...projectInput, requestId: 'seed', action: { kind: 'start' } });
  const spec = storedSpec(state);
  spec.input.image = image;
  spec.input.disk.sourceImage = image;
  if (diskId) spec.input.disk = withDiskId(spec.input.disk, diskId);
  writeSpec(state, spec);

  const disk = spec.input.disk;
  mkdirSync(disk.rootfsPath, { recursive: true, mode: 0o755 });
  mkdirSync(join(disk.rootfsPath, 'etc'), { recursive: true });
  // The user's own packages and configuration, which is the whole reason the bytes may not be replaced.
  writeFileSync(join(disk.rootfsPath, 'etc', 'installed-by-the-user'), 'postgresql-16\n');
  for (const component of disk.components) {
    mkdirSync(component.path, { recursive: true });
    writeFileSync(join(component.path, 'user-data'), `${component.component} payload\n`);
  }
  writeFileSync(join(dirname(disk.rootfsPath), 'disk.json'), JSON.stringify({
    resource: spec.input.resource, diskId: disk.id, format: 2, sourceImage: image, sourceImageId: LEGACY_PROJECT_IMAGE_ID,
    rootfsPath: disk.rootfsPath, components: disk.components, createdAt: '2026-01-01T00:00:00.000Z', materialized: true,
  }));
  await state.runtime.reconcile();
  const started = await state.runtime.environmentFor(projectInput);
  expect(started.state, String(started.lastError)).toBe('running');
  return storedSpec(state);
}

async function migrate(state: Harness, requestId: string, action: Record<string, unknown> = {}) {
  const op = await state.runtime.requestEnvironment({ ...adminInput, requestId, action: { kind: 'migrate-identity', ...action } });
  await state.runtime.reconcile();
  return await state.runtime.environmentOperation({ operationId: op.id, accountUserId: 3 });
}

describe('environment identity migration', () => {
  it('moves the row, the disk record and the machine identity without replacing a byte of the root filesystem', async () => {
    const state = setup();
    const before = await legacyProject(state);
    const rootfsBefore = fingerprintTree(before.input.disk.rootfsPath);
    const componentsBefore = before.input.disk.components.map((entry: any) => fingerprintTree(entry.path));
    state.artifacts.ensure.mockClear();
    const materializeBefore = state.helperOps().filter((op) => op === 'materialize').length;

    const completed = await migrate(state, 'migrate-1');
    expect(completed, JSON.stringify(completed)).toMatchObject({ status: 'succeeded' });

    const after = storedSpec(state);
    expect(after.input.image).toBe(PROJECT_ROOTFS);
    expect(after.input.disk.sourceImage).toBe(PROJECT_ROOTFS);
    // The immutable envelope identity never moves: it is hashed from the namespace, the machine, the disk
    // id, the root filesystem path and the two envelope files, and none of those changed.
    expect(after.containerId).toBe(before.containerId);
    expect(after.input.disk.id).toBe(before.input.disk.id);
    expect(after.input.generation).toBe(before.input.generation);

    expect(diskRecord(after)).toMatchObject({ sourceImage: PROJECT_ROOTFS, sourceImageId: null,
      adoptedFrom: { reference: LEGACY_PROJECT_IMAGE, imageId: LEGACY_PROJECT_IMAGE_ID } });
    expect(Object.hasOwn(diskRecord(after), 'sourceImageId')).toBe(true);
    expect(typeof diskRecord(after).adoptedFrom.migratedAt).toBe('string');
    // The disk record is a shadow of the row and never carries the adoption history into the hashed spec.
    expect(after.input.disk.adoptedFrom).toBeUndefined();

    expect(fingerprintTree(after.input.disk.rootfsPath)).toEqual(rootfsBefore);
    expect(after.input.disk.components.map((entry: any) => fingerprintTree(entry.path))).toEqual(componentsBefore);
    // Nothing fetched or unpacked an artifact: the bytes on the disk are the ones that were already there.
    expect(state.artifacts.ensure).not.toHaveBeenCalled();
    expect(state.helperOps().filter((op) => op === 'materialize').length).toBe(materializeBefore);
  });

  it('rolls the row, the disk record and the identity back to the legacy reference when the proof fails', async () => {
    const state = setup();
    const before = await legacyProject(state);
    const legacyIdentity = identityRecord(before).specHash;
    // The proof re-fingerprints the trees. A component that changed under it is exactly the failure this
    // stage exists to catch, and it must leave the environment on the reference it started from.
    const componentPath = before.input.disk.components[0].path;
    const originalFingerprint = state.nspawn.fingerprintDiskTree.bind(state.nspawn);
    let passes = 0;
    (state.nspawn as any).fingerprintDiskTree = async (path: string) => {
      const value = await originalFingerprint(path);
      if (path === componentPath && ++passes > 1) return { ...value, digest: 'f'.repeat(64) };
      return value;
    };

    const completed = await migrate(state, 'migrate-rollback');
    expect(completed).toMatchObject({ status: 'failed' });
    (state.nspawn as any).fingerprintDiskTree = originalFingerprint;

    const after = storedSpec(state);
    expect(after.input.image).toBe(LEGACY_PROJECT_IMAGE);
    expect(after.input.disk.sourceImage).toBe(LEGACY_PROJECT_IMAGE);
    expect(diskRecord(after)).toMatchObject({ sourceImage: LEGACY_PROJECT_IMAGE, sourceImageId: LEGACY_PROJECT_IMAGE_ID });
    expect(diskRecord(after).adoptedFrom).toBeUndefined();
    expect(identityRecord(after).specHash).toBe(legacyIdentity);

    await state.runtime.requestEnvironment({ ...projectInput, requestId: 'after-rollback', action: { kind: 'start' } });
    await state.runtime.reconcile();
    expect((await state.runtime.environmentFor(projectInput)).state).toBe('running');
  });

  it('resumes an interrupted migration without a second snapshot and without moving anything twice', async () => {
    const state = setup();
    const before = await legacyProject(state);
    const rootfsBefore = fingerprintTree(before.input.disk.rootfsPath);
    // The pass is cut short at the ownership shift, which runs AFTER the row moved and after the disk
    // record was rewritten — so what the first pass wrote is captured here, while it is still on disk.
    const originalShift = state.nspawn.shiftOwnership.bind(state.nspawn);
    let shifts = 0;
    let interruptedRecord: unknown;
    (state.nspawn as any).shiftOwnership = async (spec: any) => {
      shifts += 1;
      if (shifts === 1) { interruptedRecord = diskRecord(storedSpec(state)); throw new Error('interrupted after restamp'); }
      return await originalShift(spec);
    };

    const interrupted = await migrate(state, 'migrate-resume');
    expect(interrupted).toMatchObject({ status: 'failed' });
    expect(interruptedRecord).toMatchObject({ sourceImage: PROJECT_ROOTFS, sourceImageId: null });

    const snapshotsAfterFirst = state.db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_runtime_snapshots').get() as { n: number };
    const shiftsAfterFirst = shifts;

    const resumed = await migrate(state, 'migrate-resume');
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ status: 'succeeded' });
    // No second restore point: the snapshot the operation already took is the one it resumes with.
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_runtime_snapshots').get()).toEqual(snapshotsAfterFirst);
    expect(shifts).toBeGreaterThan(shiftsAfterFirst);

    const after = storedSpec(state);
    expect(after.input.disk.sourceImage).toBe(PROJECT_ROOTFS);
    expect(after.containerId).toBe(before.containerId);
    expect(fingerprintTree(after.input.disk.rootfsPath)).toEqual(rootfsBefore);
    // Byte for byte what the interrupted pass wrote. A `migratedAt` taken from a clock rather than from
    // the durable checkpoint would differ here, and would differ again inside every later restore's
    // ownership comparison — which strips only `createdAt` and fails the operation on anything else.
    expect(diskRecord(after)).toEqual(interruptedRecord);
  });

  it('succeeds and changes nothing on a row that already carries the canonical reference', async () => {
    const state = setup();
    await legacyProject(state);
    expect(await migrate(state, 'migrate-first')).toMatchObject({ status: 'succeeded' });
    const settled = storedSpec(state);
    const record = diskRecord(settled);
    const identity = identityRecord(settled);
    const fingerprint = fingerprintTree(settled.input.disk.rootfsPath);

    expect(await migrate(state, 'migrate-again')).toMatchObject({ status: 'succeeded' });
    const again = storedSpec(state);
    expect(again).toEqual(settled);
    expect(diskRecord(again)).toEqual(record);
    expect(identityRecord(again).specHash).toBe(identity.specHash);
    expect(fingerprintTree(again.input.disk.rootfsPath)).toEqual(fingerprint);
    // A no-op migration takes no restore point: there is nothing to restore to.
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_runtime_snapshots').get()).toEqual({ n: 1 });
  });

  it('keeps a pre-migration snapshot restorable and stamps a post-migration snapshot with the canonical reference', async () => {
    const state = setup();
    await legacyProject(state);
    const capture = await state.runtime.requestEnvironment({ ...projectInput, requestId: 'pre-snapshot', action: { kind: 'snapshot' } });
    await state.runtime.reconcile();
    const pre = await state.runtime.environmentOperation({ operationId: capture.id, accountUserId: 1 });
    expect(pre).toMatchObject({ status: 'succeeded' });

    expect(await migrate(state, 'migrate-snapshots')).toMatchObject({ status: 'succeeded' });

    const later = await state.runtime.requestEnvironment({ ...projectInput, requestId: 'post-snapshot', action: { kind: 'snapshot' } });
    await state.runtime.reconcile();
    const post = await state.runtime.environmentOperation({ operationId: later.id, accountUserId: 1 });
    expect(post, JSON.stringify(post)).toMatchObject({ status: 'succeeded' });
    const postManifest = JSON.parse((state.db.prepare('SELECT manifest_json FROM p_sandbox_runtime_snapshots WHERE id=?').get(post!.snapshotId) as any).manifest_json);
    expect(postManifest.sourceImage).toEqual({ reference: PROJECT_ROOTFS, id: null });

    const restore = await state.runtime.requestEnvironment({ ...projectInput, requestId: 'restore-pre', action: { kind: 'restore', snapshotId: pre!.snapshotId } });
    await state.runtime.reconcile();
    const restored = await state.runtime.environmentOperation({ operationId: restore.id, accountUserId: 1 });
    expect(restored, JSON.stringify(restored)).toMatchObject({ status: 'succeeded' });

    // The restored generation keeps the canonical identity: a retained pre-migration snapshot must not be
    // able to put a legacy reference back on a row that has already moved.
    const after = storedSpec(state);
    expect(after.input.image).toBe(PROJECT_ROOTFS);
    expect(after.input.disk.sourceImage).toBe(PROJECT_ROOTFS);
    expect(diskRecord(after)).toMatchObject({ sourceImage: PROJECT_ROOTFS, sourceImageId: null,
      adoptedFrom: { reference: LEGACY_PROJECT_IMAGE, imageId: LEGACY_PROJECT_IMAGE_ID, snapshotId: expect.any(String) } });
    expect((await state.runtime.environmentFor(projectInput)).state).toBe('running');
  });

  it('keeps a migrated environment startable, executable and deletable', async () => {
    const state = setup();
    await legacyProject(state);
    expect(await migrate(state, 'migrate-usable')).toMatchObject({ status: 'succeeded' });

    await state.runtime.requestEnvironment({ ...projectInput, requestId: 'usable-stop', action: { kind: 'stop' } });
    await state.runtime.reconcile();
    expect((await state.runtime.environmentFor(projectInput)).state).toBe('stopped');
    await state.runtime.requestEnvironment({ ...projectInput, requestId: 'usable-start', action: { kind: 'start' } });
    await state.runtime.reconcile();
    expect((await state.runtime.environmentFor(projectInput)).state).toBe('running');

    const result = await state.runtime.projectFiles({ ...projectInput, operation: { kind: 'stat', path: '/atlas' } });
    expect(result).toBeDefined();

    // A recreate is the one ordinary path that rebuilds a lost envelope, and it is where the disk record
    // is read and held against the specification again. A migration that moved the row without moving the
    // record leaves an environment that looks fine until exactly this repair, and then cannot start at all.
    await state.runtime.requestEnvironment({ ...adminInput, requestId: 'usable-recreate', action: { kind: 'recreate' } });
    await state.runtime.reconcile();
    const repaired = await state.runtime.environmentFor(projectInput);
    expect(repaired.state, String(repaired.lastError)).toBe('running');
    expect(storedSpec(state).input.disk.sourceImage).toBe(PROJECT_ROOTFS);

    await state.runtime.requestEnvironment({ ...projectInput, requestId: 'usable-delete', action: { kind: 'delete' } });
    await state.runtime.reconcile();
    expect(state.db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_runtimes WHERE kind='project'").get()).toEqual({ n: 0 });
  });

  it('refuses the ownership proof for an identity record still carrying the pre-migration hash', async () => {
    const state = setup();
    const before = await legacyProject(state);
    const legacy = identityRecord(before);
    expect(await migrate(state, 'migrate-identity-proof')).toMatchObject({ status: 'succeeded' });

    const after = storedSpec(state);
    const path = join(dirname(after.input.disk.rootfsPath), '.elowen', 'identity.json');
    const current = JSON.parse(readFileSync(path, 'utf8'));
    expect(current.specHash).not.toBe(legacy.specHash);

    writeFileSync(path, JSON.stringify({ ...current, specHash: legacy.specHash }, null, 2), { mode: 0o640 });
    await expect(state.runtime.projectFiles({ ...projectInput, operation: { kind: 'stat', path: '/atlas' } }))
      .rejects.toThrow(/identity\.specHash/);
  });

  it('refuses a legacy row that never became an nspawn disk', async () => {
    const state = setup();
    await state.runtime.requestEnvironment({ ...projectInput, requestId: 'never-started', action: { kind: 'start' } });
    const spec = storedSpec(state);
    delete spec.input.disk;
    delete spec.runtimePending;
    spec.input.image = LEGACY_PROJECT_IMAGE;
    writeSpec(state, spec);
    state.db.prepare("UPDATE p_sandbox_runtimes SET state='stopped', desired_state='stopped' WHERE kind='project'").run();
    state.db.prepare("DELETE FROM p_sandbox_runtime_operations").run();

    const completed = await migrate(state, 'migrate-no-disk');
    expect(completed).toMatchObject({ status: 'failed' });
    expect(completed!.error).toMatch(/nspawn disk/);
    expect(storedSpec(state).input.image).toBe(LEGACY_PROJECT_IMAGE);
  });

  it('requires a current administrator at request and again at dispatch', async () => {
    const state = setup();
    await legacyProject(state);
    await expect(state.runtime.requestEnvironment({ ...projectInput, requestId: 'not-admin', action: { kind: 'migrate-identity' } }))
      .rejects.toMatchObject({ code: 'admin_required', status: 403 });

    const op = await state.runtime.requestEnvironment({ ...adminInput, requestId: 'revoked', action: { kind: 'migrate-identity' } });
    state.ctx.host.stores().usersRead.isAdmin = () => false;
    await state.runtime.reconcile();
    const completed = await state.runtime.environmentOperation({ operationId: op.id, accountUserId: 3 });
    expect(completed).toMatchObject({ status: 'failed' });
    expect(completed!.error).toMatch(/administrator/i);
    expect(storedSpec(state).input.disk.sourceImage).toBe(LEGACY_PROJECT_IMAGE);
  });

  it('reports the pending legacy reference count in the machine runtime readiness rows', async () => {
    const state = setup();
    await legacyProject(state);
    // Taken BEFORE the migration, so it names the container image tag. Retained snapshots live
    // indefinitely, so restoring one of them is the standing way the count could climb back.
    const capture = await state.runtime.requestEnvironment({ ...projectInput, requestId: 'readiness-snapshot', action: { kind: 'snapshot' } });
    await state.runtime.reconcile();
    const saved = await state.runtime.environmentOperation({ operationId: capture.id, accountUserId: 1 });

    const pending = await state.runtime.machineRuntimeReadiness({ accountUserId: 3 });
    const row = pending.items.find((item: any) => item.id === 'runtime:legacy-references');
    expect(row).toMatchObject({ ok: false });
    expect(row.detail).toMatch(/1/);
    expect(row.detail).toMatch(/migrate-identity/);

    expect(await migrate(state, 'migrate-readiness')).toMatchObject({ status: 'succeeded' });
    const settled = await state.runtime.machineRuntimeReadiness({ accountUserId: 3 });
    expect(settled.items.find((item: any) => item.id === 'runtime:legacy-references')).toMatchObject({ ok: true });

    const restore = await state.runtime.requestEnvironment({ ...projectInput, requestId: 'readiness-restore', action: { kind: 'restore', snapshotId: saved!.snapshotId } });
    await state.runtime.reconcile();
    expect(await state.runtime.environmentOperation({ operationId: restore.id, accountUserId: 1 })).toMatchObject({ status: 'succeeded' });

    const afterRestore = await state.runtime.machineRuntimeReadiness({ accountUserId: 3 });
    expect(afterRestore.items.find((item: any) => item.id === 'runtime:legacy-references')).toMatchObject({ ok: true });
  });

  /** The production environment, from the identity record read off the live host. */
  it('migrates the live production environment shape and moves only its specification hash', async () => {
    const state = setup();
    const before = await legacyProject(state, { diskId: '049968a5361d40329c41c65b8b735113' });
    const identityBefore = identityRecord(before);
    expect(identityBefore).toMatchObject({ namespace: 'elowen', kind: 'project', resource: '62', generation: 1,
      diskId: '049968a5361d40329c41c65b8b735113', machine: 'elowen-project-62-g1', runtime: 'nspawn',
      uidBase: 1077542912, uidSize: 65536 });

    expect(await migrate(state, 'migrate-production')).toMatchObject({ status: 'succeeded' });

    const after = storedSpec(state);
    const identityAfter = identityRecord(after);
    expect(identityAfter.specHash).not.toBe(identityBefore.specHash);
    for (const key of ['namespace', 'kind', 'resource', 'generation', 'diskId', 'machine', 'runtime', 'uidBase', 'uidSize']) {
      expect(identityAfter[key], key).toEqual(identityBefore[key]);
    }
    expect(after.containerId).toBe(before.containerId);
    expect(after.input.disk.id).toBe('049968a5361d40329c41c65b8b735113');
    expect(diskRecord(after)).toMatchObject({ sourceImage: PROJECT_ROOTFS, sourceImageId: null,
      adoptedFrom: { reference: LEGACY_PROJECT_IMAGE, imageId: LEGACY_PROJECT_IMAGE_ID } });
  });
});

describe('site identity migration', () => {
  async function legacySite(state: Harness) {
    const registration: any = { siteId: 'shop', projectId: 62, image: LEGACY_SITE_IMAGE, network: 'shared',
      workspaceReadOnly: true, persistentRootfs: true, sitesDataDir: join(state.root, 'sites'),
      sourcePath: join(state.root, 'sources', 'shop'), brokerDir: join(state.root, 'brokers'),
      limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 } };
    mkdirSync(registration.sourcePath, { recursive: true });
    mkdirSync(registration.brokerDir, { recursive: true });
    state.runtime.connectSitesRuntime({ resolve: async () => registration, beforeStart: async () => {}, afterStop: async () => {} });
    await state.runtime.registerSiteEnvironment({ siteId: 'shop', accountUserId: 1 });
    await state.runtime.requestSiteEnvironment({ siteId: 'shop', accountUserId: 1, requestId: 'site-seed', action: { kind: 'start' } });
    const spec = storedSpec(state, 'site', 'shop');
    const disk = spec.input.disk;
    mkdirSync(disk.rootfsPath, { recursive: true, mode: 0o755 });
    writeFileSync(join(disk.rootfsPath, 'site-content'), 'index.html\n');
    for (const component of disk.components) mkdirSync(component.path, { recursive: true });
    // The Sites envelope binds a read-only git stub over one path inside the workspace, and the bind
    // source for `/workspace/.git` has to be a FILE.
    mkdirSync(join(state.root, 'sites', 'shop', 'environment'), { recursive: true });
    writeFileSync(join(state.root, 'sites', 'shop', 'environment', 'git-stub'), 'gitdir: /dev/null\n');
    writeFileSync(join(dirname(disk.rootfsPath), 'disk.json'), JSON.stringify({
      resource: spec.input.resource, diskId: disk.id, format: 2, sourceImage: LEGACY_SITE_IMAGE,
      sourceImageId: LEGACY_PROJECT_IMAGE_ID, rootfsPath: disk.rootfsPath, components: disk.components,
      createdAt: '2026-01-01T00:00:00.000Z', materialized: true }));
    await state.runtime.reconcile();
    return storedSpec(state, 'site', 'shop');
  }

  it('moves a Site onto the artifact its fixed recipe names and keeps its release pin canonical', async () => {
    const state = setup();
    const before = await legacySite(state);
    const rootfsBefore = fingerprintTree(before.input.disk.rootfsPath);

    const op = await state.runtime.requestSiteEnvironment({ siteId: 'shop', accountUserId: 3, requestId: 'site-migrate',
      action: { kind: 'migrate-identity', imageKind: 'static' } });
    await state.runtime.reconcile();
    const completed = await state.runtime.siteEnvironmentOperation({ operationId: op.id, accountUserId: 3 });
    expect(completed, JSON.stringify(completed)).toMatchObject({ status: 'succeeded' });

    const after = storedSpec(state, 'site', 'shop');
    const canonical = artifactReference(SITE_ARTIFACTS.static);
    expect(after.input.disk.sourceImage).toBe(canonical);
    expect(after.input.image).toBe(canonical);
    expect(after.containerId).toBe(before.containerId);
    expect(fingerprintTree(after.input.disk.rootfsPath)).toEqual(rootfsBefore);

    const capture = await state.runtime.requestSiteEnvironment({ siteId: 'shop', accountUserId: 1, requestId: 'site-release', action: { kind: 'snapshot' } });
    await state.runtime.reconcile();
    const release = await state.runtime.siteEnvironmentOperation({ operationId: capture.id, accountUserId: 1 });
    expect(release, JSON.stringify(release)).toMatchObject({ status: 'succeeded' });
    const manifest = JSON.parse((state.db.prepare('SELECT manifest_json FROM p_sandbox_runtime_snapshots WHERE id=?').get(release!.snapshotId) as any).manifest_json);
    expect(manifest.sourceImage).toEqual({ reference: canonical, id: null });
  });
});
