import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { PodmanClient, SpawnExecutor, isolatedPodmanOptions } from '../../plugins/sandbox/lib/podman.mjs';
import { createContainerSpec, executionUnit } from '../../plugins/sandbox/lib/containerSpec.mjs';
import { ContainerStorage } from '../../plugins/sandbox/lib/containerStorage.mjs';
import { PROJECT_BASE_IMAGE_TAG } from '../../plugins/sandbox/lib/containerBaseImage.mjs';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import { createEnvironmentRuntime } from '../../plugins/sandbox/lib/environmentRuntime.mjs';
import { runPrepared } from '../../plugins/sandbox/lib/execution.mjs';

// Explicit opt-in. This harness never constructs a default-store client, even for cleanup.
const storageOnly = process.env.ELOWEN_TEST_PODMAN_STAGE === 'storage';
it.runIf(process.env.ELOWEN_TEST_PODMAN === '1')(storageOnly ? 'validates only private Podman storage metadata' : 'runs the managed runtime in a fresh private Podman store', async () => {
  // Podman limits runroot to 50 bytes; long worktree paths cannot hold its runtime sockets.
  const scratch = mkdtempSync(join(tmpdir(), 'ep-'));
  const isolation = isolatedPodmanOptions(join(scratch, 'podman'), `test-${randomBytes(6).toString('hex')}`, { useUserSessionBus: true });
  const paths = isolation.isolation;
  const expectedPrefix = ['--root', paths.storage, '--runroot', paths.runroot, '--tmpdir', paths.tmp, '--storage-driver', 'vfs'];
  const native = new SpawnExecutor();
  let verifiedLaunch: any;
  let engineVerified = false;
  let stage = 'info';
  const observations: any[] = [];
  const guarded = { run: async (file: string, args: string[], options: any) => {
    assert.equal(file, '/usr/bin/podman');
    assert.deepEqual(args.slice(0, expectedPrefix.length), expectedPrefix);
    assert.equal(options.env.HOME, paths.home);
    assert.equal(options.env.XDG_RUNTIME_DIR, paths.runtime);
    assert.equal(options.env.TMPDIR, paths.tmp);
    for (const key of ['CONTAINER_HOST', 'CONTAINER_CONNECTION', 'CONTAINERS_STORAGE_CONF', 'GH_TOKEN', 'GITHUB_TOKEN']) assert.equal(options.env[key], undefined);
    assert.ok(paths.userBus);
    assert.equal(paths.userBus.path, `/run/user/${process.getuid?.()}/bus`);
    const bus = lstatSync(paths.userBus.path);
    assert.equal(bus.isSocket(), true);
    assert.equal(bus.uid, process.getuid?.());
    assert.equal(bus.ino, paths.userBus.ino);
    assert.equal(bus.dev, paths.userBus.dev);
    assert.equal(options.env.DBUS_SESSION_BUS_ADDRESS, `unix:path=${paths.userBus.path}`);
    verifiedLaunch = { ...options, input: undefined, signal: undefined };
    const command = args.slice(expectedPrefix.length);
    const result = await native.run(file, args, options);
    if (command[0] === 'inspect' || (command[0] === 'volume' && command[1] === 'inspect') || command.includes('show') || command.includes('mask') || command.includes('stop')) observations.push({ command, ...result });
    if (command[0] === 'info') observations.push({ command, code: result.code, stderr: result.stderr });
    return result;
  } };
  const client = new PodmanClient({ ...isolation, executor: guarded });
  const execute = async (spec: any, script: string) => client.exec(spec, randomBytes(16).toString('hex'), ['/bin/bash', '-s'], { input: script, timeoutMs: 30_000 });
  try {
    console.log('Verified isolated Podman launch:', JSON.stringify({ args: expectedPrefix, HOME: paths.home, XDG_RUNTIME_DIR: paths.runtime, TMPDIR: paths.tmp, userBus: paths.userBus }));
    const info = await client.info();
    assert.equal(info.graphRoot, paths.storage);
    assert.equal(info.runRoot, paths.runroot);
    engineVerified = true;
    console.log('Isolated rootless engine:', JSON.stringify(info));
    const spec = createContainerSpec({ resource: { kind: 'project', id: 1 }, generation: 1, image: PROJECT_BASE_IMAGE_TAG }, { sandboxDataDir: join(scratch, 'sandbox'), namespace: paths.namespace });
    stage = 'persistent storage metadata';
    await new ContainerStorage(client).prepare(spec);
    if (storageOnly) {
      const name = 'elowen-site-legacy-test-data';
      const created = await guarded.run('/usr/bin/podman', [...expectedPrefix, 'volume', 'create', '--label', 'io.elowen.site=legacy-test', name], verifiedLaunch);
      assert.equal(created.code, 0, created.stderr);
      const inspected = await guarded.run('/usr/bin/podman', [...expectedPrefix, 'volume', 'inspect', name], verifiedLaunch);
      assert.equal(inspected.code, 0, inspected.stderr);
      console.log('Real legacy local volume metadata:', inspected.stdout);
      console.log('Real managed local-bind volume metadata:', JSON.stringify(observations));
      return;
    }
    stage = 'trusted project image';
    assert.equal(await client.ensureProjectImage(join(scratch, 'sandbox')), PROJECT_BASE_IMAGE_TAG);
    stage = 'container creation';
    await client.create(spec);
    stage = 'start and inspect';
    await client.start(spec);
    assert.equal((await client.inspect(spec))?.state, 'running');
    stage = 'guest exec';
    const result = await execute(spec, 'set -eu; git --version; printf rootfs > /rootfs-proof; printf home > /root/home-proof; printf workspace > /workspace/workspace-proof; printf data > /data/data-proof');
    assert.ok(result);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /git version/);
    stage = 'guest Node npm and Chromium prerequisites';
    const tools = await execute(spec, 'set -eu; node --version; npm --version; chromium --version; chromium --headless --no-sandbox --disable-dev-shm-usage --dump-dom "data:text/html,<h1>guest-browser</h1>"');
    assert.equal(tools.code, 0, tools.stderr);
    assert.match(tools.stdout, /v24\./);
    assert.match(tools.stdout, /Chromium/);
    assert.match(tools.stdout, /<h1>guest-browser<\/h1>/);
    const limits = await execute(spec, 'cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max');
    assert.ok(limits);
    assert.equal(limits.code, 0, limits.stderr);
    assert.equal(limits.stdout.trim(), '100000 100000\n1073741824\n512');
    stage = 'stop/start persistence';
    await client.stop(spec);
    await client.start(spec);
    const persisted = await execute(spec, 'set -eu; test "$(cat /rootfs-proof)" = rootfs; test "$(cat /root/home-proof)" = home; test "$(cat /workspace/workspace-proof)" = workspace; test "$(cat /data/data-proof)" = data');
    assert.ok(persisted);
    assert.equal(persisted.code, 0, persisted.stderr);
    stage = 'guest cancellation';
    const executionId = randomBytes(16).toString('hex');
    const controller = new AbortController();
    const container = await client.inspectBinding(spec);
    const running = client.exec(spec, executionId, ['/bin/bash', '-s'], {
      input: 'sleep 120 & echo $! > /data/cancel-child; wait', signal: controller.signal, timeoutMs: 30_000,
    }).then(() => null, (error: unknown) => error);
    try {
      let active = false;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const shown = await guarded.run('/usr/bin/podman', [...expectedPrefix, 'exec', container.id, 'systemctl', 'show', '--property=ActiveState', '--value', executionUnit(spec, executionId)], { ...verifiedLaunch, timeoutMs: 5000 });
        if (shown.code === 0 && shown.stdout.trim() === 'active') {
          const childReady = await guarded.run('/usr/bin/podman', [...expectedPrefix, 'exec', container.id, '/usr/bin/test', '-s', '/data/cancel-child'], { ...verifiedLaunch, timeoutMs: 5000 });
          if (childReady.code === 0) { active = true; break; }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(active, true, 'Cancellation must target an actually started guest unit');
      controller.abort();
      const error = await running;
      assert.ok(error instanceof Error);
      assert.match(error.message, /aborted/);
      assert.equal((await client.cancelExecution(spec, executionId)).terminated, true);
      await client.releaseExecution(spec, executionId);
      const gone = await execute(spec, 'set -eu; pid=$(cat /data/cancel-child); ! kill -0 "$pid" 2>/dev/null');
      assert.ok(gone);
      assert.equal(gone.code, 0, 'The guest descendant must be gone');
    } finally { controller.abort(); await running; }
    stage = 'durable coordinator and guest file transport';
    const sql = openDb(':memory:');
    const db = makePluginDb(sql, 'sandbox', { canMigrate: true });
    const project: any = { id: 7, executionKind: 'managed', lifecycle: 'active' };
    const ctx: any = { db: () => db, currentAccountUserId: () => null, currentAccess: () => ({ readOnly: false }), config: {}, host: { stores: () => ({
      usersRead: { list: () => [{ id: 1 }], mayUsePlugin: () => true, isAdmin: () => true },
      // Only project 7 exists for this actor: a denial case has to be able to actually be denied.
      userProjects: { canAccess: (_userId: number, id: number) => id === project.id && project.lifecycle === 'active', canManage: (_userId: number, id: number) => id === project.id },
      projects: { get: (id: number) => (id === project.id ? project : undefined), beginDeletion: () => { project.lifecycle = 'deleting'; return true; }, finishDeletion: () => true },
    }) } };
    initSandboxDb(ctx);
    const runtime = createEnvironmentRuntime({ ctx, db, dataDir: join(scratch, 'sandbox'), namespace: paths.namespace, podman: client, daemon: true });
    const actor = { project: { kind: 'managed', projectId: 7 }, accountUserId: 1 };
    const perform = async (action: any) => {
      const op = await runtime.requestEnvironment({ ...actor, action }); await runtime.reconcile();
      const completed = await runtime.environmentOperation({ accountUserId: 1, operationId: op.id });
      assert.equal(completed?.status, 'succeeded', completed?.error ?? 'Lifecycle operation did not complete');
      return completed;
    };
    try {
      await perform({ kind: 'start' });
      const files = (operation: any) => runtime.projectFiles({ ...actor, operation });
      const created = await files({ kind: 'write', path: '/workspace/runtime-proof', base64: Buffer.from('snapshot value').toString('base64'), expectedVersion: null });
      assert.equal(created.kind, 'write');
      await assert.rejects(files({ kind: 'write', path: '/workspace/runtime-proof', base64: '', expectedVersion: 'stale' }), /version/i);
      const read = await files({ kind: 'read', path: '/workspace/runtime-proof', maxBytes: 1024 });
      assert.equal(Buffer.from(read.base64, 'base64').toString(), 'snapshot value');
      const prepared = await runtime.prepareExecution({ command: { type: 'shell', command: 'printf root > /rootfs-managed; printf home > /root/managed; printf data > /data/managed' }, projectRef: actor.project, cwd: '/workspace', leaseKind: 'terminal' }, 1);
      assert.equal((await runPrepared(prepared)).code, 0);

      stage = 'guest file tool operations';
      // What the file tools sit on: a directory listing, a content search, a stat, a rename and a
      // removal, each answered by the guest rather than by a host view of the volume.
      await files({ kind: 'mkdir', path: '/workspace/tools' });
      await files({ kind: 'write', path: '/workspace/tools/needle.txt', base64: Buffer.from('alpha NEEDLE omega\n').toString('base64'), expectedVersion: null });
      const listed = await files({ kind: 'list', path: '/workspace/tools', limit: 50 });
      assert.equal(listed.kind, 'list');
      assert.ok(listed.entries.some((entry: any) => entry.path.endsWith('needle.txt')), 'the listing must show the file just written');
      const found = await files({ kind: 'search', path: '/workspace', pattern: 'NEEDLE', limit: 20 });
      assert.equal(found.kind, 'search');
      assert.ok(found.matches.length >= 1, 'the guest search must find the written content');
      const statted = await files({ kind: 'stat', path: '/workspace/tools/needle.txt' });
      assert.equal(statted.kind, 'stat');
      assert.equal(statted.entry.size, 19);
      await files({ kind: 'rename', path: '/workspace/tools/needle.txt', destination: '/workspace/tools/renamed.txt', expectedVersion: statted.entry.version });
      // A stat answers "gone" with a null entry rather than an error, so absence is asserted that way.
      assert.equal((await files({ kind: 'stat', path: '/workspace/tools/needle.txt' })).entry, null);
      const renamed = await files({ kind: 'stat', path: '/workspace/tools/renamed.txt' });
      await files({ kind: 'remove', path: '/workspace/tools/renamed.txt', expectedVersion: renamed.entry.version });
      assert.equal((await files({ kind: 'stat', path: '/workspace/tools/renamed.txt' })).entry, null);

      stage = 'guest access denial';
      // Another project's identity must not reach this environment, and a stale generation must not
      // either — both are refusals the environment owes its caller, not conveniences.
      await assert.rejects(
        runtime.projectFiles({ project: { kind: 'managed', projectId: 9 }, accountUserId: 1, operation: { kind: 'read', path: '/workspace/runtime-proof', maxBytes: 64 } }),
        /forbidden|denied|not found|unavailable/i,
      );
      await assert.rejects(
        runtime.projectFiles({ ...actor, expectedGeneration: 99, operation: { kind: 'read', path: '/workspace/runtime-proof', maxBytes: 64 } }),
        /generation/i,
      );
      // The container is the boundary, so a guest path is not refused for being outside /workspace.
      // What must be refused is a path the protocol cannot express safely.
      await assert.rejects(files({ kind: 'read', path: 'relative/path', maxBytes: 64 }), /path|invalid|absolute/i);
      stage = 'managed worktrees and gateway preview';
      const worktrees = await runtime.managedWorktrees({ ...actor, action: { kind: 'create', label: 'retained', baseRef: 'main' } });
      assert.equal(worktrees.length, 1);
      const server = await runtime.prepareExecution({ command: { type: 'shell', command: 'systemd-run --unit=preview-target --service-type=exec /usr/bin/python3 -m http.server 8081 --bind 127.0.0.1 --directory /workspace' }, projectRef: actor.project, cwd: '/workspace', leaseKind: 'terminal' }, 1);
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
      stage = 'full project snapshot and fresh-generation restore';
      const saved = await perform({ kind: 'snapshot' });
      await runtime.managedWorktrees({ ...actor, action: { kind: 'create', label: 'after-snapshot', baseRef: 'main' } });
      await files({ kind: 'write', path: '/workspace/runtime-proof', base64: Buffer.from('changed').toString('base64'), expectedVersion: read.version });
      await perform({ kind: 'restore', snapshotId: saved.snapshotId });
      assert.equal((await runtime.environmentFor(actor)).generation, 2);
      const restored = await files({ kind: 'read', path: '/workspace/runtime-proof', maxBytes: 1024 });
      assert.equal(Buffer.from(restored.base64, 'base64').toString(), 'snapshot value');
      await perform({ kind: 'stop' }); await perform({ kind: 'start' });
      const verify = await runtime.prepareExecution({ command: { type: 'shell', command: 'set -eu; test "$(cat /rootfs-managed)" = root; test "$(cat /root/managed)" = home; test "$(cat /data/managed)" = data' }, projectRef: actor.project, cwd: '/workspace', leaseKind: 'terminal' }, 1);
      assert.equal((await runPrepared(verify)).code, 0);
      const retained = await runtime.managedWorktrees({ ...actor, action: { kind: 'list' } });
      assert.equal(retained.length, 1, 'Organizational worktree metadata must follow the restored snapshot');
      await runtime.managedWorktrees({ ...actor, action: { kind: 'remove', workspaceId: retained[0].id } });
      stage = 'managed source publication';
      const seed = await runtime.prepareExecution({ command: { type: 'shell', command: 'mkdir /workspace/publication; printf executable > /workspace/publication/program.sh; chmod 755 /workspace/publication/program.sh; ln -s program.sh /workspace/publication/relative-link' }, projectRef: actor.project, cwd: '/workspace', leaseKind: 'terminal' }, 1);
      await runPrepared(seed);
      const destination = join(scratch, 'published-copy');
      const registration = { siteId: 'copy-site', projectId: 7, image: PROJECT_BASE_IMAGE_TAG, sourcePath: destination,
        sitesDataDir: join(scratch, 'sites'), brokerDir: join(scratch, 'broker'), workspaceReadOnly: true, network: 'isolated',
        limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512, diskSoftMb: 10240 }, staging: true };
      runtime.connectSitesRuntime({ resolve: async () => registration, beforeStart: async () => {}, afterStop: async () => {}, projectDependents: async () => [],
        resolveArtifact: async () => ({ kind: 'project-source', project: actor.project, guestPath: '/workspace/publication', destinationPath: destination }) });
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
    } finally { await runtime.dispose(); sql.close(); }
    console.log('Real Podman inspect and guest-control observations:', JSON.stringify(observations));
  } catch (error) {
    console.error(`Real Podman stage failed: ${stage}`);
    console.error('Observed engine responses:', JSON.stringify(observations));
    throw error;
  } finally {
    // Cleanup uses the already-verified prefix and env, never the daemon's account defaults.
    // Reset is confined to this exclusively created store and its test images/volumes/containers.
    if (engineVerified && verifiedLaunch) {
      const result = await guarded.run('/usr/bin/podman', [...expectedPrefix, 'system', 'reset', '--force'], { ...verifiedLaunch, timeoutMs: 120_000 });
      if (result.code !== 0) {
        writeFileSync(join(scratch, 'cleanup-failed.json'), JSON.stringify({ stage, result, isolation: paths }));
        throw new Error(`Private Podman cleanup failed; retained test scratch ${scratch}: ${result.stderr}`);
      }
    }
    rmSync(scratch, { recursive: true, force: true });
    console.log('Private Podman resources and scratch removed:', scratch);
  }
}, 600_000);
