import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import { buildFraction, createEnvironmentRuntime } from '../../plugins/sandbox/lib/environmentRuntime.mjs';
import type { PodmanClient } from '../../plugins/sandbox/lib/podman.mjs';
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
  let buildLines: string[] = [];
  let busReady = false;
  let busFails = false;
  const podman = {
    ensureProjectImage: vi.fn(async (_dir: string, onOutput?: (line: string) => void) => {
      for (const line of buildLines) onOutput?.(line);
      return 'localhost/elowen-project-base:test';
    }),
    inspect: vi.fn(async (spec: any) => containers.get(spec.name) ?? null),
    create: vi.fn(async (spec: any) => { const row = { id: 'a'.repeat(64), state: 'created' }; containers.set(spec.name, row); return row; }),
    start: vi.fn(async (spec: any) => { containers.get(spec.name).state = 'running'; }),
    stop: vi.fn(async (spec: any) => { containers.get(spec.name).state = 'stopped'; }),
    remove: vi.fn(async (spec: any) => { containers.delete(spec.name); }),
    // The real guest: every execution goes through `systemd-run`, so until the system bus is listening a
    // command does not run at all. This is the shape the container on the live host produced — the bus
    // socket absent while PID 1 was already up, and dbus refused with exactly this message.
    exec: vi.fn(async () => busReady
      ? { code: 0, stdout: '', stderr: '', truncated: false }
      : { code: 1, stdout: '', stderr: 'Failed to connect to bus: No such file or directory', truncated: false }),
    waitForSystemBus: vi.fn(async () => { if (busFails) throw new Error('Guest system bus did not become available within 120s (systemd reports initializing)'); busReady = true; }),
    cancelExecution: vi.fn(async () => ({ terminated: true })), releaseExecution: vi.fn(),
    removeVolume: vi.fn(), removeStorage: vi.fn(), inspectVolume: vi.fn(),
    containerExists: vi.fn(async (spec: any) => containers.has(spec.name)),
  };
  const storage = { prepare: vi.fn(), snapshot: vi.fn(), readSnapshot: vi.fn(), restoreVolumes: vi.fn() };
  const runtime = createEnvironmentRuntime({ ctx, db, dataDir: root, podman: podman as unknown as PodmanClient,
    storage: storage as unknown as ContainerStorage, daemon: true });
  cleanup.push(() => { runtime.dispose(); sql.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, db, ctx, podman, containers, published, project,
    setBuildOutput: (lines: string[]) => { buildLines = lines; },
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

  // A container Podman calls "running" is not yet a guest that can run anything: `systemd-run`, which
  // carries every execution including project initialization, needs the guest system bus, and that is
  // activated some way into the boot. Waiting for it is the fix for a start that reported
  // `Failed to connect to bus: No such file or directory` at 94%.
  it('waits for the guest system bus before it initializes the project', async () => {
    const { runtime, podman } = setup();
    const op = await runtime.requestEnvironment({ ...input, requestId: 'bus', action: { kind: 'start' } });
    await runtime.reconcile();

    const done = await runtime.environmentOperation({ operationId: op.id, accountUserId: 1 });
    expect([done?.status, done?.error]).toEqual(['succeeded', null]);
    expect(podman.waitForSystemBus).toHaveBeenCalledTimes(1);
    // Order, not merely presence: initialization must not be the thing that discovers the bus is missing.
    expect(podman.waitForSystemBus.mock.invocationCallOrder[0]!).toBeLessThan(podman.exec.mock.invocationCallOrder[0]!);
  });

  // A guest that never finishes booting is a boot failure and has to read as one, on its own step.
  it('fails on the readiness step when the guest system never comes up', async () => {
    const { runtime, podman, failSystemBus } = setup();
    failSystemBus();
    const op = await runtime.requestEnvironment({ ...input, requestId: 'stalled', action: { kind: 'start' } });
    await runtime.reconcile();

    const failed = await runtime.environmentOperation({ operationId: op.id, accountUserId: 1 });
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('Guest system bus did not become available');
    expect(failed?.stepLabel).toBe('ready');
    expect(podman.exec).not.toHaveBeenCalled();
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
    const { runtime, podman } = setup();
    (podman as any).update = vi.fn();
    await runtime.requestEnvironment({ ...input, requestId: 'up', action: { kind: 'start' } });
    await runtime.reconcile();

    const limits = await runtime.requestEnvironment({ project: input.project, accountUserId: 3, requestId: 'limits',
      action: { kind: 'limits', limits: { cpus: 2, memoryMb: 2048, pidsLimit: 512, diskSoftMb: 10240 } } });
    expect(limits.steps).toEqual(['apply']);
    await runtime.reconcile();
    expect((await runtime.environmentOperation({ operationId: limits.id, accountUserId: 3 }))?.percent).toBe(100);

    const removal = await runtime.requestEnvironment({ ...input, requestId: 'delete', action: { kind: 'delete' } });
    expect(removal.steps).toEqual(['stop', 'containers', 'images', 'volumes', 'storage', 'records']);
    await runtime.reconcile();
    expect((await runtime.environmentOperation({ operationId: removal.id, accountUserId: 1 }))?.status).toBe('succeeded');
  });

  // A build is the one part that can take minutes. Its output has to reach the person watching, and the
  // bar must say "indeterminate" rather than invent a figure for a line that carries no fraction.
  it('streams the base image build into the log ring buffer and derives percent from its step counter', async () => {
    const { runtime, published, setBuildOutput } = setup();
    setBuildOutput(['STEP 1/4: FROM debian', 'Copying blob 12MB / 40MB', 'STEP 3/4: RUN apt-get install']);
    const op = await runtime.requestEnvironment({ ...input, requestId: 'build', action: { kind: 'start' } });
    await runtime.reconcile();

    const logs = await runtime.environmentLogs({ ...input });
    expect(logs.lifecycle).toContain('STEP 3/4: RUN apt-get install');
    const tail = (await runtime.environmentOperation({ operationId: op.id, accountUserId: 1 }))!.logTail;
    expect(tail.join('\n')).toContain('Copying blob 12MB / 40MB');

    // A line with no fraction leaves the bar indeterminate; the step counter produces a real figure.
    const imageFrames = operationEvents(published).map((event) => event.data.operation).filter((view: any) => view.stepLabel === 'image');
    expect(imageFrames.some((view: any) => view.percent === null)).toBe(true);
    expect(imageFrames.some((view: any) => typeof view.percent === 'number' && view.percent > 0)).toBe(true);
  });

  it('reads a build step counter as a fraction and everything else as indeterminate', () => {
    expect(buildFraction('STEP 3/12: RUN apt-get update')).toBeCloseTo(0.25);
    expect(buildFraction('STEP 12/12: COMMIT')).toBe(1);
    expect(buildFraction('Copying blob sha256:abc 12.3MiB / 45.6MiB')).toBeNull();
    expect(buildFraction('')).toBeNull();
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

  // The stale-container case: the failure names the repair, and the repair is an operation of its own
  // that rebuilds the container while the storage volumes — and so the project's files — stay put.
  it('fails a stale environment with the recreate wording and repairs it through the recreate action', async () => {
    const { runtime, db, podman, published } = setup();
    await runtime.requestEnvironment({ ...input, requestId: 'first', action: { kind: 'start' } });
    await runtime.reconcile();

    // Rewind the row to the pre-mount layout while its container survives, which is exactly the shape
    // that reached the owner: a container this runtime can no longer verify.
    const row = db.prepare("SELECT * FROM p_sandbox_runtimes WHERE kind='project' AND resource_id='7'").get() as any;
    const spec = JSON.parse(row.spec_json);
    delete spec.input.workspaceTarget;
    db.prepare("UPDATE p_sandbox_runtimes SET spec_json=?, state='stopped' WHERE kind='project' AND resource_id='7'").run(JSON.stringify(spec));

    const failing = await runtime.requestEnvironment({ ...input, requestId: 'stale', action: { kind: 'start' } });
    await runtime.reconcile();
    const failed = await runtime.environmentOperation({ operationId: failing.id, accountUserId: 1 });
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatch(/predates the named project mount/);
    expect(failed?.error).toMatch(/Recreate it/);
    expect(operationEvents(published).at(-1)!.data.operation.status).toBe('failed');

    podman.remove.mockClear();
    podman.removeVolume.mockClear();
    const repair = await runtime.requestEnvironment({ ...input, requestId: 'repair', action: { kind: 'recreate' } });
    await runtime.reconcile();
    expect((await runtime.environmentOperation({ operationId: repair.id, accountUserId: 1 }))?.status).toBe('succeeded');
    expect((await runtime.environmentFor(input)).state).toBe('running');
    expect(podman.remove).toHaveBeenCalledOnce();
    // The files live in the volumes, so a repair that removed one would be a data loss dressed as a fix.
    expect(podman.removeVolume).not.toHaveBeenCalled();
  });

  it('refuses recreate for a Site, which has no such repair', async () => {
    const { runtime } = setup();
    await expect(runtime.requestSiteEnvironment({ siteId: 'shop', accountUserId: 1, action: { kind: 'recreate' } }))
      .rejects.toThrow(/Invalid environment action/);
  });
});
