import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { NspawnClient } from '../../plugins/sandbox/lib/nspawn.mjs';
import { SpawnExecutor } from '../../plugins/sandbox/lib/runtimeProcess.mjs';
import { RootfsArtifactStore } from '../../plugins/sandbox/lib/rootfsArtifacts.mjs';
import { createContainerSpec, createEnvironmentDiskSpec, executionUnit, withContainerLimits } from '../../plugins/sandbox/lib/containerSpec.mjs';
import { managedGuestRoot } from '../../plugins/sandbox/lib/containerPaths.mjs';
import { ContainerStorage } from '../../plugins/sandbox/lib/containerStorage.mjs';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import { createEnvironmentRuntime } from '../../plugins/sandbox/lib/environmentRuntime.mjs';
import { runPrepared } from '../../plugins/sandbox/lib/execution.mjs';
import { announce, blockers, pinnedExecutor, PROJECT_ROOTFS, PROOF_HELPER, storageRoots } from './nspawnRealGuest.mjs';

/** The managed runtime against a REAL systemd-nspawn machine, end to end.
 *
 *  This is the successor of the private container-store suite, and the isolation model is the one thing that
 *  could not survive the move: a machine is registered with the host's own machine manager and its disk
 *  lives under the trusted storage root the privileged helper derives, so there is no per-run engine to
 *  create and reset. What replaces it is the proof-host gate — the suite refuses to run on a host whose
 *  teardown is not already armed — a resource id far outside the range a real project reaches, and a
 *  teardown that removes exactly what this run created.
 *
 *  Everything the container store used to prove is still proved, by a different means: the executor is
 *  pinned, so a program this runtime does not own or a helper invocation off its pinned argv fails the
 *  test on the spot, and no daemon credential may appear in the environment any child is given. */

announce('nspawn managed runtime');

/** Far outside the range a real project reaches, so a run interrupted halfway leaves resources a person
 *  can find and remove without guessing which project they belong to. */
const SUFFIX = randomBytes(4).toString('hex');
const RAW_PROJECT_ID = 991_000_000 + Number(BigInt(`0x${SUFFIX}`) % 1_000_000n);
const RUNTIME_PROJECT_ID = 992_000_000 + Number(BigInt(`0x${SUFFIX}`) % 1_000_000n);
const SITE_ID = `crproof-${SUFFIX}`;

it.skipIf(blockers.length > 0)('runs the managed runtime against a real systemd-nspawn machine', async () => {
  const sandboxDataDir = storageRoots!.sandboxDataDir;
  const sitesDataDir = storageRoots!.sitesDataDir;
  const paths = { sandboxDataDir, namespace: 'elowen' };
  const scratch = mkdtempSync(join(sandboxDataDir, `crproof-${SUFFIX}-`));
  const observed: string[] = [];
  const client = new NspawnClient({ artifacts: new RootfsArtifactStore({ dataDir: sandboxDataDir }),
    executor: pinnedExecutor(new SpawnExecutor(), observed), helperPath: PROOF_HELPER, namespace: 'elowen',
    outputLimitBytes: 16 * 1024 * 1024 });
  const storage = new ContainerStorage(client);
  const execute = (spec: any, script: string) =>
    client.exec(spec, randomBytes(16).toString('hex'), ['/bin/bash', '-s'], { input: script, timeoutMs: 120_000, persistent: true });

  const rawDisk = createEnvironmentDiskSpec({ resource: { kind: 'project', id: RAW_PROJECT_ID }, image: PROJECT_ROOTFS, runtime: 'nspawn' },
    paths, randomBytes(16).toString('hex'));
  const rawSpec: any = createContainerSpec({ resource: { kind: 'project', id: RAW_PROJECT_ID }, workspaceTarget: '/demo',
    generation: 1, image: PROJECT_ROOTFS, disk: rawDisk }, paths);
  let runtimeStorageRoot: string | null = null;
  let stage = 'host readiness';
  try {
    // The deployed runtime, asked the way the settings page asks it. This replaces the private-store
    // check: it is the statement that what follows runs against a real, provisioned machine host.
    const readiness = await client.hostReadiness();
    assert.equal(readiness.ready, true, JSON.stringify(readiness.items.filter((item: any) => !item.ok)));

    stage = 'persistent disk materialized from the published root filesystem';
    await storage.prepare(rawSpec);
    // Nothing on this host built it: the bytes came from the published artifact the disk record names,
    // verified by digest, and the disk's own durable manifest says so.
    assert.equal(existsSync(join(dirname(rawSpec.disk.rootfsPath), 'disk.json')), true);

    stage = 'envelope creation';
    await client.create(rawSpec);
    stage = 'start and inspect';
    await client.start(rawSpec);
    await client.waitForSystemBus(rawSpec, { timeoutMs: 300_000 });
    assert.equal((await client.inspect(rawSpec))?.state, 'running');

    stage = 'guest exec';
    const result = await execute(rawSpec, 'set -eu; git --version; printf rootfs > /rootfs-proof; printf home > /root/home-proof; printf workspace > /demo/workspace-proof; printf data > /data/data-proof');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /git version/);

    stage = 'guest Node npm and Chromium prerequisites';
    const tools = await execute(rawSpec, 'set -eu; node --version; npm --version; chromium --version; chromium --headless --no-sandbox --disable-dev-shm-usage --dump-dom "data:text/html,<h1>guest-browser</h1>"');
    assert.equal(tools.code, 0, tools.stderr);
    assert.match(tools.stdout, /v24\./);
    assert.match(tools.stdout, /Chromium/);
    assert.match(tools.stdout, /<h1>guest-browser<\/h1>/);

    const limits = await execute(rawSpec, 'cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max');
    assert.equal(limits.code, 0, limits.stderr);
    assert.equal(limits.stdout.trim(), '100000 100000\n1073741824\n512');

    stage = 'stop/start persistence';
    await client.stop(rawSpec);
    await client.start(rawSpec);
    await client.waitForSystemBus(rawSpec, { timeoutMs: 300_000 });
    const persisted = await execute(rawSpec, 'set -eu; test "$(cat /rootfs-proof)" = rootfs; test "$(cat /root/home-proof)" = home; test "$(cat /demo/workspace-proof)" = workspace; test "$(cat /data/data-proof)" = data');
    assert.equal(persisted.code, 0, persisted.stderr);

    stage = 'guest cancellation';
    const executionId = randomBytes(16).toString('hex');
    const running = client.exec(rawSpec, executionId, ['/bin/bash', '-s'], {
      input: 'sleep 120 & echo $! > /data/cancel-child; wait', timeoutMs: 300_000, persistent: true,
    }).then(() => null, (error: unknown) => error);
    let active = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const shown = await client.exec(rawSpec, randomBytes(16).toString('hex'),
        ['/usr/bin/systemctl', 'show', '--property=ActiveState', '--value', executionUnit(rawSpec, executionId)],
        { timeoutMs: 15_000, allowFailure: true, persistent: true });
      if (shown.code === 0 && shown.stdout.trim() === 'active') {
        const childReady = await client.exec(rawSpec, randomBytes(16).toString('hex'), ['/usr/bin/test', '-s', '/data/cancel-child'],
          { timeoutMs: 15_000, allowFailure: true, persistent: true });
        if (childReady.code === 0) { active = true; break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(active, true, 'Cancellation must target an actually started guest unit');
    assert.equal((await client.cancelExecution(rawSpec, executionId, { persistent: true })).terminated, true);
    // A launcher whose unit was stopped under it still exits zero, so the client reports the cancellation
    // itself rather than letting a killed command read as a success with no output.
    const cancelled = await running;
    assert.ok(cancelled instanceof Error, 'a cancelled execution must not settle as a success');
    assert.match((cancelled as Error).message, /cancelled/i);
    const gone = await execute(rawSpec, 'set -eu; pid=$(cat /data/cancel-child); ! kill -0 "$pid" 2>/dev/null');
    assert.equal(gone.code, 0, 'The guest descendant must be gone');

    // The first machine has served its purpose; its uid range stays spent either way, but the envelope
    // and the disk go now so the coordinator below runs on a host this suite has already tidied once.
    await client.stop(rawSpec);
    await client.remove(rawSpec);
    await client.removeDiskPath(rawSpec.storageRoot);

    stage = 'durable coordinator and guest file transport';
    const sql = openDb(':memory:');
    const db = makePluginDb(sql, 'sandbox', { canMigrate: true });
    const adoptedPath = join(scratch, 'adopted');
    mkdirSync(adoptedPath, { recursive: true });
    writeFileSync(join(adoptedPath, 'marker.txt'), 'adopted workspace');
    const project: any = { id: RUNTIME_PROJECT_ID, slug: 'runtime-demo', executionKind: 'managed', lifecycle: 'active', adoptedPath };
    // Where this project is really mounted. Writing the proofs to `/workspace` instead would leave them
    // on the machine's own root filesystem, so the snapshot and restore below would prove nothing.
    const projectRoot = managedGuestRoot(project.slug, project.id);
    const ctx: any = { db: () => db, currentAccountUserId: () => null, currentAccess: () => ({ readOnly: false }), config: {},
      logger: { info() {}, warn() {}, error() {} },
      host: { stores: () => ({
        usersRead: { list: () => [{ id: 1 }], mayUsePlugin: () => true, isAdmin: () => true },
        // Only this project exists for this actor: a denial case has to be able to actually be denied.
        userProjects: { canAccess: (_userId: number, id: number) => id === project.id && project.lifecycle === 'active', canManage: (_userId: number, id: number) => id === project.id },
        projects: { get: (id: number) => (id === project.id ? project : undefined), beginDeletion: () => { project.lifecycle = 'deleting'; return true; }, finishDeletion: () => true },
      }) } };
    initSandboxDb(ctx);
    const runtime = createEnvironmentRuntime({ ctx, db, dataDir: sandboxDataDir, namespace: 'elowen', nspawn: client, storage, daemon: true });
    const actor = { project: { kind: 'managed', projectId: RUNTIME_PROJECT_ID }, accountUserId: 1 };
    const perform = async (action: any) => {
      const op = await runtime.requestEnvironment({ ...actor, action }); await runtime.reconcile();
      const completed = await runtime.environmentOperation({ accountUserId: 1, operationId: op.id });
      assert.equal(completed?.status, 'succeeded', completed?.error ?? 'Lifecycle operation did not complete');
      return completed;
    };
    try {
      await perform({ kind: 'start' });
      const stored = JSON.parse((sql.prepare("SELECT spec_json FROM p_sandbox_runtimes WHERE kind='project'").get() as any).spec_json);
      // The runtime a NEW environment is built on is decided once, against the host readiness answer, and
      // recorded on the disk itself. There is nothing else it could have chosen.
      assert.equal(stored.input.disk.runtime, 'nspawn');
      runtimeStorageRoot = dirname(dirname(stored.input.disk.rootfsPath));
      const runtimeSpec = createContainerSpec({ ...stored.input }, stored.paths) as any;
      assert.throws(() => lstatSync(adoptedPath));
      const adopted = await execute(runtimeSpec, `cat ${projectRoot}/marker.txt`);
      assert.equal(adopted.stdout.trim(), 'adopted workspace');

      stage = 'adopted project live limits';
      const requestedLimits = { cpus: 2, memoryMb: 6144, pidsLimit: 4096 };
      await perform({ kind: 'limits', limits: requestedLimits });
      const raised = await execute(withContainerLimits(runtimeSpec, requestedLimits), 'cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max');
      assert.equal(raised.stdout.trim(), '200000 100000\n6442450944\n4096');

      const files = (operation: any) => runtime.projectFiles({ ...actor, operation });
      const created = await files({ kind: 'write', path: `${projectRoot}/runtime-proof`, base64: Buffer.from('snapshot value').toString('base64'), expectedVersion: null });
      assert.equal(created.kind, 'write');
      await assert.rejects(files({ kind: 'write', path: `${projectRoot}/runtime-proof`, base64: '', expectedVersion: 'stale' }), /version/i);
      const read = await files({ kind: 'read', path: `${projectRoot}/runtime-proof`, maxBytes: 1024 });
      assert.equal(Buffer.from(read.base64, 'base64').toString(), 'snapshot value');
      const prepared = await runtime.prepareExecution({ command: { type: 'shell', command: 'printf root > /rootfs-managed; printf home > /root/managed; printf data > /data/managed' }, projectRef: actor.project, cwd: projectRoot, leaseKind: 'terminal' }, 1);
      assert.equal((await runPrepared(prepared)).code, 0);

      stage = 'guest file tool operations';
      // What the file tools sit on: a directory listing, a content search, a stat, a rename and a
      // removal, each answered by the guest rather than by a host view of the disk.
      await files({ kind: 'mkdir', path: `${projectRoot}/tools` });
      await files({ kind: 'write', path: `${projectRoot}/tools/needle.txt`, base64: Buffer.from('alpha NEEDLE omega\n').toString('base64'), expectedVersion: null });
      const listed = await files({ kind: 'list', path: `${projectRoot}/tools`, limit: 50 });
      assert.equal(listed.kind, 'list');
      assert.ok(listed.entries.some((entry: any) => entry.path.endsWith('needle.txt')), 'the listing must show the file just written');
      const found = await files({ kind: 'search', path: projectRoot, pattern: 'NEEDLE', limit: 20 });
      assert.equal(found.kind, 'search');
      assert.ok(found.matches.length >= 1, 'the guest search must find the written content');
      const statted = await files({ kind: 'stat', path: `${projectRoot}/tools/needle.txt` });
      assert.equal(statted.kind, 'stat');
      assert.equal(statted.entry.size, 19);
      await files({ kind: 'rename', path: `${projectRoot}/tools/needle.txt`, destination: `${projectRoot}/tools/renamed.txt`, expectedVersion: statted.entry.version });
      // A stat answers "gone" with a null entry rather than an error, so absence is asserted that way.
      assert.equal((await files({ kind: 'stat', path: `${projectRoot}/tools/needle.txt` })).entry, null);
      const renamed = await files({ kind: 'stat', path: `${projectRoot}/tools/renamed.txt` });
      await files({ kind: 'remove', path: `${projectRoot}/tools/renamed.txt`, expectedVersion: renamed.entry.version });
      assert.equal((await files({ kind: 'stat', path: `${projectRoot}/tools/renamed.txt` })).entry, null);

      stage = 'guest access denial';
      // Another project's identity must not reach this environment, and a stale generation must not
      // either — both are refusals the environment owes its caller, not conveniences.
      await assert.rejects(
        runtime.projectFiles({ project: { kind: 'managed', projectId: RUNTIME_PROJECT_ID + 1 }, accountUserId: 1, operation: { kind: 'read', path: `${projectRoot}/runtime-proof`, maxBytes: 64 } }),
        /forbidden|denied|not found|unavailable/i,
      );
      await assert.rejects(
        runtime.projectFiles({ ...actor, expectedGeneration: 99, operation: { kind: 'read', path: `${projectRoot}/runtime-proof`, maxBytes: 64 } }),
        /generation/i,
      );
      // The machine is the boundary, so a guest path is not refused for being outside the project mount.
      // What must be refused is a path the protocol cannot express safely.
      await assert.rejects(files({ kind: 'read', path: 'relative/path', maxBytes: 64 }), /path|invalid|absolute/i);

      stage = 'managed worktrees and gateway preview';
      const worktrees = await runtime.managedWorktrees({ ...actor, action: { kind: 'create', label: 'retained', baseRef: 'main' } });
      assert.equal(worktrees.length, 1);
      const server = await runtime.prepareExecution({ command: { type: 'shell', command: `systemd-run --unit=preview-target --service-type=exec /usr/bin/python3 -m http.server 8081 --bind 127.0.0.1 --directory ${projectRoot}` }, projectRef: actor.project, cwd: projectRoot, leaseKind: 'terminal' }, 1);
      await runPrepared(server);
      const preview = await runtime.projectPreviewBinding({ ...actor, port: 8081 });
      try {
        const status = await new Promise<number>((resolve, reject) => {
          const request = httpRequest({ socketPath: preview.socketPath, path: '/', timeout: 5000 }, (response) => { response.resume(); response.once('end', () => resolve(response.statusCode ?? 0)); });
          request.once('error', reject); request.once('timeout', () => request.destroy(new Error('Preview timed out'))); request.end();
        });
        assert.equal(status, 200);
      } finally { await preview.release(); }
      assert.throws(() => lstatSync(preview.socketPath));

      stage = 'durable publication transport';
      // Published, not previewed: no lease, no release handle, and the record outlives the request. The
      // guest unit is the SAME forwarder a preview runs, established for the publication's name.
      const publication = await runtime.projectPublicationBinding({ ...actor, publicationId: 'storefront', port: 8081 });
      const published = async () => await new Promise<number>((resolve, reject) => {
        const request = httpRequest({ socketPath: publication.socketPath, path: '/', timeout: 5000 }, (response) => { response.resume(); response.once('end', () => resolve(response.statusCode ?? 0)); });
        request.once('error', reject); request.once('timeout', () => request.destroy(new Error('Publication timed out'))); request.end();
      });
      try {
        assert.equal(lstatSync(publication.socketPath).isSocket(), true);
        assert.equal(await published(), 200);

        // A machine restart takes the forwarder with it while its socket FILE stays behind on the host
        // side of the bind mount, which is why presence is never read as liveness. The application inside
        // dies with the machine too: what survives is the publication RECORD, and the transport answers
        // again the moment the application does.
        await perform({ kind: 'stop' });
        await perform({ kind: 'start' });
        const restarted = await runtime.prepareExecution({ command: { type: 'shell', command: `systemd-run --unit=preview-target-restart --service-type=exec /usr/bin/python3 -m http.server 8081 --bind 127.0.0.1 --directory ${projectRoot}` }, projectRef: actor.project, cwd: projectRoot, leaseKind: 'terminal' }, 1);
        await runPrepared(restarted);
        assert.equal(lstatSync(publication.socketPath).isSocket(), true);
        assert.equal(await published(), 200);

        // And the reconcile that owns the machine lifecycle leaves a healthy publication alone.
        await runtime.reconcile();
        assert.equal(await published(), 200);
      } finally { await runtime.projectPublicationRelease({ ...actor, publicationId: 'storefront' }); }
      assert.throws(() => lstatSync(publication.socketPath));
      assert.equal((sql.prepare("SELECT COUNT(*) AS count FROM p_sandbox_runtimes WHERE kind='publication'").get() as any).count, 0);

      stage = 'full project snapshot and fresh-generation restore';
      const saved = await perform({ kind: 'snapshot' });
      await runtime.managedWorktrees({ ...actor, action: { kind: 'create', label: 'after-snapshot', baseRef: 'main' } });
      await files({ kind: 'write', path: `${projectRoot}/runtime-proof`, base64: Buffer.from('changed').toString('base64'), expectedVersion: read.version });
      await perform({ kind: 'restore', snapshotId: saved!.snapshotId });
      assert.equal((await runtime.environmentFor(actor)).generation, 2);
      const restored = await files({ kind: 'read', path: `${projectRoot}/runtime-proof`, maxBytes: 1024 });
      assert.equal(Buffer.from(restored.base64, 'base64').toString(), 'snapshot value');
      await perform({ kind: 'stop' }); await perform({ kind: 'start' });
      const verify = await runtime.prepareExecution({ command: { type: 'shell', command: 'set -eu; test "$(cat /rootfs-managed)" = root; test "$(cat /root/managed)" = home; test "$(cat /data/managed)" = data' }, projectRef: actor.project, cwd: projectRoot, leaseKind: 'terminal' }, 1);
      assert.equal((await runPrepared(verify)).code, 0);
      const retained = await runtime.managedWorktrees({ ...actor, action: { kind: 'list' } });
      assert.equal(retained.length, 1, 'Organizational worktree metadata must follow the restored snapshot');
      await runtime.managedWorktrees({ ...actor, action: { kind: 'remove', workspaceId: retained[0].id } });

      stage = 'managed source publication';
      const seed = await runtime.prepareExecution({ command: { type: 'shell', command: `mkdir ${projectRoot}/publication; printf executable > ${projectRoot}/publication/program.sh; chmod 755 ${projectRoot}/publication/program.sh; ln -s program.sh ${projectRoot}/publication/relative-link` }, projectRef: actor.project, cwd: projectRoot, leaseKind: 'terminal' }, 1);
      await runPrepared(seed);
      const destination = join(sitesDataDir, SITE_ID, 'source');
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      const registration = { siteId: SITE_ID, projectId: RUNTIME_PROJECT_ID, image: PROJECT_ROOTFS, sourcePath: destination,
        sitesDataDir, brokerDir: join(sitesDataDir, SITE_ID, 'broker'), workspaceReadOnly: true, network: 'isolated',
        persistentRootfs: true, limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 }, staging: true };
      mkdirSync(registration.brokerDir, { recursive: true, mode: 0o700 });
      runtime.connectSitesRuntime({ resolve: async () => registration, beforeStart: async () => {}, afterStop: async () => {}, projectDependents: async () => [],
        resolveArtifact: async () => ({ kind: 'project-source', project: actor.project, guestPath: `${projectRoot}/publication`, destinationPath: destination }) });
      await runtime.registerSiteEnvironment({ siteId: registration.siteId, accountUserId: 1 });
      const siteAction = async (action: any) => {
        const op = await runtime.requestSiteEnvironment({ siteId: registration.siteId, accountUserId: 1, action }); await runtime.reconcile();
        const completed = await runtime.siteEnvironmentOperation({ operationId: op.id, accountUserId: 1 });
        assert.equal(completed?.status, 'succeeded', completed?.error ?? 'Site operation did not complete');
      };
      await siteAction({ kind: 'export-project', artifactId: 'source' });
      assert.equal(lstatSync(join(destination, 'program.sh')).mode & 0o777, 0o755);
      assert.equal(readlinkSync(join(destination, 'relative-link')), 'program.sh');
      await siteAction({ kind: 'cleanup-stage' });

      stage = 'verified project cleanup';
      await perform({ kind: 'delete' });
      runtimeStorageRoot = null;
    } finally { await runtime.dispose(); sql.close(); }
    console.log('Real machine control observations:', JSON.stringify([...new Set(observed)]));
  } catch (error) {
    console.error(`Real machine stage failed: ${stage}`);
    throw error;
  } finally {
    // Exactly what this run created, and nothing beside it. Each step is independently guarded: a failure
    // part way through must still take the rest away rather than leave a machine registered on the host.
    for (const spec of [rawSpec]) {
      try { if (await client.containerExists(spec)) { await client.stop(spec).catch(() => {}); await client.removeByName(spec); } } catch { /* gone */ }
    }
    for (const path of [rawSpec.storageRoot, runtimeStorageRoot, join(sitesDataDir, SITE_ID), scratch]) {
      if (!path) continue;
      try { if (existsSync(path)) await client.removeDiskPath(path); } catch { /* gone */ }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}, 3_600_000);
