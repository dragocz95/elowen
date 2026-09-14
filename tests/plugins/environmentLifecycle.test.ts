import { lstatSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { PROJECT_ARTIFACT, ROOTFS_RECIPES, artifactReference } from '../../plugins/sandbox/lib/rootfsCatalog.mjs';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import { environmentPublicationMigration } from '../../plugins/sandbox/lib/environmentDb.mjs';
import { createEnvironmentRuntime, publicationSocketName } from '../../plugins/sandbox/lib/environmentRuntime.mjs';
import type { NspawnClient } from '../../plugins/sandbox/lib/nspawn.mjs';
import type { ContainerStorage } from '../../plugins/sandbox/lib/containerStorage.mjs';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
/** The published root filesystem a NEW managed project is stamped with, in both the envelope image and
 *  the disk's source. Nothing on the host produces it: it is fetched by reference and verified by digest. */
const PROJECT_ROOTFS = artifactReference(PROJECT_ARTIFACT);
/** `machineHost` answers the readiness probe the way a provisioned or an unprovisioned host answers it,
 *  which is where production makes the decision. There is no third world any more: every environment is a
 *  machine on a disk materialized from a published artifact, so `'ready'` is what almost every test below
 *  needs and a host that answers `'unready'` refuses the creation rather than building something else. */
function setup(config: Record<string, unknown> = {}, machineHost: 'ready' | 'unready' = 'ready') {
  const root = mkdtempSync(join(tmpdir(), 'env-test-'));
  const sql = openDb(':memory:');
  const db = makePluginDb(sql, 'sandbox', { canMigrate: true });
  const users = new Set([1, 2, 3]);
  const members = new Set([1, 2]);
  const project: any = { id: 7, slug: 'sales-dashboard', executionKind: 'managed', lifecycle: 'active', path: '/not-a-host-path' };
  const stores = { usersRead: { list: () => [...users].map((id) => ({ id })), isAdmin: (id: number) => id === 3, mayUsePlugin: () => true },
    userProjects: { canAccess: (id: number) => project.lifecycle === 'active' && (members.has(id) || id === 3), canManage: (id: number) => members.has(id) || id === 3 },
    projects: { get: (id: number) => id === 7 ? project : null, list: () => [project], beginDeletion: () => { project.lifecycle = 'deleting'; return true; }, finishDeletion: vi.fn(() => { project.lifecycle = 'deleted'; return true; }) } };
  const warn = vi.fn();
  const ctx: any = { db: () => db, host: { stores: () => stores }, currentAccountUserId: () => null, currentAccess: () => ({ readOnly: false }), config, logger: { info: vi.fn(), warn, error: vi.fn() } };
  initSandboxDb(ctx);
  const containers = new Map<string, any>();
  const diskFiles = new Map<string, Map<string, string>>();
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
  /** The machine runtime, and the only one there is. Its refusals are the real client's refusals: an
   *  nspawn environment holds no image and no named volume handle, so those methods reject rather than
   *  quietly agreeing — a fake that accepted them would hide every caller still routing work to a
   *  capability this release does not have. */
  const nspawn = {
    ensureProjectImage: vi.fn(async () => { throw new Error('Nothing builds a root filesystem on the host'); }),
    retireLegacySiteMachine: vi.fn(async (spec: any) => ({ retired: true, machine: `elowen-site-${spec.input.resource.id}-g${spec.input.generation}` })),
    containerInventory: vi.fn(async () => new Map([...containers].map(([name, row]) => [name, row.state]))),
    inspect: vi.fn(async (spec: any) => containers.get(spec.name) ?? null), inspectBinding: vi.fn(async (spec: any) => containers.get(spec.name)),
    // Ownership from the files this runtime owns, without the state read `inspect` makes: a name the
    // inventory reports UP is only adopted when the envelope and the disk identity are provably this
    // environment's, and the fake refuses a name it does not hold exactly as the real client does.
    proveOwnership: vi.fn(async (spec: any) => {
      const row = containers.get(spec.name);
      if (!row) throw new Error('No machine envelope of this name exists on this host');
      return { id: row.id };
    }),
    create: vi.fn(async (spec: any) => {
      if (spec.expectedId) throw new Error('An immutable container binding cannot be recreated');
      if (!spec.disk || spec.disk.runtime !== 'nspawn') throw new Error('systemd-nspawn runs only rootfs-backed environments');
      // The disk outlives the envelope, so an envelope written over one that already exists finds
      // everything the last one left there.
      diskFiles.set(spec.disk.id, diskFiles.get(spec.disk.id) ?? new Map());
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
    removeByName: vi.fn(async (spec: any) => { containers.delete(spec.name); }),
    removeStorage: vi.fn(), removeGenerationStorage: vi.fn(), removeSnapshotStorage: vi.fn(),
    removeDiskPath: vi.fn(), syncDiskTree: vi.fn(),
    // Keyed by disk id: what a guest writes lands on the DISK, which is the whole reason an envelope can
    // be thrown away and rebuilt without the environment losing anything.
    exec: vi.fn(async (spec: any, _executionId: string, _argv: string[], options: any = {}) => {
      const input = String(options.input ?? '');
      if (spec.disk && input.includes('/etc/elowen-rootfs-marker')) diskFiles.get(spec.disk.id)?.set('/etc/elowen-rootfs-marker', 'marker');
      const write = /elowen-guest-write:([^\s]+):([^\s]+)/.exec(input);
      if (write && spec.disk) diskFiles.get(spec.disk.id)?.set(write[1], write[2]);
      const read = /elowen-guest-read:([^\s]+)/.exec(input);
      if (read && spec.disk) return { code: 0, stdout: diskFiles.get(spec.disk.id)?.get(read[1]) ?? '', stderr: '', truncated: false };
      return { code: 0, stdout: '', stderr: '', truncated: false };
    }),
    // A start waits for the guest system bus before anything runs through `systemd-run`.
    waitForSystemBus: vi.fn(async () => {}),
    systemRunning: vi.fn(async () => 'running'),
    normalizeRootfs: vi.fn(async () => ({ changed: false, enabled: ['systemd-networkd.service', 'systemd-networkd.socket'] })),
    networkReadiness: vi.fn(async () => ({ ready: true, carrier: true, addresses: ['10.0.0.7'] })),
    waitForNetwork: vi.fn(async () => ({ ready: true, carrier: true, addresses: ['10.0.0.7'] })),
    pause: vi.fn(async (spec: any) => { containers.get(spec.name).state = 'paused'; }),
    unpause: vi.fn(async (spec: any) => { containers.get(spec.name).state = 'running'; }),
    cancelExecution: vi.fn(async () => ({ terminated: true })), releaseExecution: vi.fn(), startPreview: vi.fn(),
    // The real client owns what goes on the launcher's stdin and hands it back: the privileged request
    // travels ahead of the caller's own bytes in the same pipe. A fake that dropped the field would let
    // the runtime stop forwarding it without a test noticing.
    prepareExecution: vi.fn(async (_spec: any, _executionId: string, _argv: string[], options: any = {}) => ({
      launch: { type: 'argv', file: '/usr/bin/sudo', args: ['-n', '/usr/local/libexec/elowen-site-gateway', ''], env: { HOME: '/host-service' } }, stdin: options.input })),
    // Every capability a machine environment does NOT have, refused the way the real client refuses it.
    // Silently accepting one would hide a caller that still routes work to an image store or a named
    // volume handle, which is exactly the drift these refusals exist to catch.
    removeVolume: vi.fn(async () => { throw new Error('An nspawn environment has no named volumes'); }),
    inspectVolume: vi.fn(async () => { throw new Error('An nspawn environment has no named volumes'); }),
    importSnapshotVolume: vi.fn(async () => { throw new Error('An nspawn environment has no named volumes'); }),
    removeSnapshotImage: vi.fn(async () => { throw new Error('A disk-backed environment snapshots its disk, not an image'); }),
    containerExists: vi.fn(async (spec: any) => containers.has(spec.name)),
    resourceUsageBatch: vi.fn(async (entries: any[]) => entries.map(({ spec, state }) => ({
      cpu: state === 'running' ? { state: 'ready', usedCpus: 0.5, percent: 50 } : { state: 'stopped', usedCpus: null, percent: null },
      memory: state === 'running' ? { state: 'ready', usedBytes: 256 * 1024 * 1024, limitBytes: spec.limits.memoryMb * 1024 * 1024 } : { state: 'stopped', usedBytes: null, limitBytes: spec.limits.memoryMb * 1024 * 1024 },
      disk: { state: 'ready', usedBytes: 512 * 1024 * 1024, limitBytes: null },
    }))),
    // The rows the helper reports, in the helper's own shape. `unready` carries the details a real host
    // returns, because what the runtime does with them — quoting them back in its refusal — is the thing
    // worth proving, and an empty detail would prove nothing.
    hostReadiness: vi.fn(async () => (machineHost === 'ready'
      ? { ready: true, items: [
        { id: 'os:supported', label: 'Supported operating system', ok: true, detail: 'Ubuntu 24.04' },
        { id: 'unit:elowen-machine', label: 'Machine unit template', ok: true, detail: 'installed and loaded' },
      ] }
      : { ready: false, items: [
        { id: 'os:supported', label: 'Supported operating system', ok: true, detail: 'Ubuntu 24.04' },
        { id: 'package:systemd-container', label: 'systemd container tools', ok: false, detail: 'not installed — run environment provisioning to install it' },
        { id: 'unit:elowen-machine', label: 'Machine unit template', ok: false, detail: 'on disk but the manager has not read it — run: systemctl daemon-reload' },
      ] })),
  };
  const storage = { prepare: vi.fn(), adoptWorkspace: vi.fn(), snapshot: vi.fn(), readSnapshot: vi.fn(), restoreVolumes: vi.fn(), releaseWorkspace: vi.fn(),
    removeDisk: vi.fn(async (spec: any) => { diskFiles.delete(spec.disk.id); }) };
  const dependencies = { ctx, db, dataDir: root, nspawn: nspawn as unknown as NspawnClient,
    storage: storage as unknown as ContainerStorage, cpuModel: 'AMD EPYC 7B13 64-Core Processor' };
  const runtime = createEnvironmentRuntime({ ...dependencies, daemon: true });
  const fork = createEnvironmentRuntime({ ...dependencies, daemon: false });
  cleanup.push(() => { endForwarders(); runtime.dispose(); fork.dispose(); sql.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, fork, db, sql, ctx, nspawn, storage, members, users, project, stores, root, containers, diskFiles, warn, forwarders, publicationSocket, staleSocket, endForwarders };
}
const input = { project: { kind: 'managed', projectId: 7 }, accountUserId: 1 };

describe('durable managed environment lifecycle', () => {
  it('batches resource usage only after fresh Project authorization', async () => {
    const { runtime, nspawn, members } = setup();
    const cold = await runtime.environmentUsageBatch({ projectIds: [7], accountUserId: 2 });
    expect(cold.projects).toEqual([expect.objectContaining({
      projectId: 7,
      environment: expect.objectContaining({ state: 'unprovisioned', limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 } }),
      resources: expect.objectContaining({
        cpu: { state: 'stopped', usedCpus: null, percent: null, model: 'AMD EPYC 7B13 64-Core Processor' },
        disk: { state: 'ready', usedBytes: 0, limitBytes: null },
      }),
    })]);
    expect(nspawn.resourceUsageBatch).not.toHaveBeenCalled();

    await runtime.requestEnvironment({ ...input, requestId: 'usage-start', action: { kind: 'start' } });
    await runtime.reconcile();
    const live = await runtime.environmentUsageBatch({ projectIds: [7], accountUserId: 2 });
    expect(live.projects[0]).toMatchObject({
      environment: { state: 'running' },
      resources: {
        cpu: { state: 'ready', usedCpus: 0.5, percent: 50, model: 'AMD EPYC 7B13 64-Core Processor' },
        memory: { state: 'ready', usedBytes: 256 * 1024 * 1024, limitBytes: 1024 * 1024 * 1024 },
        disk: { state: 'ready', usedBytes: 512 * 1024 * 1024, limitBytes: null },
      },
    });
    expect(nspawn.resourceUsageBatch).toHaveBeenCalledWith([expect.objectContaining({ state: 'running', spec: expect.objectContaining({ name: 'elowen-project-7-g1' }) })]);

    members.delete(2);
    await expect(runtime.environmentUsageBatch({ projectIds: [7], accountUserId: 2 })).rejects.toMatchObject({ code: 'project_forbidden', status: 403 });
    expect(nspawn.resourceUsageBatch).toHaveBeenCalledTimes(1);
  });

  it('keeps one rootfs disk across envelope recreation and limit changes, then deletes it after handles', async () => {
    const { runtime, nspawn, storage, containers, diskFiles } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'disk-start', action: { kind: 'start' } });
    await runtime.reconcile();
    const initial = nspawn.create.mock.calls[0]![0];
    expect(initial.disk).toMatchObject({ format: 2, sourceImage: PROJECT_ROOTFS });
    await nspawn.exec(initial, 'f'.repeat(32), ['/bin/bash', '-s'], { input: 'printf marker >/etc/elowen-rootfs-marker' });
    const diskId = initial.disk.id;
    containers.delete(initial.name);

    await runtime.requestEnvironment({ ...input, requestId: 'disk-recreate', action: { kind: 'recreate' } });
    await runtime.reconcile();
    const recreated = nspawn.create.mock.calls.at(-1)![0];
    expect(recreated.disk.id).toBe(diskId);
    expect(diskFiles.get(diskId)?.get('/etc/elowen-rootfs-marker')).toBe('marker');

    await runtime.requestEnvironment({ ...input, accountUserId: 3, requestId: 'disk-limits', action: { kind: 'limits', limits: { cpus: 2, memoryMb: 2048, pidsLimit: 1024 } } });
    await runtime.reconcile();
    expect((nspawn.update.mock.calls.at(-1) as any[])[0].disk.id).toBe(diskId);

    await runtime.requestEnvironment({ ...input, requestId: 'disk-delete', action: { kind: 'delete' } });
    await runtime.reconcile();
    expect(storage.removeDisk).toHaveBeenCalledWith(expect.objectContaining({ disk: expect.objectContaining({ id: diskId }) }), expect.any(Array));
    expect(diskFiles.has(diskId)).toBe(false);
  });

  it('restores a format 2 snapshot into new disks and retains prior disks for rollback', async () => {
    const { runtime, nspawn, storage, diskFiles } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'snapshot-start', action: { kind: 'start' } });
    await runtime.reconcile();
    const first = nspawn.create.mock.calls.at(-1)![0];
    storage.snapshot.mockImplementation(async (_spec: any, snapshotId: string) => ({ version: 2, snapshotId,
      sourceImage: { reference: first.image, id: 'sha256:' + 'd'.repeat(64) }, trees: [], worktrees: [] }));
    const capture = await runtime.requestEnvironment({ ...input, requestId: 'snapshot-v2', action: { kind: 'snapshot' } });
    await runtime.reconcile();
    const saved = await runtime.environmentOperation({ operationId: capture.id, accountUserId: 1 });
    storage.readSnapshot.mockResolvedValue({ version: 2, snapshotId: saved.snapshotId,
      sourceImage: { reference: first.image, id: 'sha256:' + 'd'.repeat(64) }, trees: [] });

    await runtime.requestEnvironment({ ...input, requestId: 'restore-v2', action: { kind: 'restore', snapshotId: saved.snapshotId } });
    await runtime.reconcile();
    const second = nspawn.create.mock.calls.at(-1)![0];
    expect(second.disk.id).not.toBe(first.disk.id);
    expect(storage.restoreVolumes).toHaveBeenCalledWith(expect.objectContaining({ disk: expect.objectContaining({ id: first.disk.id }) }), saved.snapshotId,
      expect.objectContaining({ disk: expect.objectContaining({ id: second.disk.id }) }));
    expect(diskFiles.has(first.disk.id)).toBe(true);

    await runtime.requestEnvironment({ ...input, requestId: 'rollback-v2', action: { kind: 'restore', snapshotId: saved.snapshotId } });
    await runtime.reconcile();
    const third = nspawn.create.mock.calls.at(-1)![0];
    expect(third.disk.id).not.toBe(second.disk.id);
    expect(diskFiles.has(second.disk.id)).toBe(true);
  });

  // The artifact reference a row carries is inside its specification hash and inside the machine's own
  // identity record, so a start that moved an existing environment onto the release's current root
  // filesystem would leave it unable to prove it owns anything it already has.
  it('fetches an existing row from the artifact it carries and never restamps it with the current one', async () => {
    const { runtime, sql, storage, containers } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'source-initial', action: { kind: 'start' } });
    await runtime.reconcile();
    const row = sql.prepare("SELECT spec_json FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get() as any;
    const stored = JSON.parse(row.spec_json);
    // A revision this release does not publish, which is what every existing row becomes as soon as a
    // recipe is revised. The envelope is dropped too, so the start really does reach materialization.
    const carried = 'project-base@7';
    expect(carried).not.toBe(PROJECT_ROOTFS);
    stored.input.image = carried;
    stored.input.disk.sourceImage = carried;
    delete stored.containerId;
    sql.prepare("UPDATE p_sandbox_runtimes SET spec_json=?, state='stopped' WHERE kind='project' AND resource_id='7'").run(JSON.stringify(stored));
    containers.clear();
    storage.prepare.mockClear();

    await runtime.requestEnvironment({ ...input, requestId: 'source-restart', action: { kind: 'start' } });
    await runtime.reconcile();

    // What is fetched is the reference the ROW names, not the one this release ships.
    expect(storage.prepare).toHaveBeenCalledWith(expect.objectContaining({ image: carried,
      disk: expect.objectContaining({ sourceImage: carried }) }), expect.objectContaining({ onProgress: expect.any(Function) }));
    const updated = JSON.parse((sql.prepare("SELECT spec_json FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get() as any).spec_json);
    expect(updated.input.image).toBe(carried);
    expect(updated.input.disk.sourceImage).toBe(carried);
  });

  // The project is mounted under its own name, and an envelope written before that must never be adopted:
  // its specification identity changed, so adopting it would run the turn against an unverified machine.
  it('mounts the project at its own name and refuses a row from the previous layout by name', async () => {
    const { runtime, nspawn, db } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'named-start', action: { kind: 'start' } });
    await runtime.reconcile();
    expect(nspawn.create.mock.calls[0]![0].workdir).toBe('/sales-dashboard');
    expect(nspawn.create.mock.calls[0]![0].mounts.map((mount: any) => mount.target)).toEqual(['/sales-dashboard', '/root', '/data', '/run/elowen']);

    // Rewind the row to what it looked like before this change: no mount point, envelope already bound.
    const row = db.prepare("SELECT * FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get() as any;
    const spec = JSON.parse(row.spec_json);
    delete spec.input.workspaceTarget;
    db.prepare("UPDATE p_sandbox_runtimes SET spec_json=?, state='stopped' WHERE kind='project' AND resource_id='7'").run(JSON.stringify(spec));

    // Such a row predates the machine runtime entirely: its root filesystem was never materialized from a
    // published artifact, so filling the mount point in would silently rewrite an identity nothing can
    // prove. It is named and refused, with its remedy, rather than adopted or repaired in place.
    await expect(runtime.requestEnvironment({ ...input, requestId: 'legacy-start', action: { kind: 'start' } }))
      .rejects.toMatchObject({ code: 'unsupported_runtime', status: 409 });
    await expect(runtime.requestEnvironment({ ...input, requestId: 'legacy-start-2', action: { kind: 'start' } }))
      .rejects.toThrow(/removed Podman runtime.*Delete the managed Project/);
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
    const { runtime, nspawn } = setup({ defaultCpus: 2.5, defaultMemoryMb: 4096, defaultPidsLimit: 1024 });
    const expected = { cpus: 2.5, memoryMb: 4096, pidsLimit: 1024 };
    // Reported before the environment exists, so the figures shown are the ones it would be created with.
    expect((await runtime.environmentFor(input)).limits).toEqual(expected);
    await runtime.requestEnvironment({ ...input, requestId: 'defaults-start', action: { kind: 'start' } });
    await runtime.reconcile();
    expect((await runtime.environmentFor(input)).limits).toEqual(expected);
    // And they reach the container, not just the record.
    expect(nspawn.create.mock.calls[0]![0].limits).toEqual({ cpus: 2.5, memoryMb: 4096, pidsLimit: 1024 });
  });

  it('keeps the built-in figure for a setting that is missing or unusable', async () => {
    const { runtime } = setup({ defaultCpus: 0, defaultMemoryMb: 4096, defaultPidsLimit: 'many' });
    expect((await runtime.environmentFor(input)).limits).toEqual({ cpus: 1, memoryMb: 4096, pidsLimit: 512 });
  });

  it('copies the network default once and applies an admin change through a stopped envelope', async () => {
    const { runtime, nspawn } = setup({ defaultNetworkMode: 'isolated' });
    expect((await runtime.environmentFor(input)).network).toEqual({ mode: 'isolated', inboundPorts: [] });
    await runtime.requestEnvironment({ ...input, requestId: 'network-start', action: { kind: 'start' } });
    await runtime.reconcile();
    expect(nspawn.create.mock.calls[0]![0].network).toBe('none');

    await expect(runtime.requestEnvironment({ ...input, requestId: 'network-denied', action: { kind: 'network', network: { mode: 'shared', inboundPorts: [] } } }))
      .rejects.toMatchObject({ code: 'admin_required', status: 403 });
    const changed = await runtime.requestEnvironment({ ...input, accountUserId: 3, requestId: 'network-shared', action: { kind: 'network', network: {
      mode: 'shared', inboundPorts: [{ protocol: 'tcp', hostPort: 8080, guestPort: 3000 }],
    } } });
    expect(changed.steps).toEqual(['quiesce', 'stop', 'apply', 'boot']);
    await runtime.reconcile();

    expect(nspawn.stop).toHaveBeenCalled();
    expect(nspawn.remove).toHaveBeenCalled();
    expect(nspawn.create.mock.calls.at(-1)![0]).toMatchObject({ network: 'slirp4netns:allow_host_loopback=false',
      inboundPorts: [{ protocol: 'tcp', hostPort: 8080, guestPort: 3000 }] });
    expect((await runtime.environmentFor({ ...input, accountUserId: 3 })).network)
      .toEqual({ mode: 'shared', inboundPorts: [{ protocol: 'tcp', hostPort: 8080, guestPort: 3000 }] });
  });

  it('rejects malformed and already reserved host ports before enqueueing work', async () => {
    const { runtime, db } = setup();
    const actor = { ...input, accountUserId: 3 };
    for (const network of [
      { mode: 'isolated', inboundPorts: [{ protocol: 'tcp', hostPort: 8080, guestPort: 3000 }] },
      { mode: 'shared', inboundPorts: [{ protocol: 'tcp', hostPort: 80, guestPort: 80 }] },
      { mode: 'shared', inboundPorts: [{ protocol: 'sctp', hostPort: 8080, guestPort: 3000 }] },
    ]) {
      await expect(runtime.requestEnvironment({ ...actor, action: { kind: 'network', network } as any })).rejects.toMatchObject({ code: 'invalid_network' });
    }
    db.prepare("INSERT INTO p_sandbox_runtimes(kind,resource_id,project_id,spec_json,limits_json) VALUES('project','8',8,?,?)")
      .run(JSON.stringify({ input: { network: { mode: 'shared', inboundPorts: [{ protocol: 'tcp', hostPort: 8080, guestPort: 80 }] } } }), JSON.stringify({}));
    await expect(runtime.requestEnvironment({ ...actor, action: { kind: 'network', network: { mode: 'shared', inboundPorts: [{ protocol: 'tcp', hostPort: 8080, guestPort: 3000 }] } } }))
      .rejects.toMatchObject({ code: 'network_port_conflict' });
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
    const { runtime, nspawn } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    nspawn.containerInventory.mockClear();
    nspawn.inspect.mockClear();

    await runtime.reconcile();

    expect(nspawn.containerInventory).toHaveBeenCalledOnce();
    expect(nspawn.inspect).not.toHaveBeenCalled();
  });

  /** An inventory name is what the HOST has registered, not proof that the machine is this environment's.
   *  A machine left over from another specification can hold the name, and adopting or replacing it would
   *  be the runtime guessing about a container it cannot verify. */
  it.each([
    ['a foreign envelope', 'Machine ownership or runtime specification mismatch: identity.specHash'],
    ['no envelope at all', 'No machine envelope of this name exists on this host'],
  ])('reports a machine name it cannot prove it owns, and starts nothing (%s)', async (_case, refusal) => {
    const { runtime, nspawn, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    nspawn.start.mockClear();
    nspawn.create.mockClear();
    nspawn.proveOwnership.mockRejectedValue(new Error(refusal));
    const logged = () => db.prepare("SELECT message FROM p_sandbox_runtime_logs WHERE kind='project' AND resource_id='7' ORDER BY id").all()
      .map((entry: any) => entry.message).filter((message: string) => message.includes('not provably')).length;

    await runtime.reconcile();
    await runtime.reconcile();

    // Nothing is started or created under a name this runtime cannot prove, and the standing condition is
    // reported ONCE rather than on every ten-second sweep.
    expect(nspawn.start).not.toHaveBeenCalled();
    expect(nspawn.create).not.toHaveBeenCalled();
    expect(logged()).toBe(1);
    expect((await runtime.environmentFor(input)).state).toBe('running');
  });

  /** The report is a STANDING condition and not a permanent one: a project that stops running takes its
   *  entry with it, so the next time the same name is unprovable the operator reads it again instead of
   *  losing it to a memory of a condition that had already ended. */
  it('forgets a standing unowned-name report once the project stops running', async () => {
    const { runtime, nspawn, db, containers } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    const reports = () => db.prepare("SELECT message FROM p_sandbox_runtime_logs WHERE kind='project' AND resource_id='7' ORDER BY id").all()
      .map((entry: any) => entry.message).filter((message: string) => message.includes('not provably')).length;
    nspawn.proveOwnership.mockRejectedValue(new Error('No machine envelope of this name exists on this host'));

    await runtime.reconcile();
    await runtime.reconcile();
    expect(reports()).toBe(1);

    await runtime.requestEnvironment({ ...input, requestId: 'unowned-stop', action: { kind: 'stop' } });
    await runtime.reconcile();
    expect((await runtime.environmentFor(input)).state).toBe('stopped');
    expect(containers.size).toBe(1);

    await runtime.requestEnvironment({ ...input, requestId: 'unowned-restart', action: { kind: 'start' } });
    await runtime.reconcile();
    expect((await runtime.environmentFor(input)).state).toBe('running');

    // The name is up and unprovable again: the same standing condition, reported as a new one.
    await runtime.reconcile();
    expect(reports()).toBe(2);
  });

  it('normalizes a migrated persistent root before restarting its existing machine', async () => {
    const { runtime, nspawn } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    nspawn.normalizeRootfs.mockClear();
    nspawn.start.mockClear();

    await runtime.requestEnvironment({ ...input, requestId: 'normalize-existing-root', action: { kind: 'restart' } });
    await runtime.reconcile();

    expect(nspawn.normalizeRootfs).toHaveBeenCalledOnce();
    expect(nspawn.normalizeRootfs.mock.invocationCallOrder[0]).toBeLessThan(nspawn.start.mock.invocationCallOrder[0]);
  });

  it('does not report a running shared-network guest as ready without host0 carrier and an address', async () => {
    const { runtime, nspawn, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    nspawn.networkReadiness.mockResolvedValue({ ready: false, carrier: false, addresses: [],
      detail: 'host0 has no carrier and no global address' });

    const environment = await runtime.environmentFor(input);
    expect(environment.state).toBe('failed');
    expect(environment.lastError).toContain('host0 has no carrier and no global address');
    expect(db.prepare("SELECT state FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get()).toEqual({ state: 'running' });
  });

  /** A networked machine is only isolated while the host's forwarding and firewall rows are in place, and
   *  the host can lose one between two sweeps. Automatic recovery is the path that would start it again, so
   *  the refusal has to be in the start itself — and the machine must not be started onto a link nothing
   *  guards. */
  it('refuses to start a networked machine on a host that can no longer prove its network rows', async () => {
    const { runtime, nspawn, containers, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    containers.values().next().value.state = 'stopped';
    nspawn.start.mockClear();
    nspawn.hostReadiness.mockResolvedValue({ ready: false, items: [
      { id: 'os:supported', label: 'Supported operating system', ok: true, detail: 'Ubuntu 24.04' },
      { id: 'firewall:host-guard', label: 'Machine-to-host guard', ok: false, detail: 'everything else a machine addresses to the host arrives here — run: /usr/sbin/iptables -A INPUT -i ve-+ -j DROP' },
    ] });

    await runtime.reconcile();

    expect(nspawn.start).not.toHaveBeenCalled();
    const environment = await runtime.environmentFor(input);
    expect(environment.state).toBe('failed');
    // The row the host is missing is quoted back rather than summarised, exactly as the creation decision
    // does it, so an operator reads what to fix.
    expect(environment.lastError).toContain('Machine-to-host guard');
    expect(environment.lastError).toContain('/usr/sbin/iptables');
    expect(db.prepare("SELECT message FROM p_sandbox_runtime_logs WHERE kind='project' AND resource_id='7' ORDER BY id").all()
      .map((entry: any) => entry.message).join('\n')).toMatch(/start queued automatically/);
  });

  /** The other half of the same rule: an isolated environment gets no virtual ethernet, so none of those
   *  rows are its to depend on and a host that has lost them must not stop it recovering. */
  it('asks nothing of an isolated environment, which has no link to isolate', async () => {
    const { runtime, nspawn, containers } = setup({ defaultNetworkMode: 'isolated' });
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    expect((await runtime.environmentFor(input)).network.mode).toBe('isolated');
    containers.values().next().value.state = 'stopped';
    nspawn.start.mockClear();
    nspawn.hostReadiness.mockClear();
    nspawn.hostReadiness.mockResolvedValue({ ready: false, items: [
      { id: 'unit:elowen-machine', label: 'Machine unit template', ok: false, detail: 'on disk but the manager has not read it — run: systemctl daemon-reload' },
    ] });

    await runtime.reconcile();

    // Not even the probe: there is no link, so there is nothing to ask the host about.
    expect(nspawn.hostReadiness).not.toHaveBeenCalled();
    expect(nspawn.start).toHaveBeenCalledOnce();
    expect((await runtime.environmentFor(input)).state).toBe('running');
  });

  /** The second shape a start takes: a paused machine is thawed back to running, and it is the same machine
   *  that already holds the virtual ethernet. A host that can no longer isolate that link must not carry it
   *  in either shape, and the refusal has to land BEFORE the thaw so the machine stays frozen rather than
   *  coming back up unisolated. */
  it('refuses to thaw a paused networked machine on a host that can no longer prove its network rows', async () => {
    const { runtime, nspawn, containers } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    containers.values().next().value.state = 'paused';
    nspawn.unpause.mockClear();
    nspawn.hostReadiness.mockResolvedValue({ ready: false, items: [
      { id: 'os:supported', label: 'Supported operating system', ok: true, detail: 'Ubuntu 24.04' },
      { id: 'firewall:host-guard', label: 'Machine-to-host guard', ok: false, detail: 'everything else a machine addresses to the host arrives here — run: /usr/sbin/iptables -A INPUT -i ve-+ -j DROP' },
    ] });

    await runtime.reconcile();

    expect(nspawn.unpause).not.toHaveBeenCalled();
    expect(containers.values().next().value.state).toBe('paused');
    const environment = await runtime.environmentFor(input);
    expect(environment.state).toBe('failed');
    expect(environment.lastError).toContain('Machine-to-host guard');
  });

  /** A thawed machine that holds no link is asked nothing either, exactly as a booted one is: the gate is
   *  the same predicate and an isolated environment never reaches the host with it. */
  it('thaws a paused isolated machine without asking the host about a link it does not have', async () => {
    const { runtime, nspawn, containers } = setup({ defaultNetworkMode: 'isolated' });
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    containers.values().next().value.state = 'paused';
    nspawn.unpause.mockClear();
    nspawn.hostReadiness.mockClear();
    nspawn.hostReadiness.mockResolvedValue({ ready: false, items: [
      { id: 'unit:elowen-machine', label: 'Machine unit template', ok: false, detail: 'on disk but the manager has not read it — run: systemctl daemon-reload' },
    ] });

    await runtime.reconcile();

    expect(nspawn.unpause).toHaveBeenCalledOnce();
    expect(nspawn.hostReadiness).not.toHaveBeenCalled();
    expect((await runtime.environmentFor(input)).state).toBe('running');
  });

  it('recovers a desired running environment whose container was left created after a host reboot', async () => {
    const { runtime, containers, nspawn, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    containers.values().next().value.state = 'created';
    nspawn.start.mockClear();

    await runtime.reconcile();

    expect(nspawn.start).toHaveBeenCalledOnce();
    expect((await runtime.environmentFor(input)).state).toBe('running');
    expect(db.prepare("SELECT message FROM p_sandbox_runtime_logs WHERE kind='project' AND resource_id='7' ORDER BY id").all()
      .map((entry: any) => entry.message).join('\n')).toMatch(/container not running \(created\)/);
  });

  it('names what the sweep observed when a start failed, instead of claiming a host reboot', async () => {
    // The sweep runs on a timer and cannot tell why an envelope is down. Here nothing rebooted: the first
    // start failed, so the retry has to say what it saw rather than name a cause it never established.
    const { runtime, nspawn, db } = setup();
    nspawn.create.mockRejectedValueOnce(new Error('the disk tree sync failed'));
    await runtime.requestEnvironment({ ...input, requestId: 'failed-start', action: { kind: 'start' } });
    await runtime.reconcile();
    expect((await runtime.environmentFor(input)).state).toBe('failed');

    await runtime.reconcile();

    const log = db.prepare("SELECT message FROM p_sandbox_runtime_logs WHERE kind='project' AND resource_id='7' ORDER BY id").all()
      .map((entry: any) => entry.message).join('\n');
    expect(log).toMatch(/start queued automatically: container missing \(attempt 1\/4\)/);
    expect(log).not.toMatch(/reboot/);
  });

  // A container that fails the ownership check (a pre-batch site container, say) is not ours to restart,
  // and one such row must not end the sweep before the environments behind it are looked at.
  it('skips an environment whose container cannot be verified and keeps sweeping the rest', async () => {
    const { runtime, containers, nspawn, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    containers.values().next().value.state = 'created';
    nspawn.inspect.mockImplementationOnce(async () => { throw new Error('Container ownership or runtime specification mismatch: labels, mounts'); });
    nspawn.start.mockClear();

    await expect(runtime.reconcile()).resolves.toBeUndefined();

    expect(nspawn.start).not.toHaveBeenCalled();
    expect(db.prepare("SELECT message FROM p_sandbox_runtime_logs WHERE kind='project' AND resource_id='7' ORDER BY id").all()
      .map((entry: any) => entry.message).join('\n')).toMatch(/Automatic recovery skipped: .*mismatch: labels, mounts/);

    await runtime.reconcile();
    expect(nspawn.start).toHaveBeenCalledOnce();
  });

  it('recreates a missing limited container from its volumes and restores publications', async () => {
    const { runtime, containers, nspawn, root, endForwarders, staleSocket } = setup();
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
    nspawn.create.mockClear();
    nspawn.startPublication.mockClear();

    await runtime.reconcile();

    expect(nspawn.create).toHaveBeenCalledOnce();
    const recreated = nspawn.create.mock.calls[0]![0];
    expect(recreated.expectedId).toBeUndefined();
    expect(recreated.limits).toEqual(changed);
    expect(recreated.creationLimits ?? recreated.limits).toEqual(changed);
    expect(readFileSync(marker, 'utf8')).toBe('still here');
    expect(nspawn.startPublication).toHaveBeenCalledWith(expect.anything(), 'shop', expect.anything());
    expect((await runtime.environmentFor(input)).state).toBe('running');
  });

  it('recreates a limited container with the changed limits as its new creation baseline', async () => {
    const { runtime, nspawn } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'lim-start', action: { kind: 'start' } }); await runtime.reconcile();
    const changed = { cpus: 2, memoryMb: 2048, pidsLimit: 1024 };
    await runtime.requestEnvironment({ ...input, accountUserId: 3, requestId: 'lim-limits', action: { kind: 'limits', limits: changed } }); await runtime.reconcile();
    nspawn.create.mockClear();

    await runtime.requestEnvironment({ ...input, requestId: 'lim-recreate', action: { kind: 'recreate' } }); await runtime.reconcile();

    expect(nspawn.create).toHaveBeenCalledOnce();
    const recreated = nspawn.create.mock.calls[0]![0];
    expect(recreated.limits).toEqual(changed);
    expect(recreated.creationLimits ?? recreated.limits).toEqual(changed);
    expect((await runtime.environmentFor(input)).state).toBe('running');
    // The new container is verified against the baseline it was created with, so a stop still passes ownership.
    await runtime.requestEnvironment({ ...input, requestId: 'lim-stop', action: { kind: 'stop' } }); await runtime.reconcile();
    expect((await runtime.environmentFor(input)).state).toBe('stopped');
  });

  it('reaches recovery attempts one through four after short successful restarts and manual start resets them', async () => {
    vi.useFakeTimers();
    cleanup.push(() => vi.useRealTimers());
    const { runtime, containers, nspawn, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    nspawn.start.mockClear();
    const stopAgain = () => { containers.values().next().value.state = 'created'; };

    stopAgain(); await runtime.reconcile();
    stopAgain(); await vi.advanceTimersByTimeAsync(30_000); await runtime.reconcile();
    stopAgain(); await vi.advanceTimersByTimeAsync(120_000); await runtime.reconcile();
    stopAgain(); await vi.advanceTimersByTimeAsync(600_000); await runtime.reconcile();

    expect(db.prepare("SELECT json_extract(checkpoint_json,'$.autoRecovery.attempt') AS attempt FROM p_sandbox_runtime_operations WHERE request_key LIKE 'autostart:%' ORDER BY rowid").all())
      .toEqual([{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }, { attempt: 4 }]);
    expect(nspawn.start).toHaveBeenCalledTimes(4);

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
    const { runtime, containers, nspawn, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    containers.values().next().value.state = 'created';
    nspawn.start.mockRejectedValue(new Error('container exited during boot'));
    nspawn.start.mockClear();

    await runtime.reconcile();
    await runtime.reconcile();
    expect(nspawn.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999); await runtime.reconcile();
    expect(nspawn.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await runtime.reconcile();
    expect(nspawn.start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(119_999); await runtime.reconcile();
    expect(nspawn.start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); await runtime.reconcile();
    expect(nspawn.start).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(599_999); await runtime.reconcile();
    expect(nspawn.start).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1); await runtime.reconcile();
    expect(nspawn.start).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(3_600_000); await runtime.reconcile();
    expect(nspawn.start).toHaveBeenCalledTimes(4);
    expect(db.prepare("SELECT state,error FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get()).toMatchObject({
      state: 'failed', error: expect.stringMatching(/automatic recovery failed after 4 attempts/i),
    });
  });

  it('resets automatic recovery attempts after the stability window', async () => {
    vi.useFakeTimers();
    cleanup.push(() => vi.useRealTimers());
    const { runtime, containers, nspawn, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    containers.values().next().value.state = 'created';
    await runtime.reconcile();
    await vi.advanceTimersByTimeAsync(900_000);
    containers.values().next().value.state = 'created';
    nspawn.start.mockClear();

    await runtime.reconcile();

    expect(nspawn.start).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT json_extract(checkpoint_json,'$.autoRecovery.attempt') AS attempt FROM p_sandbox_runtime_operations WHERE request_key LIKE 'autostart:%' ORDER BY rowid").all())
      .toEqual([{ attempt: 1 }, { attempt: 1 }]);
  });

  it('leaves explicit stopped and deleted intents untouched during runtime recovery', async () => {
    const { runtime, containers, nspawn, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    containers.values().next().value.state = 'created';
    nspawn.start.mockClear();

    db.prepare("UPDATE p_sandbox_runtimes SET desired_state='stopped',state='stopped' WHERE kind='project' AND resource_id='7'").run();
    await runtime.reconcile();
    db.prepare("UPDATE p_sandbox_runtimes SET desired_state='deleted',state='deleting' WHERE kind='project' AND resource_id='7'").run();
    await runtime.reconcile();

    expect(nspawn.start).not.toHaveBeenCalled();
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
    const { runtime, fork, nspawn } = setup();
    const op = await fork.requestEnvironment({ ...input, requestId: 'start-one', action: { kind: 'start' } });
    expect(op.status).toBe('pending');
    expect(await fork.requestEnvironment({ ...input, requestId: 'start-one', action: { kind: 'start' } })).toEqual(op);
    await fork.reconcile();
    expect(nspawn.create).not.toHaveBeenCalled();
    await runtime.reconcile();
    expect((await runtime.environmentOperation({ operationId: op.id, accountUserId: 1 }))?.status).toBe('succeeded');
    expect((await runtime.environmentFor(input)).state).toBe('running');
    expect(nspawn.create).toHaveBeenCalledOnce();
    await runtime.reconcile();
    expect(nspawn.create).toHaveBeenCalledOnce();
  });
  it('rechecks membership and generation before dispatching durable work', async () => {
    const { runtime, fork, members, nspawn } = setup();
    const op = await fork.requestEnvironment({ ...input, action: { kind: 'start' } });
    members.delete(1);
    await runtime.reconcile();
    expect(nspawn.create).not.toHaveBeenCalled();
    expect((await runtime.environmentOperation({ operationId: op.id, accountUserId: 3 }))?.status).toBe('failed');
    await expect(runtime.environmentFor(input)).rejects.toThrow(/access/i);
  });
  it('preserves the same container across explicit stop/start and refuses implicit restart', async () => {
    const { runtime, nspawn } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    await runtime.requestEnvironment({ ...input, action: { kind: 'stop' } }); await runtime.reconcile();
    await expect(runtime.prepareExecution({ command: { type: 'shell', command: 'true' }, cwd: '/workspace', projectRef: input.project, leaseKind: 'terminal' }, 1)).rejects.toThrow(/stopped/i);
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    expect(nspawn.create).toHaveBeenCalledOnce();
    expect(nspawn.stop).toHaveBeenCalledOnce();
  });
  it('revokes tracked actor work without stopping shared project services', async () => {
    const { runtime, members, nspawn, sql } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    const prepared = await runtime.prepareExecution({ command: { type: 'shell', command: 'sleep 5' }, cwd: '/workspace', projectRef: input.project, leaseKind: 'terminal' }, 1);
    expect(prepared.mode).toBe('managed');
    // The shell script is the bootstrap's declared prefix, written once, so anything the caller sends
    // after it stays on stdin for the program rather than being swallowed by the shell.
    expect(prepared.stdin.equals(Buffer.from('sleep 5'))).toBe(true);
    expect(nspawn.prepareExecution).toHaveBeenCalledWith(expect.anything(), expect.any(String),
      ['/usr/bin/python3', '-c', expect.stringContaining('memfd_create'), '7'], expect.anything());
    members.delete(1);
    await runtime.revokeProjectAccess({ projectId: 7, accountUserId: 1 });
    expect(nspawn.cancelExecution).toHaveBeenCalled();
    expect(nspawn.stop).not.toHaveBeenCalled();
    // 2 records a cancellation whose termination was PROVEN, which is what the release below reads.
    expect(sql.prepare('SELECT cancel_requested FROM p_sandbox_execution_leases WHERE id=?').get(prepared.lease.id)).toMatchObject({ cancel_requested: 2 });

    // The terminal releases its lease in a `finally`, so this release follows the revocation above. It
    // must retire the lease and nothing else: a normal release ends in an unmask, and unmasking the
    // cancellation's tombstone would reopen the late-launch race that cancelling had just closed.
    await prepared.lease.release();
    expect(nspawn.releaseExecution).not.toHaveBeenCalled();
    expect(nspawn.cancelExecution).toHaveBeenCalledOnce();
    expect(sql.prepare('SELECT 1 FROM p_sandbox_execution_leases WHERE id=?').get(prepared.lease.id)).toBeUndefined();
  });
  // Cancelling and releasing the same execution race in practice: the terminal cancels a running command
  // and then releases the lease in its `finally`, and a user closing the tab can do both at once.
  it('serializes a concurrent cancel and release into one cancellation and one lease deletion', async () => {
    const { runtime, nspawn, sql } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    const prepared = await runtime.prepareExecution({ command: { type: 'shell', command: 'sleep 5' }, cwd: '/workspace', projectRef: input.project, leaseKind: 'terminal' }, 1);

    await Promise.all([prepared.lease.cancel(), prepared.lease.release()]);

    // Whichever order they settle in, the guest is cancelled once and never un-cancelled, and the lease
    // is retired exactly once.
    expect(nspawn.cancelExecution).toHaveBeenCalledOnce();
    expect(nspawn.releaseExecution).not.toHaveBeenCalled();
    expect(sql.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases WHERE id=?').get(prepared.lease.id)).toEqual({ n: 0 });
  });

  it('cancels once however many times it is asked', async () => {
    const { runtime, nspawn } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    const prepared = await runtime.prepareExecution({ command: { type: 'shell', command: 'sleep 5' }, cwd: '/workspace', projectRef: input.project, leaseKind: 'terminal' }, 1);

    await prepared.lease.cancel();
    await prepared.lease.cancel();
    await Promise.all([prepared.lease.cancel(), prepared.lease.cancel()]);
    expect(nspawn.cancelExecution).toHaveBeenCalledOnce();
  });

  // A cancellation that could not be PROVEN is not a cancellation. It must not record itself as one, and
  // the release behind it has to fall back to the fully verified path so recovery still has its footing.
  it('keeps the verified fallback when a cancellation cannot be proven', async () => {
    const { runtime, nspawn, sql } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    const prepared = await runtime.prepareExecution({ command: { type: 'shell', command: 'sleep 5' }, cwd: '/workspace', projectRef: input.project, leaseKind: 'terminal' }, 1);
    nspawn.inspect.mockResolvedValue({ id: 'a'.repeat(64), state: 'paused' });

    await expect(prepared.lease.cancel()).rejects.toThrow(/cannot be verified/i);
    expect(nspawn.cancelExecution).not.toHaveBeenCalled();
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

  it('answers a failed guest upload from a fixed table rather than forwarding guest text', async () => {
    const { runtime, nspawn, root } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    const real = async (...args: any[]) => {
      const argv = args[2]; const options = args[3];
      const request = JSON.parse(options.input);
      const inputJson = JSON.stringify({
        ...request,
        root,
        path: request.path.replace('/sales-dashboard', root),
        ...(request.resolvedPath ? { resolvedPath: request.resolvedPath.replace('/sales-dashboard', root) } : {}),
      });
      const result = spawnSync(argv[0], argv.slice(1), { input: inputJson, encoding: 'utf8', maxBuffer: 2 ** 21,
        env: { ...process.env, ELOWEN_UPLOAD_ROOT: join(root, 'uploads') } });
      return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, truncated: false };
    };
    nspawn.exec.mockImplementation(real);
    const path = '/sales-dashboard/uploaded';
    const files = (operation: any) => runtime.projectFiles({ ...input, accountUserId: 1, operation });
    const { uploadId } = await files({ kind: 'write-begin', path, expectedVersion: null, size: 4 });

    // A guest failure carries whatever the operating system put in it: the staging directory, the candidate
    // file, an errno. The guest's failures are raised from inside the transfer, so its text is a running
    // commentary on a private staging area — none of which the caller can act on or should be shown.
    const guestSays = (error: unknown) => { nspawn.exec.mockImplementation(async () =>
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
    nspawn.exec.mockImplementation(async () => ({ code: 0, stdout: 'not json at all', stderr: '', truncated: false }));
    expect(await rejection(chunk)).toMatchObject({ code: 'guest_protocol', status: 500 });
    nspawn.exec.mockImplementation(async () => ({ code: 0, stdout: JSON.stringify({ ok: true, result: { kind: 'write-commit' } }), stderr: '', truncated: false }));
    expect(await rejection(chunk)).toMatchObject({ code: 'guest_protocol', status: 500 });
    nspawn.exec.mockImplementation(async () => ({ code: 0, stdout: '{}', stderr: '', truncated: true }));
    expect(await rejection(chunk)).toMatchObject({ code: 'guest_protocol', status: 500 });

    nspawn.exec.mockImplementation(real);
  });

  it('routes chunk uploads through the canonical actor and generation bound file control', async () => {
    const { runtime, nspawn, root, sql, ctx } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    nspawn.exec.mockImplementation(async (...args: any[]) => {
      const argv = args[2]; const options = args[3];
      const request = JSON.parse(options.input);
      const inputJson = JSON.stringify({
        ...request,
        root,
        path: request.path.replace('/sales-dashboard', root),
        ...(request.resolvedPath ? { resolvedPath: request.resolvedPath.replace('/sales-dashboard', root) } : {}),
      });
      const result = spawnSync(argv[0], argv.slice(1), { input: inputJson, encoding: 'utf8', maxBuffer: 2 ** 21,
        env: { ...process.env, ELOWEN_UPLOAD_ROOT: join(root, 'uploads') } });
      if (result.error) throw result.error;
      return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, truncated: false };
    });
    const path = '/sales-dashboard/uploaded';
    const hostPath = join(root, 'uploaded');
    const files = (operation: any, accountUserId = 1) => runtime.projectFiles({ ...input, accountUserId, operation });
    const begin = await files({ kind: 'write-begin', path, expectedVersion: null, size: 524289 });
    expect(begin.kind).toBe('write-begin');
    const uploadId = begin.uploadId;
    const calls = nspawn.exec.mock.calls.length;
    await expect(files({ kind: 'write-abort', path, uploadId }, 2)).rejects.toThrow(/another account/);
    expect(nspawn.exec.mock.calls.length).toBe(calls);
    await expect(files({ kind: 'write-chunk', path, uploadId, offset: 1, base64: 'YQ==' })).rejects.toThrow(/offset/);
    ctx.currentAccess = () => ({ readOnly: true });
    await expect(files({ kind: 'write-abort', path, uploadId })).rejects.toThrow(/read.only/);
    ctx.currentAccess = () => ({ readOnly: false });
    await files({ kind: 'write-chunk', path, uploadId, offset: 524288, base64: 'YQ==' });
    await files({ kind: 'write-chunk', path, uploadId, offset: 0, base64: Buffer.alloc(524288).toString('base64') });
    const done = await files({ kind: 'write-commit', path, uploadId });
    expect(done.entry.size).toBe(524289);
    expect(readFileSync(hostPath).length).toBe(524289);
    expect(await files({ kind: 'write-commit', path, uploadId })).toEqual(done);
    const next = await files({ kind: 'write-begin', path, expectedVersion: done.entry.version, size: 0 });
    expect(next.uploadId).not.toBe(uploadId);
    writeFileSync(hostPath, 'concurrent');
    await expect(files({ kind: 'write-commit', path, uploadId: next.uploadId })).rejects.toThrow(/version/);
    expect(readFileSync(hostPath, 'utf8')).toBe('concurrent');
    await runtime.revokeProjectAccess({ projectId: 7, accountUserId: 1 });
    expect(sql.prepare('SELECT id FROM p_sandbox_file_uploads').all()).toEqual([]);
  });
  // A project that has been snapshotted is still deletable, and the deletion reaches for no image and no
  // named volume handle on the way: a machine environment owns neither, and the runtime client refuses
  // both, so a delete that still asked for one would fail on its own snapshot rather than complete.
  it('deletes an environment with a snapshot without reaching for an image or a volume handle', async () => {
    const { runtime, nspawn, stores, db, containers, project } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'snapshot-start', action: { kind: 'start' } }); await runtime.reconcile();
    const row = db.prepare("SELECT spec_json FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get() as any;
    db.prepare("INSERT INTO p_sandbox_runtime_snapshots(id,kind,resource_id,generation,spec_json,manifest_json) VALUES('snapshot-kept','project','7',1,?,?)")
      .run(row.spec_json, JSON.stringify({ version: 2, snapshotId: 'snapshot-kept', trees: [] }));

    await runtime.requestEnvironment({ ...input, requestId: 'snapshot-recreate', action: { kind: 'recreate' } }); await runtime.reconcile();
    const op = await runtime.requestEnvironment({ ...input, requestId: 'snapshot-delete', action: { kind: 'delete' } }); await runtime.reconcile();

    const done = await runtime.environmentOperation({ operationId: op.id, accountUserId: 1 });
    expect(done?.status, done?.error ?? '').toBe('succeeded');
    expect(nspawn.removeSnapshotStorage).toHaveBeenCalledWith(expect.anything(), 'snapshot-kept');
    expect(nspawn.removeSnapshotImage).not.toHaveBeenCalled();
    expect(nspawn.removeVolume).not.toHaveBeenCalled();
    expect(containers.size).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get()).toEqual({ n: 0 });
    expect(stores.projects.finishDeletion).toHaveBeenCalledWith(7);
    expect(project.lifecycle).toBe('deleted');
  });

  it('keeps a failed delete checkpoint and converges when the same delete is requested again', async () => {
    const { runtime, nspawn, stores, db } = setup();
    await runtime.requestEnvironment({ ...input, action: { kind: 'start' } }); await runtime.reconcile();
    nspawn.removeStorage.mockRejectedValueOnce(new Error('disk busy'));
    const op = await runtime.requestEnvironment({ ...input, requestId: 'retry-delete', action: { kind: 'delete' } }); await runtime.reconcile();
    expect((await runtime.environmentOperation({ operationId: op.id, accountUserId: 1 }))?.status).toBe('failed');
    expect(stores.projects.finishDeletion).not.toHaveBeenCalled();

    const retried = await runtime.requestEnvironment({ ...input, requestId: 'retry-delete', action: { kind: 'delete' } });
    expect(retried.id).toBe(op.id);
    await runtime.reconcile();
    expect((await runtime.environmentOperation({ operationId: op.id, accountUserId: 1 }))?.status).toBe('succeeded');
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get()).toEqual({ n: 0 });
    expect(stores.projects.finishDeletion).toHaveBeenCalledWith(7);
  });

  it('retires a running historical Site machine exactly once and retains its audit data', async () => {
    const { runtime, db, nspawn } = setup();
    const stored = { input: { resource: { kind: 'site', id: 'retired-site' }, generation: 4,
      disk: { id: 'b'.repeat(32), runtime: 'nspawn', sourceImage: 'site-base@1' } },
    binding: { namespace: 'elowen' }, containerId: 'c'.repeat(64) };
    const spec = JSON.stringify(stored);
    db.prepare(`INSERT INTO p_sandbox_runtimes(kind,resource_id,project_id,generation,state,desired_state,spec_json,limits_json,error)
      VALUES('site','retired-site',7,4,'running','running',?,'{}','retained failure')`).run(spec);
    db.prepare(`INSERT INTO p_sandbox_runtime_operations(id,kind,resource_id,user_id,request_key,generation,action_json,status)
      VALUES('env_retired_site','site','retired-site',1,'retained-start',4,'{"kind":"start"}','pending')`).run();
    db.prepare(`INSERT INTO p_sandbox_runtime_snapshots(id,kind,resource_id,generation,spec_json,manifest_json,note)
      VALUES('retained-snapshot','site','retired-site',4,?,'{}','audit')`).run(spec);
    db.prepare("INSERT INTO p_sandbox_runtime_logs(kind,resource_id,message) VALUES('site','retired-site','retained log')").run();

    await runtime.reconcile();
    await runtime.reconcile();
    await runtime.revokeAccount(1);

    expect(nspawn.retireLegacySiteMachine).toHaveBeenCalledTimes(1);
    expect(nspawn.retireLegacySiteMachine).toHaveBeenCalledWith(stored);
    expect(nspawn.inspect).not.toHaveBeenCalled();
    expect(nspawn.create).not.toHaveBeenCalled();
    expect(nspawn.start).not.toHaveBeenCalled();
    expect(nspawn.exec).not.toHaveBeenCalled();
    expect(db.prepare("SELECT state,desired_state,spec_json,error FROM p_sandbox_runtimes WHERE kind='site' AND resource_id='retired-site'").get())
      .toEqual({ state: 'stopped', desired_state: 'stopped', spec_json: spec, error: 'retained failure' });
    expect(db.prepare("SELECT status FROM p_sandbox_runtime_operations WHERE id='env_retired_site'").get()).toEqual({ status: 'pending' });
    expect(db.prepare("SELECT note,spec_json FROM p_sandbox_runtime_snapshots WHERE kind='site' AND resource_id='retired-site'").get())
      .toEqual({ note: 'audit', spec_json: spec });
    expect(db.prepare("SELECT COUNT(*) AS count FROM p_sandbox_runtime_logs WHERE kind='site' AND resource_id='retired-site' AND message='retained log'").get())
      .toEqual({ count: 1 });
  });

  it('leaves a deleted historical Site row untouched and out of readiness', async () => {
    const { runtime, db, nspawn } = setup();
    const spec = JSON.stringify({ input: { resource: { kind: 'site', id: 'deleted-site' }, generation: 8,
      disk: { id: 'd'.repeat(32), runtime: 'nspawn', sourceImage: 'localhost/deleted-site:1' } },
    binding: { namespace: 'elowen' }, containerId: 'e'.repeat(64) });
    db.prepare(`INSERT INTO p_sandbox_runtimes(kind,resource_id,project_id,generation,state,desired_state,spec_json,limits_json,error)
      VALUES('site','deleted-site',7,8,'deleted','deleted',?,'{}','retained error')`).run(spec);

    await runtime.reconcile();

    expect(nspawn.retireLegacySiteMachine).not.toHaveBeenCalled();
    expect(db.prepare("SELECT state,desired_state,spec_json,error FROM p_sandbox_runtimes WHERE kind='site' AND resource_id='deleted-site'").get())
      .toEqual({ state: 'deleted', desired_state: 'deleted', spec_json: spec, error: 'retained error' });
    const readiness = await runtime.machineRuntimeReadiness({ accountUserId: 3 });
    expect(readiness.requirements.find((entry: any) => entry.id === 'runtime:legacy-references')).toMatchObject({ ok: true });
  });

  /** A detach ends the sweep at the next unit of work, and one historical Site machine is one unit. The
   *  rest of the batch belongs to the generation that continues the retirement, not to the one going away. */
  it('leaves the remaining legacy Site machines to the next generation when the sweep is detached', async () => {
    const { runtime, db, nspawn } = setup();
    for (const [id, generation] of [['site-first', 4], ['site-second', 5]] as const) {
      db.prepare(`INSERT INTO p_sandbox_runtimes(kind,resource_id,project_id,generation,state,desired_state,spec_json,limits_json,error)
        VALUES('site',?,7,?,'running','running',?,'{}',NULL)`).run(id, generation, JSON.stringify({
        input: { resource: { kind: 'site', id }, generation, disk: { id: 'b'.repeat(32), runtime: 'nspawn', sourceImage: 'site-base@1' } },
        binding: { namespace: 'elowen' }, containerId: 'c'.repeat(64) }));
    }
    const retire = nspawn.retireLegacySiteMachine.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    nspawn.retireLegacySiteMachine.mockImplementationOnce(async (spec: any) => { await gate; return await (retire as any)(spec); });

    const sweeping = runtime.reconcile();
    await vi.waitFor(() => expect(nspawn.retireLegacySiteMachine).toHaveBeenCalledTimes(1));
    const detaching = runtime.dispose();
    release();
    await detaching;
    await expect(sweeping).resolves.toBeUndefined();

    expect(nspawn.retireLegacySiteMachine).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT state FROM p_sandbox_runtimes WHERE kind='site' AND resource_id='site-first'").get()).toEqual({ state: 'stopped' });
    expect(db.prepare("SELECT state FROM p_sandbox_runtimes WHERE kind='site' AND resource_id='site-second'").get()).toEqual({ state: 'running' });
  });
});

describe('project root filesystem binding', () => {
  // A recipe revision is a hand-set integer, not a hash of the recipe's own text: `project-base@1` names
  // the same published bytes on every host, and the packages below are what an environment gets by being
  // built from them rather than by anything the host installs afterwards.
  it('names the published artifact a new environment is built from, and it carries the PDF tools Read advertises', () => {
    expect(PROJECT_ROOTFS).toBe('project-base@1');
    expect(ROOTFS_RECIPES['project-base'].packages).toContain('poppler-utils');
  });

  it('stamps a NEW environment with the artifact reference and fetches it instead of building anything', async () => {
    const { runtime, nspawn, storage, sql } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'fresh', action: { kind: 'start' } });
    await runtime.reconcile();

    // Both halves, because they are read by different things: the envelope names the image and the disk
    // record names the bytes its root filesystem was unpacked from.
    const stored = JSON.parse((sql.prepare("SELECT spec_json FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get() as any).spec_json);
    expect(stored.input.image).toBe(PROJECT_ROOTFS);
    expect(stored.input.disk.sourceImage).toBe(PROJECT_ROOTFS);
    expect(nspawn.create.mock.calls[0]![0].disk.sourceImage).toBe(PROJECT_ROOTFS);

    // Materialization is the artifact store's download, reached through `prepare`. Nothing on this host
    // runs a package manager against a distribution mirror to produce a root filesystem any more.
    expect(storage.prepare).toHaveBeenCalledWith(expect.objectContaining({ disk: expect.objectContaining({ sourceImage: PROJECT_ROOTFS }) }),
      expect.objectContaining({ onProgress: expect.any(Function) }));
    expect(nspawn.ensureProjectImage).not.toHaveBeenCalled();
  });

  it('leaves an environment bound to an earlier artifact on the root filesystem it was built with', async () => {
    const { runtime, nspawn, storage, sql } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'initial', action: { kind: 'start' } });
    await runtime.reconcile();
    expect((await runtime.environmentFor(input)).state).toBe('running');

    // Put the row into the state every already-provisioned project is in the moment the catalogue moves
    // on: its stored specification names the revision it was actually built from.
    const earlier = 'project-base@7';
    const row = sql.prepare('SELECT kind, resource_id, spec_json FROM p_sandbox_runtimes').get() as any;
    const spec = JSON.parse(row.spec_json);
    spec.input.image = earlier;
    spec.input.disk.sourceImage = earlier;
    sql.prepare('UPDATE p_sandbox_runtimes SET spec_json=? WHERE kind=? AND resource_id=?')
      .run(JSON.stringify(spec), row.kind, row.resource_id);

    storage.prepare.mockClear();
    nspawn.create.mockClear();
    nspawn.remove.mockClear();
    await runtime.requestEnvironment({ ...input, requestId: 'cycle-stop', action: { kind: 'stop' } });
    await runtime.reconcile();
    await runtime.requestEnvironment({ ...input, requestId: 'cycle-start', action: { kind: 'start' } });
    await runtime.reconcile();

    // Nothing was fetched on this project's behalf, nothing was removed, and nothing was recreated: the
    // container it had is the container it still has, on the disk it already materialized.
    expect(storage.prepare).not.toHaveBeenCalled();
    expect(nspawn.ensureProjectImage).not.toHaveBeenCalled();
    expect(nspawn.create).not.toHaveBeenCalled();
    expect(nspawn.remove).not.toHaveBeenCalled();
    expect(nspawn.start.mock.calls.at(-1)![0].image).toBe(earlier);
    expect((await runtime.environmentFor(input)).state).toBe('running');

    // And the stored specification still names the earlier artifact afterwards — nothing rewrote it.
    const after = JSON.parse((sql.prepare('SELECT spec_json FROM p_sandbox_runtimes').get() as any).spec_json);
    expect(after.input.image).toBe(earlier);
  });
});

describe('adopted workspace rollback', () => {

  it('removes the provisioned environment and moves its workspace back through storage', async () => {
    const { runtime, nspawn, storage, project, sql, root } = setup();
    project.adoptedPath = join(root, 'host-project');
    await runtime.requestEnvironment({ ...input, requestId: 'adopted-start', action: { kind: 'start' } });
    await runtime.reconcile();

    await runtime.releaseAdoptedWorkspace(input);

    expect(nspawn.stop).toHaveBeenCalledOnce();
    expect(nspawn.remove).toHaveBeenCalledOnce();
    // A machine environment holds no named volume handles, and the runtime client refuses the method,
    // so a release that still asked for one would fail rather than hand the directory back.
    expect(nspawn.removeVolume).not.toHaveBeenCalled();
    expect(storage.releaseWorkspace).toHaveBeenCalledWith(expect.anything(), project.adoptedPath);
    expect(nspawn.removeStorage).toHaveBeenCalledOnce();
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
    const { runtime, nspawn, sql, publicationSocket } = setup();
    await starting(runtime);
    const binding = await runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 8080 });
    const socketPath = publicationSocket(nspawn.create.mock.calls[0]![0], 'shop');
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
    expect(nspawn.startPublication).toHaveBeenCalledTimes(2);
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    // The same publication, established again: one forwarder, one record.
    expect(records(sql)).toHaveLength(1);
  });

  it('logs publication recovery transitions once instead of retrying every reconciliation tick', async () => {
    vi.useFakeTimers();
    cleanup.push(() => vi.useRealTimers());
    const { runtime, nspawn, containers, db, endForwarders, staleSocket } = setup();
    await starting(runtime);
    const binding = await runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 8080 });
    await endForwarders();
    staleSocket(binding.socketPath);
    containers.values().next().value.state = 'created';

    // The first automatic restart succeeds. If the container dies again before the 30 second backoff has
    // elapsed, the durable row still says running while recovery deliberately waits.
    await runtime.reconcile();
    await endForwarders();
    staleSocket(binding.socketPath);
    containers.values().next().value.state = 'created';
    nspawn.startPublication.mockClear();
    await runtime.reconcile();
    for (let tick = 0; tick < 5; tick += 1) await runtime.reconcile();

    const messages = () => db.prepare("SELECT message FROM p_sandbox_runtime_logs WHERE kind='project' AND resource_id='7' ORDER BY id").all()
      .map((entry: any) => entry.message as string);
    expect(messages().filter((message: string) => message.includes('Publication reconciliation skipped'))).toHaveLength(1);
    expect(messages().filter((message: string) => message.includes('forwarder could not be established'))).toHaveLength(0);
    expect(nspawn.startPublication).not.toHaveBeenCalled();

    containers.values().next().value.state = 'running';
    await runtime.reconcile();
    await runtime.reconcile();

    expect(messages().filter((message: string) => message.includes('Publication reconciliation resumed'))).toHaveLength(1);
    expect(nspawn.startPublication).toHaveBeenCalledOnce();
  });

  it('restores only publications that belong to the project being started', async () => {
    const { runtime, nspawn, sql } = setup();
    await starting(runtime);
    sql.prepare("INSERT INTO p_sandbox_runtimes(kind,resource_id,project_id,state,desired_state,spec_json,limits_json) VALUES('publication','foreign',8,'running','running','{\"port\":9090}','{}')").run();
    await runtime.requestEnvironment({ ...input, requestId: 'scoped-stop', action: { kind: 'stop' } });
    await runtime.reconcile();
    await runtime.requestEnvironment({ ...input, requestId: 'scoped-start', action: { kind: 'start' } });
    await runtime.reconcile();
    expect(nspawn.startPublication.mock.calls.map((call: any[]) => call[1])).not.toContain('foreign');
  });

  it('keeps UUID publication transports within host limits and matches liveness by publication id', async () => {
    const publicationId = '6cd4e63e-5c4b-4f74-8b91-d61cd8da4d90';
    const realisticStorageRoot = '/var/www/.config/elowen/plugins-data/sandbox/projects/123456789/storage';
    expect(Buffer.byteLength(join(realisticStorageRoot, 'broker', publicationSocketName(publicationId)))).toBeLessThanOrEqual(107);

    const { runtime, nspawn } = setup();
    await starting(runtime);
    const binding = await runtime.projectPublicationBinding({ ...input, publicationId, port: 8080 });
    expect(Buffer.byteLength(binding.socketPath)).toBeLessThanOrEqual(107);
    nspawn.activePublications.mockClear();

    await runtime.reconcile();

    expect(nspawn.activePublications).toHaveBeenCalledWith(expect.anything(), [publicationId]);
  });

  it('shares one in-flight publication establishment between a request and reconciliation', async () => {
    const { runtime, nspawn } = setup();
    await starting(runtime);
    const startPublication = nspawn.startPublication.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    nspawn.startPublication.mockImplementation(async (spec: any, publicationId: string, argv: string[]) => {
      if (first) { first = false; await gate; }
      return await (startPublication as any)(spec, publicationId, argv);
    });

    const binding = runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 8080 });
    await vi.waitFor(() => expect(nspawn.startPublication).toHaveBeenCalledTimes(1));
    const reconciling = runtime.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const callsWhileBlocked = nspawn.startPublication.mock.calls.length;
    release();
    const results = await Promise.allSettled([binding, reconciling]);

    expect(callsWhileBlocked).toBe(1);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(nspawn.startPublication).toHaveBeenCalledTimes(1);
  });

  /** A binding that was admitted while this generation was live is DRAINED, not abandoned: it is what
   *  spawns the forwarder, and a forwarder started after the detach would outlive the generation that owns
   *  the socket it was told to remove. */
  it('drains an admitted publication binding before the detach completes', async () => {
    const { runtime, nspawn } = setup();
    await starting(runtime);
    const startPublication = nspawn.startPublication.getMockImplementation()!;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    nspawn.startPublication.mockImplementationOnce(async (spec: any, publicationId: string, argv: string[]) => {
      await gate;
      return await (startPublication as any)(spec, publicationId, argv);
    });

    const binding = runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 8080 });
    await vi.waitFor(() => expect(nspawn.startPublication).toHaveBeenCalledTimes(1));
    let detached = false;
    const detaching = runtime.dispose().then(() => { detached = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(detached).toBe(false);
    resume();
    await detaching;

    expect(detached).toBe(true);
    await expect(binding).resolves.toMatchObject({ generation: 1 });
    expect(nspawn.startPublication).toHaveBeenCalledOnce();
  });

  it('serializes release behind an in-flight publication establishment', async () => {
    const { runtime, nspawn, sql } = setup();
    await starting(runtime);
    const startPublication = nspawn.startPublication.getMockImplementation()!;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    nspawn.startPublication.mockImplementationOnce(async (spec: any, publicationId: string, argv: string[]) => {
      await gate;
      return await (startPublication as any)(spec, publicationId, argv);
    });

    const bindingPromise = runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 8080 });
    await vi.waitFor(() => expect(nspawn.startPublication).toHaveBeenCalledTimes(1));
    const releasePromise = runtime.projectPublicationRelease({ project: input.project, publicationId: 'shop' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(nspawn.stopPublication).not.toHaveBeenCalled();

    resume();
    const binding = await bindingPromise;
    await releasePromise;
    expect(nspawn.stopPublication).toHaveBeenCalledWith(expect.anything(), 'shop');
    expect(records(sql)).toEqual([]);
    expect(() => lstatSync(binding.socketPath)).toThrow();
  });

  it('restores a lost forwarder on reconciliation and keeps serving for an account that lost access', async () => {
    const { runtime, nspawn, members, forwarders, staleSocket, publicationSocket } = setup();
    await starting(runtime);
    await runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 8080 });
    const socketPath = publicationSocket(nspawn.create.mock.calls[0]![0], 'shop');
    expect(nspawn.startPublication).toHaveBeenCalledTimes(1);

    // A cycle with nothing to do costs no guest round trip: the socket file is the whole test.
    await runtime.reconcile();
    expect(nspawn.startPublication).toHaveBeenCalledTimes(1);

    // The forwarder is gone, but an unclean exit can leave a socket inode behind with nobody listening.
    const dying = forwarders.get('shop')!;
    await new Promise<void>((resolve) => dying.close(() => resolve()));
    forwarders.delete('shop');
    staleSocket(socketPath);
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    await runtime.reconcile();
    expect(nspawn.startPublication).toHaveBeenCalledTimes(2);
    expect(lstatSync(socketPath).isSocket()).toBe(true);

    // Nobody's account owns it: the visitor it answers is not a member of anything.
    members.delete(1);
    await runtime.reconcile();
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    expect(nspawn.stopPublication).not.toHaveBeenCalled();
  });

  it('refuses an unusable publication and releases it after its owner account is removed', async () => {
    const { runtime, nspawn, sql, containers, users } = setup();
    await starting(runtime);
    await expect(runtime.projectPublicationBinding({ ...input, publicationId: 'Shop 1', port: 8080 })).rejects.toThrow(/token/i);
    await expect(runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 0 })).rejects.toThrow(/port/i);
    const binding = await runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 8080 });

    users.delete(1);
    await expect(runtime.projectPublicationBinding({ project: input.project, publicationId: 'shop', port: 8080 })).resolves.toEqual(binding);
    await runtime.projectPublicationRelease({ project: input.project, publicationId: 'shop' });
    expect(nspawn.stopPublication).toHaveBeenCalledWith(expect.anything(), 'shop');
    expect(records(sql)).toEqual([]);
    expect(() => lstatSync(binding.socketPath)).toThrow();
    expect(nspawn.startPublication.mock.calls.at(-1)![1]).toBe('shop');

    // Deleting the environment takes every publication of the project with it, so no dead record is left
    // behind for reconciliation to chase.
    const remaining = { project: input.project, accountUserId: 2 };
    await runtime.projectPublicationBinding({ ...remaining, publicationId: 'shop', port: 8080 });
    await expect(runtime.requestEnvironment({ ...remaining, requestId: 'publication-delete', action: { kind: 'delete' } }))
      .rejects.toMatchObject({ code: 'published_sites_exist' });
    await runtime.projectPublicationRelease({ project: input.project, publicationId: 'shop' });
    await runtime.requestEnvironment({ ...remaining, requestId: 'publication-delete', action: { kind: 'delete' } });
    await runtime.reconcile();
    expect(records(sql)).toEqual([]);
    expect(containers.size).toBe(0);
  });
});

/** A host that has been provisioned for the machine runtime, which is the only host a NEW environment is
 *  built on. There is no flag and no per-environment choice: the readiness answer decides, once, and a
 *  host that answers no refuses the creation instead of quietly building a container instead. */
describe('a new environment on a machine host', () => {
  const guestWrite = (path: string, value: string) => `elowen-guest-write:${path}:${value}\n`;
  const guestRead = (path: string) => `elowen-guest-read:${path}\n`;
  const specOf = (sql: any) => JSON.parse((sql.prepare("SELECT spec_json FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get() as any).spec_json);

  async function machineProject() {
    const context = setup({}, 'ready');
    await context.runtime.requestEnvironment({ ...input, requestId: 'machine-start', action: { kind: 'start' } });
    await context.runtime.reconcile();
    return context;
  }

  it('builds a new environment on the machine runtime and records the choice on its disk', async () => {
    const { runtime, sql, nspawn, containers } = await machineProject();
    const created = nspawn.create.mock.calls.at(-1)![0] as any;

    expect(created.name).toBe('elowen-project-7-g1');
    expect(created.disk.runtime).toBe('nspawn');
    expect(containers.get('elowen-project-7-g1')?.state).toBe('running');
    // Its root filesystem came from the published artifact its disk record names; nothing on the host was
    // asked to build one, because nothing on this host can.
    expect(nspawn.ensureProjectImage).not.toHaveBeenCalled();
    // The choice is durable: it is on the disk record, which is the only discriminator the runtime reads.
    expect(specOf(sql).input.disk.runtime).toBe('nspawn');
    expect(specOf(sql).runtimePending).toBeUndefined();
    const environment = await runtime.environmentFor(input);
    expect(environment.state).toBe('running');
  });

  it('refuses to create anything on a host that is not ready and says what the host is missing', async () => {
    const { runtime, nspawn, storage } = setup({}, 'unready');

    const queued = await runtime.requestEnvironment({ ...input, requestId: 'machine-refused', action: { kind: 'start' } });
    await runtime.reconcile();

    const failed = await runtime.environmentOperation({ operationId: queued.id, accountUserId: 1 });
    expect(failed!.status).toBe('failed');
    // Every unmet row, with the command the helper named, rather than a generic "not ready".
    expect(failed!.error).toContain('systemd container tools');
    expect(failed!.error).toContain('run environment provisioning to install it');
    expect(failed!.error).toContain('Machine unit template');
    expect(failed!.error).toContain('systemctl daemon-reload');
    // A satisfied row is not noise the refusal has to carry.
    expect(failed!.error).not.toContain('Supported operating system');
    // Nothing was built, and no disk was materialized behind the refusal: the decision is taken before
    // the artifact is fetched, so an unready host costs no download either.
    expect(nspawn.create).not.toHaveBeenCalled();
    expect(storage.prepare).not.toHaveBeenCalled();
  });

  it('carries an installed package and an /etc change across envelope recreation', async () => {
    const { runtime, nspawn, containers, diskFiles } = await machineProject();
    const first = nspawn.create.mock.calls.at(-1)![0] as any;
    // What a guest actually leaves behind: a package's files under the root filesystem, and an edited
    // configuration file. Both are disk state, and the envelope holds neither.
    await nspawn.exec(first, 'a'.repeat(32), ['/bin/bash', '-s'], { input: guestWrite('/usr/bin/ripgrep', 'installed') });
    await nspawn.exec(first, 'b'.repeat(32), ['/bin/bash', '-s'], { input: guestWrite('/etc/elowen-machine.conf', 'tuned') });

    await runtime.requestEnvironment({ ...input, requestId: 'machine-recreate', action: { kind: 'recreate' } });
    await runtime.reconcile();

    const second = nspawn.create.mock.calls.at(-1)![0] as any;
    expect(nspawn.create).toHaveBeenCalledTimes(2);
    expect(containers.get('elowen-project-7-g1')?.state).toBe('running');
    // The SAME disk, and both writes still on it, read back through the rebuilt envelope.
    expect(second.disk.id).toBe(first.disk.id);
    expect((await nspawn.exec(second, 'c'.repeat(32), ['/bin/bash', '-s'], { input: guestRead('/usr/bin/ripgrep') })).stdout).toBe('installed');
    expect((await nspawn.exec(second, 'd'.repeat(32), ['/bin/bash', '-s'], { input: guestRead('/etc/elowen-machine.conf') })).stdout).toBe('tuned');
    expect(diskFiles.get(first.disk.id)!.size).toBe(2);
  });

  it('runs a command, a cancellation and a long-running service against the machine envelope', async () => {
    const { runtime, nspawn } = await machineProject();
    const spec = nspawn.create.mock.calls.at(-1)![0] as any;
    nspawn.exec.mockImplementationOnce(async () => ({ code: 7, stdout: 'out', stderr: 'err', truncated: false }));

    const result = await nspawn.exec(spec, 'e'.repeat(32), ['/bin/false']);
    expect(result).toMatchObject({ code: 7, stdout: 'out', stderr: 'err' });

    await runtime.projectPublicationBinding?.({ project: { kind: 'managed', projectId: 7 }, accountUserId: 1 }).catch(() => {});
    await nspawn.cancelExecution?.(spec, 'e'.repeat(32));
    // A stop is what ends a long-running guest service, and the envelope reports it as stopped rather
    // than leaving the row to guess.
    await runtime.requestEnvironment({ ...input, requestId: 'machine-stop', action: { kind: 'stop' } });
    await runtime.reconcile();
    expect((await runtime.environmentFor(input)).state).toBe('stopped');
  });

  it('changes limits, snapshots and restores without ever leaving the machine runtime', async () => {
    const { runtime, sql, nspawn, storage } = await machineProject();
    const first = nspawn.create.mock.calls.at(-1)![0] as any;

    await runtime.requestEnvironment({ ...input, accountUserId: 3, requestId: 'machine-limits', action: { kind: 'limits', limits: { cpus: 2, memoryMb: 2048, pidsLimit: 1024 } } });
    await runtime.reconcile();
    expect((nspawn.update.mock.calls.at(-1) as any[])[0].disk.id).toBe(first.disk.id);

    storage.snapshot.mockImplementation(async (_spec: any, snapshotId: string) => ({ version: 2, snapshotId,
      sourceImage: { reference: first.image, id: 'sha256:' + 'd'.repeat(64) }, trees: [], worktrees: [] }));
    const capture = await runtime.requestEnvironment({ ...input, requestId: 'machine-snapshot', action: { kind: 'snapshot' } });
    await runtime.reconcile();
    const saved = await runtime.environmentOperation({ operationId: capture.id, accountUserId: 1 });
    storage.readSnapshot.mockResolvedValue({ version: 2, snapshotId: saved!.snapshotId,
      sourceImage: { reference: first.image, id: 'sha256:' + 'd'.repeat(64) }, trees: [] });

    await runtime.requestEnvironment({ ...input, requestId: 'machine-restore', action: { kind: 'restore', snapshotId: saved!.snapshotId } });
    await runtime.reconcile();

    const restored = nspawn.create.mock.calls.at(-1)![0] as any;
    expect(restored.disk.id).not.toBe(first.disk.id);
    // A restore replaces the disk and NOT the runtime. A fresh disk record built without the marker would
    // hand a tree owned by the machine's uid range back to the container runtime, which cannot read it.
    expect(restored.disk.runtime).toBe('nspawn');
    expect(specOf(sql).input.disk.runtime).toBe('nspawn');
  });

  it('reports runtime ownership from disk.runtime regardless of historical source images', async () => {
    const { runtime, sql } = await machineProject();
    const base = sql.prepare("SELECT spec_json,limits_json FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get() as any;
    const insert = (id: number, state: string, runtimeName: string | undefined, sourceImage: string) => {
      const spec = JSON.parse(base.spec_json);
      spec.input.resource.id = id;
      spec.input.image = sourceImage;
      spec.input.disk.sourceImage = sourceImage;
      if (runtimeName === undefined) delete spec.input.disk.runtime;
      else spec.input.disk.runtime = runtimeName;
      sql.prepare(`INSERT INTO p_sandbox_runtimes(kind,resource_id,project_id,generation,state,desired_state,spec_json,limits_json)
        VALUES('project',?,?,1,?,'running',?,?)`).run(String(id), id, state, JSON.stringify(spec), base.limits_json);
    };
    const legacyImage = 'localhost/elowen-project-base:historical';
    const artifactImage = PROJECT_ROOTFS;

    const nspawn = specOf(sql);
    nspawn.input.image = legacyImage;
    nspawn.input.disk.sourceImage = legacyImage;
    sql.prepare("UPDATE p_sandbox_runtimes SET spec_json=? WHERE kind='project' AND resource_id='7'").run(JSON.stringify(nspawn));
    insert(8, 'running', 'nspawn', artifactImage);
    insert(9, 'running', undefined, artifactImage);
    insert(10, 'running', 'podman', artifactImage);
    insert(11, 'deleted', undefined, legacyImage);

    const first = await runtime.machineRuntimeReadiness({ accountUserId: 3 });
    expect(first.items.find((item: any) => item.id === 'runtime:legacy-references')).toMatchObject({ ok: false,
      detail: expect.stringContaining('2 environments still belong to the removed Podman runtime') });

    const supported = JSON.parse((sql.prepare("SELECT spec_json FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='9'").get() as any).spec_json);
    supported.input.disk.runtime = 'nspawn';
    supported.input.disk.sourceImage = legacyImage;
    sql.prepare("UPDATE p_sandbox_runtimes SET spec_json=? WHERE kind='project' AND resource_id='9'").run(JSON.stringify(supported));
    sql.prepare("UPDATE p_sandbox_runtimes SET state='deleted' WHERE kind='project' AND resource_id='10'").run();

    const mutated = await runtime.machineRuntimeReadiness({ accountUserId: 3 });
    expect(mutated.items.find((item: any) => item.id === 'runtime:legacy-references')).toMatchObject({ ok: true });
  });

  it('reports the missing rows through the project overview, and the runtime once it is decided', async () => {
    const unready = setup({}, 'unready');
    const overview = await unready.runtime.projectOverview(input);
    expect(overview.runtime.pending).toBe(true);
    expect(overview.runtime.name).toBeNull();
    expect(overview.runtime.readiness.ready).toBe(false);
    // The rows travel to the surface as the helper wrote them: nothing is keyed off an id, and every
    // detail with its command survives the trip. The exact published root filesystem required by this
    // environment follows the host rows, and the instance's legacy count remains informational.
    expect(overview.runtime.readiness.items.map((item: any) => item.id))
      .toEqual(['os:supported', 'package:systemd-container', 'unit:elowen-machine', `rootfs:${PROJECT_ROOTFS}`, 'runtime:legacy-references']);
    expect(overview.runtime.readiness.items.find((item: any) => item.id === 'unit:elowen-machine').detail)
      .toContain('systemctl daemon-reload');
    expect(overview.runtime.readiness.items.at(-1)).toMatchObject({ id: 'runtime:legacy-references', ok: true });

    const ready = await machineProject();
    const decided = await ready.runtime.projectOverview(input);
    expect(decided.runtime).toEqual({ name: 'nspawn', pending: false, readiness: null });
  });
});

/** What two overlapping callers do to one shared piece of state. Each of these is a real interleaving:
 *  a browser polling the overview while a start asks for itself, a publication binding that validated the
 *  environment an operation has since changed, and a plugin reload whose sweep is still touching the host
 *  when the next generation begins. */
describe('environment concurrency boundaries', () => {
  const startProject = async (runtime: any, requestId: string) => {
    await runtime.requestEnvironment({ ...input, requestId, action: { kind: 'start' } });
    await runtime.reconcile();
  };
  const messagesOf = (db: any) => db.prepare("SELECT message FROM p_sandbox_runtime_logs WHERE kind='project' AND resource_id='7' ORDER BY id")
    .all().map((entry: any) => entry.message as string);

  // The answer is privileged and TTL-cached, and two callers ask at once in normal operation: the overview
  // polls, and a start takes a fresh probe of its own. Ordering them by when the probe STARTED is what
  // keeps the slower one from deciding what every later reader sees.
  it('keeps the newer host probe answer when the older probe finishes last', async () => {
    const { runtime, nspawn } = setup();
    // The fixture's own answer, which a prepared host gives: what the two probes below answer with.
    const ready = await nspawn.hostReadiness();
    const answers: Array<(value: any) => void> = [];
    nspawn.hostReadiness.mockImplementation(() => new Promise<any>((resolve) => { answers.push(resolve); }));
    nspawn.hostReadiness.mockClear();

    const older = runtime.machineRuntimeReadiness({ accountUserId: 3 });
    await vi.waitFor(() => expect(nspawn.hostReadiness).toHaveBeenCalledTimes(1));
    const newer = runtime.machineRuntimeReadiness({ accountUserId: 3 });
    await vi.waitFor(() => expect(nspawn.hostReadiness).toHaveBeenCalledTimes(2));

    // The probe that started LAST answers first, and it is the one the cache holds.
    answers[1]!(ready);
    expect((await newer).ready).toBe(true);

    // The probe that started FIRST answers last with what was true before the host was prepared. Its own
    // caller still gets its own answer, and nothing later may see it.
    answers[0]!({ ready: false, items: [{ id: 'package:systemd-container', label: 'systemd container tools', ok: false, detail: 'not installed' }] });
    expect((await older).ready).toBe(false);

    nspawn.hostReadiness.mockClear();
    expect((await runtime.machineRuntimeReadiness({ accountUserId: 3 })).ready).toBe(true);
    expect(nspawn.hostReadiness).not.toHaveBeenCalled();
  });

  it('does not let a start-time probe rewrite the answer the overview polls', async () => {
    const { runtime, nspawn, containers } = setup({ defaultNetworkMode: 'shared' });
    nspawn.hostReadiness.mockClear();
    // The overview records a host that can start a networked environment...
    expect((await runtime.machineRuntimeReadiness({ accountUserId: 3 })).ready).toBe(true);
    // ...and the host loses its firewall rows before the start asks for itself.
    nspawn.hostReadiness.mockResolvedValue({ ready: false, items: [{ id: 'firewall:forwarding', label: 'IPv4 forwarding', ok: false, detail: 'not enabled' }] });

    await runtime.requestEnvironment({ ...input, requestId: 'fresh-probe-start', action: { kind: 'start' } });
    await runtime.reconcile();

    expect(containers.size).toBe(1);
    // The envelope is built before the link is turned on, so the refusal lands with the machine created
    // and never started: no virtual ethernet is carried on a host that cannot isolate it.
    expect(nspawn.start).not.toHaveBeenCalled();
    expect((await runtime.environmentFor(input)).lastError).toContain('IPv4 forwarding');
    // The probe taken for the start is the start's alone: the polled answer it did not come from is
    // untouched, so the next reader still costs no round trip and still sees what the overview recorded.
    nspawn.hostReadiness.mockClear();
    expect((await runtime.machineRuntimeReadiness({ accountUserId: 3 })).ready).toBe(true);
    expect(nspawn.hostReadiness).not.toHaveBeenCalled();
  });

  /** Hold the ownership inspection `ready` makes, so a lifecycle change can land between the validation and
   *  the write that follows it. `release` returns the inspection to its own implementation. */
  const holdReadyInspection = (nspawn: any) => {
    const inspect = nspawn.inspect.getMockImplementation()!;
    nspawn.inspect.mockClear();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    nspawn.inspect.mockImplementation(async (spec: any) => {
      if (first) { first = false; await gate; }
      return await inspect(spec);
    });
    return { release, entered: () => vi.waitFor(() => expect(nspawn.inspect).toHaveBeenCalledTimes(1)) };
  };

  it('re-reads the Project before it records a publication the validated state no longer covers', async () => {
    const { runtime, nspawn, sql } = setup();
    await startProject(runtime, 'binding-fence-start');
    const hold = holdReadyInspection(nspawn);

    const binding = runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 8080 });
    await hold.entered();
    // The environment stops while the binding is suspended in the inspection that was meant to validate it.
    sql.prepare("UPDATE p_sandbox_runtimes SET state='stopped' WHERE kind='project' AND resource_id='7'").run();
    hold.release();

    await expect(binding).rejects.toMatchObject({ code: 'environment_busy', status: 409 });
    // No record and no forwarder: a publication must never be bound to a generation the environment left.
    expect((sql.prepare("SELECT COUNT(*) AS total FROM p_sandbox_runtimes WHERE kind='publication'").get() as any).total).toBe(0);
    expect(nspawn.startPublication).not.toHaveBeenCalled();
  });

  it('refuses a publication binding whose environment a lifecycle operation has taken over', async () => {
    const { runtime, nspawn, sql } = setup();
    await startProject(runtime, 'binding-busy-start');
    const hold = holdReadyInspection(nspawn);

    const binding = runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 8080 });
    await hold.entered();
    // A stop is queued while the binding is suspended; the row still says running, so only the operation
    // itself says the environment is no longer the caller's to bind.
    await runtime.requestEnvironment({ ...input, requestId: 'binding-busy-stop', action: { kind: 'stop' } });
    hold.release();

    await expect(binding).rejects.toMatchObject({ code: 'environment_busy', status: 409 });
    expect((sql.prepare("SELECT COUNT(*) AS total FROM p_sandbox_runtimes WHERE kind='publication'").get() as any).total).toBe(0);
  });

  // A plugin reload disposes one generation and registers the next over the same rows and the same host. A
  // sweep caught mid-flight must therefore be waited for: its `disposed` check stops it at the next unit of
  // work, and the operation that was in flight when the detach arrived is the last thing it touches.
  it('detaches only after the sweep it interrupted has stopped', async () => {
    const { runtime, nspawn, sql, containers } = setup();
    await startProject(runtime, 'detach-start');
    expect(containers.size).toBe(1);

    const inventory = nspawn.containerInventory.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    nspawn.containerInventory.mockImplementationOnce(async () => { await gate; return await inventory(); });

    const sweep = runtime.reconcile();
    await vi.waitFor(() => expect(nspawn.containerInventory).toHaveBeenCalled());
    // Work is queued between two units of the sweep, and the generation is detached with the sweep still
    // inside its inventory round trip.
    const stop = await runtime.requestEnvironment({ ...input, requestId: 'detach-stop', action: { kind: 'stop' } });
    let detached = false;
    const disposal = runtime.dispose().then(() => { detached = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(detached).toBe(false);

    release();
    await disposal;
    await sweep;
    // The queued stop was never claimed, because the sweep ended instead of starting another unit of work.
    expect((sql.prepare('SELECT status FROM p_sandbox_runtime_operations WHERE id=?').get(stop.id) as any).status).toBe('pending');
    expect(nspawn.stop).not.toHaveBeenCalled();
  });

  // The map that suppresses a repeated publication-recovery line is keyed by project and only ever reports a
  // STANDING condition. A project that stopped while that condition stood has nothing left to reconcile, so
  // the entry goes with the condition rather than surviving to be reported as a resumption later on.
  it('forgets the recovery condition of a project that stopped while it stood', async () => {
    // The exhausted wording `queueAutomaticRecovery` itself writes, which is what makes the condition
    // terminal and therefore stable across sweeps without queueing another attempt.
    const terminal = 'Automatic recovery failed after 4 attempts; the container is still not running';
    const { runtime, nspawn, sql, containers, db } = setup();
    await startProject(runtime, 'condition-start');
    await runtime.projectPublicationBinding({ ...input, publicationId: 'shop', port: 8080 });
    sql.prepare("UPDATE p_sandbox_runtimes SET state='failed', error=? WHERE kind='project' AND resource_id='7'").run(terminal);
    containers.values().next().value.state = 'created';

    await runtime.reconcile();
    expect(messagesOf(db).filter((message) => message.includes('Publication reconciliation skipped'))).toHaveLength(1);

    // The project stops between two sweeps, which is what a completed stop leaves behind in the row.
    sql.prepare("UPDATE p_sandbox_runtimes SET state='stopped' WHERE kind='project' AND resource_id='7'").run();
    await runtime.reconcile();
    // ...and it runs again, with its machine up, so the condition it had is genuinely gone.
    sql.prepare("UPDATE p_sandbox_runtimes SET state='running' WHERE kind='project' AND resource_id='7'").run();
    containers.values().next().value.state = 'running';
    await runtime.reconcile();
    await runtime.reconcile();

    expect(messagesOf(db).filter((message) => message.includes('Publication reconciliation resumed'))).toHaveLength(0);
    expect(nspawn.startPublication).toHaveBeenCalledTimes(1);
  });
});
