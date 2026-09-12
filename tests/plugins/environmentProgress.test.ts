import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import { createEnvironmentRuntime } from '../../plugins/sandbox/lib/environmentRuntime.mjs';
import type { NspawnClient } from '../../plugins/sandbox/lib/nspawn.mjs';
import type { ContainerStorage } from '../../plugins/sandbox/lib/containerStorage.mjs';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'env-progress-'));
  const sql = openDb(':memory:');
  const db = makePluginDb(sql, 'sandbox', { canMigrate: true });
  const project: any = { id: 7, slug: 'sales-dashboard', executionKind: 'managed', lifecycle: 'active', path: '/not-a-host-path' };
  const stores = {
    usersRead: { list: () => [{ id: 1 }, { id: 3 }], isAdmin: (id: number) => id === 3, mayUsePlugin: () => true },
    userProjects: { canAccess: () => project.lifecycle === 'active', canManage: () => true },
    projects: { get: (id: number) => id === 7 ? project : null, list: () => [project], beginDeletion: () => { project.lifecycle = 'deleting'; return true; }, finishDeletion: vi.fn(() => true) },
  };
  const published: any[] = [];
  const ctx: any = { db: () => db, host: { stores: () => stores }, currentAccountUserId: () => null, currentAccess: () => ({ readOnly: false }),
    config: {}, publishEvent: (event: unknown) => { published.push(event); }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  initSandboxDb(ctx);
  const containers = new Map<string, any>();
  let busReady = false;
  let busFails = false;
  const nspawn = {
    containerInventory: vi.fn(async () => new Map([...containers].map(([name, row]) => [name, row.state]))),
    // No runtime this release ships builds an image on the host. The spy is kept so a start that ever
    // reached for one again would be caught here rather than by whoever waited on the build.
    ensureProjectImage: vi.fn(async () => { throw new Error('nothing builds a root filesystem on the host'); }),
    // The real client verifies the machine against the specification it is asked about, so one written
    // for a different mount layout fails ownership instead of being adopted or removed.
    inspect: vi.fn(async (spec: any) => {
      const row = containers.get(spec.name);
      if (!row) return null;
      if (row.workdir !== spec.workdir) throw new Error('Machine ownership or runtime specification mismatch');
      return row;
    }),
    create: vi.fn(async (spec: any) => {
      if (spec.disk?.runtime !== 'nspawn') throw new Error('systemd-nspawn runs only rootfs-backed environments');
      const row = { id: 'a'.repeat(64), state: 'created', workdir: spec.workdir }; containers.set(spec.name, row); return row;
    }),
    start: vi.fn(async (spec: any) => { containers.get(spec.name).state = 'running'; }),
    stop: vi.fn(async (spec: any) => { containers.get(spec.name).state = 'stopped'; }),
    remove: vi.fn(async (spec: any) => { containers.delete(spec.name); }),
    removeByName: vi.fn(async (spec: any) => { containers.delete(spec.name); }),
    pause: vi.fn(async (spec: any) => { containers.get(spec.name).state = 'paused'; }),
    unpause: vi.fn(async (spec: any) => { containers.get(spec.name).state = 'running'; }),
    update: vi.fn(async () => {}),
    // The real guest: every execution goes through `systemd-run`, so until the system bus is listening a
    // command does not run at all. This is the shape the machine on the live host produced — the bus
    // socket absent while PID 1 was already up, and dbus refused with exactly this message.
    exec: vi.fn(async () => busReady
      ? { code: 0, stdout: '', stderr: '', truncated: false }
      : { code: 1, stdout: '', stderr: 'Failed to connect to bus: No such file or directory', truncated: false }),
    waitForSystemBus: vi.fn(async () => { if (busFails) throw new Error('Guest system bus did not become available within 120s (systemd reports initializing)'); busReady = true; }),
    systemRunning: vi.fn(async () => 'running'),
    cancelExecution: vi.fn(async () => ({ terminated: true })), releaseExecution: vi.fn(),
    startPublication: vi.fn(), stopPublication: vi.fn(), activePublications: vi.fn(async () => []),
    removeStorage: vi.fn(), removeGenerationStorage: vi.fn(), removeSnapshotStorage: vi.fn(), removeDiskPath: vi.fn(), syncDiskTree: vi.fn(),
    containerExists: vi.fn(async (spec: any) => containers.has(spec.name)),
    hostReadiness: vi.fn(async () => ({ ready: true, items: [{ id: 'unit:elowen-machine', label: 'Machine unit template', ok: true, detail: 'installed and loaded' }] })),
  };
  const storage = { prepare: vi.fn(), snapshot: vi.fn(), readSnapshot: vi.fn(), restoreVolumes: vi.fn(), removeDisk: vi.fn() };
  const runtime = createEnvironmentRuntime({ ctx, db, dataDir: root, nspawn: nspawn as unknown as NspawnClient,
    storage: storage as unknown as ContainerStorage, daemon: true });
  cleanup.push(() => { runtime.dispose(); sql.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, db, ctx, nspawn, storage, containers, published, project, root,
    // A guest whose boot never finishes: the container runs, the bus never listens. That is what a host
    // out of inotify instances produced, and it must be reported as a boot that did not come up.
    failSystemBus: () => { busFails = true; } };
}
const input = { project: { kind: 'managed', projectId: 7 } as const, accountUserId: 1 };
const operationEvents = (published: any[]) => published.filter((event) => event.type === 'plugin' && event.kind === 'environment-operation');

describe('environment operation progress', () => {
  // Every surface that watches an operation reads the SAME durable row, so the step list has to exist on
  // it from the moment the intent is recorded rather than being assembled by whoever is watching.
  it('declares the step list when the operation is enqueued and walks it to completion', async () => {
    const { runtime, published } = setup();
    const enqueued = await runtime.requestEnvironment({ ...input, requestId: 'progress-start', action: { kind: 'start' } });
    expect(enqueued.steps).toEqual(['image', 'storage', 'container', 'boot', 'ready', 'initialize']);
    expect(enqueued.stepTotal).toBe(6);
    expect(enqueued.stepIndex).toBe(0);
    expect(enqueued.percent).toBe(0);

    await runtime.reconcile();
    const finished = await runtime.environmentOperation({ operationId: enqueued.id, accountUserId: 1 });
    expect(finished?.status).toBe('succeeded');
    expect(finished?.percent).toBe(100);
    expect(finished?.stepLabel).toBe('initialize');

    // The bar only ever moves forward, and it visits every declared step on the way.
    const seen = operationEvents(published).map((event) => event.data.operation);
    expect(seen.map((view: any) => view.stepLabel)).toContain('container');
    const percents = seen.map((view: any) => view.percent).filter((value: number | null) => value !== null);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
  });

  // A machine systemd calls "running" is not yet a guest that can run anything: `systemd-run`, which
  // carries every execution including project initialization, needs the guest system bus, and that is
  // activated some way into the boot. Waiting for it is the fix for a start that reported
  // `Failed to connect to bus: No such file or directory` at 94%.
  it('waits for the guest system bus before it initializes the project', async () => {
    const { runtime, nspawn } = setup();
    const op = await runtime.requestEnvironment({ ...input, requestId: 'bus', action: { kind: 'start' } });
    await runtime.reconcile();

    const done = await runtime.environmentOperation({ operationId: op.id, accountUserId: 1 });
    expect([done?.status, done?.error]).toEqual(['succeeded', null]);
    expect(nspawn.waitForSystemBus).toHaveBeenCalledTimes(1);
    // Order, not merely presence: initialization must not be the thing that discovers the bus is missing.
    expect(nspawn.waitForSystemBus.mock.invocationCallOrder[0]!).toBeLessThan(nspawn.exec.mock.invocationCallOrder[0]!);
  });

  // A guest that never finishes booting is a boot failure and has to read as one, on its own step.
  it('fails on the readiness step when the guest system never comes up', async () => {
    const { runtime, nspawn, failSystemBus } = setup();
    failSystemBus();
    const op = await runtime.requestEnvironment({ ...input, requestId: 'stalled', action: { kind: 'start' } });
    await runtime.reconcile();

    const failed = await runtime.environmentOperation({ operationId: op.id, accountUserId: 1 });
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('Guest system bus did not become available');
    expect(failed?.stepLabel).toBe('ready');
    expect(nspawn.exec).not.toHaveBeenCalled();
  });

  it('declares a different step list per action, and each one completes', async () => {
    const { runtime } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'up', action: { kind: 'start' } });
    await runtime.reconcile();

    for (const [action, steps] of [
      [{ kind: 'restart' }, ['quiesce', 'stop', 'image', 'storage', 'container', 'boot', 'ready', 'initialize']],
      [{ kind: 'stop' }, ['quiesce', 'stop']],
      [{ kind: 'recreate' }, ['remove', 'image', 'storage', 'container', 'boot', 'ready', 'initialize']],
    ] as const) {
      const op = await runtime.requestEnvironment({ ...input, requestId: `plan-${action.kind}`, action });
      expect(op.steps).toEqual(steps);
      await runtime.reconcile();
      const done = await runtime.environmentOperation({ operationId: op.id, accountUserId: 1 });
      expect([done?.status, done?.percent]).toEqual(['succeeded', 100]);
    }
  });

  it('reports admin limits and project deletion with their own steps', async () => {
    const { runtime, nspawn } = setup();
    (nspawn as any).update = vi.fn();
    await runtime.requestEnvironment({ ...input, requestId: 'up', action: { kind: 'start' } });
    await runtime.reconcile();

    const limits = await runtime.requestEnvironment({ project: input.project, accountUserId: 3, requestId: 'limits',
      action: { kind: 'limits', limits: { cpus: 2, memoryMb: 2048, pidsLimit: 512 } } });
    expect(limits.steps).toEqual(['apply']);
    await runtime.reconcile();
    expect((await runtime.environmentOperation({ operationId: limits.id, accountUserId: 3 }))?.percent).toBe(100);

    const removal = await runtime.requestEnvironment({ ...input, requestId: 'delete', action: { kind: 'delete' } });
    // A machine environment owns no image and no named volume handles, so the two steps that removed
    // them are gone from the plan rather than declared and skipped.
    expect(removal.steps).toEqual(['stop', 'containers', 'storage', 'records']);
    await runtime.reconcile();
    expect((await runtime.environmentOperation({ operationId: removal.id, accountUserId: 1 }))?.status).toBe('succeeded');
  });

  // A ceiling no container flag carries is not a limit. It used to be accepted, validated and stored so
  // the Sites plugin could keep sending it; a caller that still asks for it is now told instead.
  it('refuses a limits action carrying a ceiling nothing enforces', async () => {
    const { runtime } = setup();
    await expect(runtime.requestEnvironment({ project: input.project, accountUserId: 3, requestId: 'disk',
      action: { kind: 'limits', limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512, diskSoftMb: 10240 } } }))
      .rejects.toThrow(/Invalid environment limits/);
  });

  // Downloading the published root filesystem is the one part of a start that can take minutes, so the
  // bytes that arrive are what moves the bar. A transfer whose length the host does not know has to read
  // as indeterminate rather than hold the bar at the last figure it happened to have.
  it('derives the image step from the root filesystem download and goes indeterminate without a total', async () => {
    const { runtime, db, published, nspawn, storage } = setup();
    const live: (number | null)[] = [];
    storage.prepare.mockImplementation(async (_spec: unknown, options: { onProgress: (received: number, total: number) => void }) => {
      for (const [received, total] of [[1024, 4096], [2048, 0], [3072, 4096]]) {
        options.onProgress(received, total);
        live.push((db.prepare("SELECT percent FROM p_sandbox_runtime_operations WHERE kind='project'").get() as { percent: number | null }).percent);
      }
    });
    const op = await runtime.requestEnvironment({ ...input, requestId: 'fetch', action: { kind: 'start' } });
    await runtime.reconcile();

    // The durable row is what a watcher reads, and every callback has to land on it. The image step
    // carries 10 of the start plan's 18 units, so a quarter of the bytes is 13.9% of the whole operation
    // and three quarters is 41.7% — figures no other step could have produced.
    expect(live).toEqual([13.9, null, 41.7]);
    // A total of zero is a transfer of unknown length, not a transfer of nothing, and the frame after it
    // proves the bar comes back to a real figure instead of staying indeterminate for the rest of the step.
    const imageFrames = operationEvents(published).map((event) => event.data.operation).filter((view: any) => view.stepLabel === 'image');
    expect(imageFrames.some((view: any) => view.percent === null)).toBe(true);
    expect(imageFrames.some((view: any) => typeof view.percent === 'number' && view.percent > 0)).toBe(true);
    // Nothing is built on the host any more: the long step is the fetch, and only the fetch.
    expect(nspawn.ensureProjectImage).not.toHaveBeenCalled();
    expect((await runtime.environmentOperation({ operationId: op.id, accountUserId: 1 }))?.status).toBe('succeeded');
  });

  // The idempotency key is what makes a retry after a lost response safe. It must survive the progress
  // columns being written on the same row.
  it('returns the same operation for a repeated request key instead of queueing a second one', async () => {
    const { runtime, db } = setup();
    const first = await runtime.requestEnvironment({ ...input, requestId: 'once', action: { kind: 'start' } });
    const second = await runtime.requestEnvironment({ ...input, requestId: 'once', action: { kind: 'start' } });
    expect(second.id).toBe(first.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_runtime_operations WHERE kind='project'").get()).toEqual({ n: 1 });
    await runtime.reconcile();
    const settled = await runtime.requestEnvironment({ ...input, requestId: 'once', action: { kind: 'start' } });
    expect(settled.id).toBe(first.id);
    expect(settled.status).toBe('succeeded');
  });

  it('publishes the terminal frame so a watcher never has to poll for the outcome', async () => {
    const { runtime, published } = setup();
    const op = await runtime.requestEnvironment({ ...input, requestId: 'watch', action: { kind: 'start' } });
    await runtime.reconcile();
    const frames = operationEvents(published);
    expect(frames.every((event) => event.plugin === 'sandbox' && event.projectId === 7)).toBe(true);
    const last = frames.at(-1)!.data;
    expect(last.operation.id).toBe(op.id);
    expect(last.operation.status).toBe('succeeded');
    expect(Array.isArray(last.logTail)).toBe(true);
  });

  // A row built against `/workspace` predates the named project mount, and therefore predates the only
  // runtime this release has: its envelope was hashed from a specification no longer produced and its
  // root filesystem was never materialized from a published artifact. Every action on it is refused by
  // name, at the request, so nothing is enqueued that could not be carried out — including the deletion,
  // which is what the remedy in the message asks the operator to do to the environment instead.
  it.each(['start', 'recreate', 'delete'] as const)('refuses %s on a row that predates the named project mount', async (kind) => {
    const { runtime, db, nspawn, containers } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'first', action: { kind: 'start' } });
    await runtime.reconcile();

    const row = db.prepare("SELECT * FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get() as any;
    const spec = JSON.parse(row.spec_json);
    delete spec.input.workspaceTarget;
    db.prepare("UPDATE p_sandbox_runtimes SET spec_json=?, state='stopped' WHERE kind='project' AND resource_id='7'").run(JSON.stringify(spec));
    for (const container of containers.values()) container.workdir = '/workspace';

    nspawn.create.mockClear();
    nspawn.remove.mockClear();
    nspawn.removeByName.mockClear();
    await expect(runtime.requestEnvironment({ ...input, requestId: `stale-${kind}`, action: { kind } }))
      .rejects.toMatchObject({ code: 'unsupported_runtime', status: 409 });
    await expect(runtime.requestEnvironment({ ...input, requestId: `stale-again-${kind}`, action: { kind } }))
      .rejects.toThrow(/removed Podman runtime.*Delete the managed Project or Site/s);
    // Refused before anything durable is enqueued, and nothing on the host was touched on the way.
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_runtime_operations WHERE request_key LIKE 'stale-%'").get()).toEqual({ n: 0 });
    expect(nspawn.create).not.toHaveBeenCalled();
    expect(nspawn.remove).not.toHaveBeenCalled();
    expect(nspawn.removeByName).not.toHaveBeenCalled();
  });

  // The operation rows only ever grew: one start, stop, restart or limits change left a row behind for
  // the life of the environment, and nothing removed it when the project it described was deleted.
  it('bounds the operation history it keeps and clears it with the project', async () => {
    const { runtime, db } = setup();
    // Real lifecycle cycles rather than rows written behind the store's back: what has to stay bounded is
    // the growth the runtime itself produces.
    for (let n = 0; n < 11; n += 1) {
      await runtime.requestEnvironment({ ...input, requestId: `up-${n}`, action: { kind: 'start' } });
      await runtime.reconcile();
      await runtime.requestEnvironment({ ...input, requestId: `down-${n}`, action: { kind: 'stop' } });
      await runtime.reconcile();
    }
    const newest = await runtime.requestEnvironment({ ...input, requestId: 'latest', action: { kind: 'start' } });
    await runtime.reconcile();

    const stored = db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_runtime_operations WHERE kind='project'").get() as { n: number };
    expect(stored.n).toBe(20);
    const overview = await runtime.projectOverview({ ...input });
    expect(overview.operations).toHaveLength(20);
    expect(overview.operations[0]!.id).toBe(newest.id);

    const removal = await runtime.requestEnvironment({ ...input, requestId: 'remove', action: { kind: 'delete' } });
    await runtime.reconcile();
    expect((await runtime.environmentOperation({ operationId: removal.id, accountUserId: 1 }))?.status).toBe('succeeded');
    // Only the deletion itself survives, because the surface that reports the outcome still reads it.
    expect(db.prepare("SELECT id FROM p_sandbox_runtime_operations WHERE kind='project'").all()).toEqual([{ id: removal.id }]);
    // The runtime row goes with the project core has just removed: keeping it would leave one dead row
    // per deleted project, and nothing can reach the environment it described any more.
    expect(db.prepare("SELECT kind FROM p_sandbox_runtimes WHERE kind='project'").all()).toEqual([]);
  });

  // A restore's checkpoint carries the specification it replaced and the generation it reserved. The
  // delete path collects those specifications to remove every container and volume a past restore left
  // behind, and handing a reserved generation out twice would build over that leftover data.
  it('keeps a settled row that still carries a recipe the delete needs', async () => {
    const { runtime, db } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'seed', action: { kind: 'start' } });
    await runtime.reconcile();
    db.prepare("INSERT INTO p_sandbox_runtime_operations(id,kind,resource_id,user_id,request_key,generation,action_json,checkpoint_json,status) VALUES(?,'project','7',1,'restore-1',1,'{\"kind\":\"restore\"}',?,'succeeded')")
      .run('env_recipe-1', JSON.stringify({ oldSpec: { input: { generation: 1 } }, newSpec: { input: { generation: 2 } } }));
    for (let n = 0; n < 25; n += 1) {
      await runtime.requestEnvironment({ ...input, requestId: `cycle-${n}`, action: { kind: n % 2 === 0 ? 'stop' : 'start' } });
      await runtime.reconcile();
    }

    const kept = db.prepare("SELECT id FROM p_sandbox_runtime_operations WHERE kind='project' ORDER BY rowid DESC").all() as { id: string }[];
    // The newest twenty, plus the recipe row whichever end of the history it sits at.
    expect(kept).toHaveLength(21);
    expect(kept.map((row) => row.id)).toContain('env_recipe-1');
  });

  // A failure carries whatever the host put in it, and the storage root is in most of them. The
  // execution path has always replaced it in command output; a lifecycle error is read by the same
  // people on the same screen.
  it('keeps the host storage root out of the failure it shows and the lines it logs', async () => {
    const { runtime, storage, root } = setup();
    storage.prepare.mockRejectedValueOnce(new Error(`root filesystem extraction failed under ${root}/projects/7/disks`));
    const op = await runtime.requestEnvironment({ ...input, requestId: 'leaky', action: { kind: 'start' } });
    await runtime.reconcile();

    const failed = await runtime.environmentOperation({ operationId: op.id, accountUserId: 1 });
    expect(failed?.status).toBe('failed');
    expect(failed?.error).not.toContain(root);
    expect(failed?.error).toContain('[environment-storage]');
    expect((await runtime.environmentLogs({ ...input })).lifecycle).not.toContain(root);
  });

  // Claiming an operation that a dead daemon left behind must not wipe the position it had reached:
  // the frame that says "resumed" is the first thing a watcher sees, and it was saying "0%".
  it('claims a resumed operation at the position it reached rather than at zero', async () => {
    const { runtime, db, published } = setup();
    const op = await runtime.requestEnvironment({ ...input, requestId: 'resumed', action: { kind: 'start' } });
    db.prepare("UPDATE p_sandbox_runtime_operations SET status='running',owner_pid=?,owner_identity='dead',step_index=2,percent=76 WHERE id=?")
      .run(2 ** 22, op.id);
    published.length = 0;

    await runtime.reconcile();
    const claimed = operationEvents(published)[0]!.data.operation;
    expect([claimed.stepIndex, claimed.percent]).toEqual([2, 76]);
    expect((await runtime.environmentOperation({ operationId: op.id, accountUserId: 1 }))?.status).toBe('succeeded');
  });

  // Waiting for the guest system bus and quiescing guest leases are a PROJECT's steps; the Site branches
  // never run either, so declaring them told a Site's watcher about work that never happens.
  it('declares only the steps a Site actually takes', async () => {
    const { runtime, root } = setup();
    const registration = { siteId: 'shop', projectId: 7, image: 'localhost/elowen/site:fixed', network: 'shared',
      workspaceReadOnly: false, persistentRootfs: true, sitesDataDir: join(root, 'sites'), sourcePath: join(root, 'sources'), brokerDir: join(root, 'brokers'),
      limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 } };
    runtime.connectSitesRuntime({ resolve: async () => registration, beforeStart: async () => {}, afterStop: async () => {} });
    await runtime.registerSiteEnvironment({ siteId: 'shop', accountUserId: 1 });

    const started = await runtime.requestSiteEnvironment({ siteId: 'shop', accountUserId: 1, requestId: 'site-start', action: { kind: 'start' } });
    expect(started.steps).toEqual(['image', 'storage', 'container', 'boot', 'initialize']);
    await runtime.reconcile();
    const siteStart = await runtime.siteEnvironmentOperation({ operationId: started.id, accountUserId: 1 });
    expect(siteStart?.status, siteStart?.error ?? '').toBe('succeeded');

    const stopped = await runtime.requestSiteEnvironment({ siteId: 'shop', accountUserId: 1, requestId: 'site-stop', action: { kind: 'stop' } });
    expect(stopped.steps).toEqual(['stop']);
    await runtime.reconcile();
    const done = await runtime.siteEnvironmentOperation({ operationId: stopped.id, accountUserId: 1 });
    expect([done?.status, done?.percent, done?.stepLabel]).toEqual(['succeeded', 100, 'stop']);
  });

  it('refuses recreate for a Site, which has no such repair', async () => {
    const { runtime } = setup();
    await expect(runtime.requestSiteEnvironment({ siteId: 'shop', accountUserId: 1, action: { kind: 'recreate' } }))
      .rejects.toThrow(/Invalid environment action/);
  });
});
