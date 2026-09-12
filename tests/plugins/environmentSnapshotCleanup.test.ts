import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import { createEnvironmentRuntime } from '../../plugins/sandbox/lib/environmentRuntime.mjs';
import { PROJECT_ARTIFACT, artifactReference } from '../../plugins/sandbox/lib/rootfsCatalog.mjs';
import type { ContainerStorage } from '../../plugins/sandbox/lib/containerStorage.mjs';

/** Snapshot CLEANUP on a machine environment, which is where two image-era assumptions survived the move
 *  to persistent disks and made an ordinary environment unusable.
 *
 *  A machine snapshot is a copy of the disk's trees. It has no image, so its manifest is version 2 and
 *  carries `trees` and `sourceImage` — there is no `image.reference` on it and there is no committed image
 *  to delete. Both paths below nevertheless reached for one, and the runtime client answers that request
 *  by refusing it, so the failure landed on the operator as an environment that could not be released and
 *  a Site whose retention pruning threw on its own manifest. */
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

const PROJECT_ROOTFS = artifactReference(PROJECT_ARTIFACT);
const ADOPTED = '/adopted/sales-dashboard';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'env-snapshot-cleanup-'));
  const sql = openDb(':memory:');
  const db = makePluginDb(sql, 'sandbox', { canMigrate: true });
  const project: any = { id: 7, slug: 'sales-dashboard', executionKind: 'managed', lifecycle: 'active', adoptedPath: ADOPTED };
  const stores = {
    usersRead: { list: () => [{ id: 1 }], isAdmin: () => true, mayUsePlugin: () => true },
    userProjects: { canAccess: () => true, canManage: () => true },
    projects: { get: (id: number) => (id === 7 ? project : null), list: () => [project], beginDeletion: () => true, finishDeletion: () => true },
  };
  const ctx: any = { db: () => db, host: { stores: () => stores }, currentAccountUserId: () => null,
    currentAccess: () => ({ readOnly: false }), config: {}, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  initSandboxDb(ctx);

  const machines = new Map<string, { id: string; state: string }>();
  /** Exactly what the real machine client answers. A disk-backed environment snapshots its disk, so the
   *  image methods are refused rather than emulated — a fake that quietly accepted them would hide the
   *  very call this file is about. */
  const nspawn: any = {
    containerInventory: vi.fn(async () => new Map([...machines].map(([name, row]) => [name, row.state]))),
    containerExists: vi.fn(async (spec: any) => machines.has(spec.name)),
    inspect: vi.fn(async (spec: any) => machines.get(spec.name) ?? null),
    create: vi.fn(async (spec: any) => { const row = { id: 'c'.repeat(64), state: 'stopped' }; machines.set(spec.name, row); return row; }),
    start: vi.fn(async (spec: any) => { machines.get(spec.name)!.state = 'running'; }),
    stop: vi.fn(async (spec: any) => { machines.get(spec.name)!.state = 'stopped'; }),
    remove: vi.fn(async (spec: any) => { machines.delete(spec.name); }),
    removeByName: vi.fn(async (spec: any) => { machines.delete(spec.name); }),
    pause: vi.fn(), unpause: vi.fn(), update: vi.fn(),
    waitForSystemBus: vi.fn(async () => {}), systemRunning: vi.fn(async () => 'running'),
    exec: vi.fn(async () => ({ code: 0, stdout: '', stderr: '', truncated: false })),
    cancelExecution: vi.fn(async () => ({ terminated: true })), releaseExecution: vi.fn(),
    startPublication: vi.fn(), stopPublication: vi.fn(), activePublications: vi.fn(async () => []),
    removeStorage: vi.fn(), removeGenerationStorage: vi.fn(), removeSnapshotStorage: vi.fn(),
    removeDiskPath: vi.fn(), syncDiskTree: vi.fn(),
    materializeRootfs: vi.fn(async () => `sha256:${'a'.repeat(64)}`),
    hostReadiness: vi.fn(async () => ({ ready: true, items: [{ id: 'unit:elowen-machine', label: 'Machine unit template', ok: true, detail: 'installed' }] })),
    snapshotImage: vi.fn(async () => { throw new Error('A disk-backed environment snapshots its disk, not an image'); }),
    inspectSnapshotImage: vi.fn(async () => { throw new Error('A disk-backed environment snapshots its disk, not an image'); }),
    removeSnapshotImage: vi.fn(async () => { throw new Error('A disk-backed environment snapshots its disk, not an image'); }),
  };

  /** A version-2 manifest, which is the only shape a machine snapshot has. Note what is NOT on it: no
   *  `image`, so anything dereferencing `manifest.image.reference` throws on its own stored data. */
  const diskManifest = (snapshotId: string) => ({
    version: 2, snapshotId, resource: { kind: 'project', id: 7 }, generation: 1,
    consistency: 'crash-consistent', completeProject: true,
    sourceImage: { reference: PROJECT_ROOTFS, id: `sha256:${'a'.repeat(64)}` }, trees: [],
  });
  const storage: any = { prepare: vi.fn(), adoptWorkspace: vi.fn(async () => true), releaseWorkspace: vi.fn(async () => true),
    readSnapshot: vi.fn(), restoreVolumes: vi.fn(), removeDisk: vi.fn(),
    snapshot: vi.fn(async (_spec: any, snapshotId: string) => diskManifest(snapshotId)) };

  const runtime = createEnvironmentRuntime({ ctx, db, dataDir: root, namespace: 'elowen',
    nspawn, storage: storage as unknown as ContainerStorage, daemon: true });
  cleanup.push(() => { runtime.dispose(); sql.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, nspawn, storage, db, project, root };
}

const actor = { project: { kind: 'managed' as const, projectId: 7 }, accountUserId: 1 };

async function startedWithSnapshot(runtime: any) {
  await runtime.requestEnvironment({ ...actor, requestId: 'start', action: { kind: 'start' } });
  await runtime.reconcile();
  const taken = await runtime.requestEnvironment({ ...actor, requestId: 'snap', action: { kind: 'snapshot' } });
  await runtime.reconcile();
  const op = await runtime.environmentOperation({ accountUserId: 1, operationId: taken.id });
  expect(op?.status, op?.error ?? 'snapshot did not complete').toBe('succeeded');
  return op;
}

/** A row exists from the moment somebody LOOKS at a project, and the runtime it will use is not decided
 *  until the first start: deciding it needs a privileged readiness round trip, which a read must not make.
 *  So between those two moments the row carries no `disk.runtime`, and that is the one shape the runtime
 *  selector refuses by design. Stopping or deleting such a row must not go looking for a machine, because
 *  no machine, no disk and no storage directory has ever existed for it. */
describe('an environment that was never started', () => {
  it('is deletable, rather than refused for not having picked a runtime yet', async () => {
    const { runtime, nspawn } = setup();
    // Reading the project is what inserts the row, exactly as the overview does.
    const before = await runtime.environmentFor(actor);
    expect(before.generation).toBe(1);

    const requested = await runtime.requestEnvironment({ ...actor, requestId: 'delete-unstarted', action: { kind: 'delete' } });
    await runtime.reconcile();
    const op = await runtime.environmentOperation({ accountUserId: 1, operationId: requested.id });
    expect(op?.status, op?.error ?? 'delete did not complete').toBe('succeeded');
    // Nothing was ever created, so nothing is asked of the machine runtime on the way out.
    expect(nspawn.containerExists).not.toHaveBeenCalled();
    expect(nspawn.removeStorage).not.toHaveBeenCalled();
  });

  it('is stoppable, and stays stopped rather than reporting a runtime failure', async () => {
    const { runtime, nspawn } = setup();
    await runtime.environmentFor(actor);
    const requested = await runtime.requestEnvironment({ ...actor, requestId: 'stop-unstarted', action: { kind: 'stop' } });
    await runtime.reconcile();
    const op = await runtime.environmentOperation({ accountUserId: 1, operationId: requested.id });
    expect(op?.status, op?.error ?? 'stop did not complete').toBe('succeeded');
    expect(nspawn.stop).not.toHaveBeenCalled();
  });
});

describe('machine environment snapshot cleanup', () => {
  it('releases an adopted project that has snapshots instead of asking its runtime for an image', async () => {
    const { runtime, nspawn, storage } = setup();
    await startedWithSnapshot(runtime);

    // The release is the operator's way back out of an adopted project, and a project that has ever been
    // snapshotted must not be the one shape it refuses.
    await expect(runtime.releaseAdoptedWorkspace({ project: actor.project, accountUserId: 1 })).resolves.toBeUndefined();
    expect(nspawn.removeSnapshotImage).not.toHaveBeenCalled();
    expect(storage.releaseWorkspace).toHaveBeenCalled();
  });

  it('prunes Site snapshots past the retention bound without reading an image off a disk manifest', async () => {
    const { runtime, nspawn } = setup();
    const registration: any = { siteId: 'shop', projectId: 7, image: PROJECT_ROOTFS, persistentRootfs: true,
      sourcePath: '/sites/shop/source', sitesDataDir: '/sites', brokerDir: '/sites/shop/broker',
      network: 'isolated', workspaceReadOnly: true, limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 },
      // Keep one. The second snapshot therefore pushes the first past the bound, which is the path that
      // reached into `manifest.image.reference` on a manifest that has no `image` at all.
      snapshotRetention: 1 };
    runtime.connectSitesRuntime({ resolve: async () => registration, beforeStart: async () => {}, afterStop: async () => {},
      projectDependents: async () => [], beforeCreate: async () => {} });
    await runtime.registerSiteEnvironment({ siteId: 'shop', accountUserId: 1 });
    await runtime.requestSiteEnvironment({ siteId: 'shop', accountUserId: 1, requestId: 's1', action: { kind: 'start' } });
    await runtime.reconcile();

    for (const requestId of ['snap-1', 'snap-2', 'snap-3']) {
      const taken = await runtime.requestSiteEnvironment({ siteId: 'shop', accountUserId: 1, requestId, action: { kind: 'snapshot' } });
      await runtime.reconcile();
      const op = await runtime.siteEnvironmentOperation({ accountUserId: 1, operationId: taken.id });
      expect(op?.status, op?.error ?? `${requestId} did not complete`).toBe('succeeded');
    }
    expect(nspawn.removeSnapshotImage).not.toHaveBeenCalled();
    expect(nspawn.removeSnapshotStorage).toHaveBeenCalled();
  });
});
