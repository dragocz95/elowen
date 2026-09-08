import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { it } from 'vitest';
import { PodmanClient, SpawnExecutor, isolatedPodmanOptions } from '../../plugins/sandbox/lib/podman.mjs';
import { createContainerSpec, executionUnit } from '../../plugins/sandbox/lib/containerSpec.mjs';
import { ContainerStorage } from '../../plugins/sandbox/lib/containerStorage.mjs';
import { PROJECT_BASE_IMAGE_TAG } from '../../plugins/sandbox/lib/containerBaseImage.mjs';

// Explicit opt-in. This harness never constructs a default-store client, even for cleanup.
const storageOnly = process.env.ELOWEN_TEST_PODMAN_STAGE === 'storage';
it.runIf(process.env.ELOWEN_TEST_PODMAN === '1')(storageOnly ? 'validates only private Podman storage metadata' : 'runs the managed runtime in a fresh private Podman store', async () => {
  // Podman limits runroot to 50 bytes; long worktree paths cannot hold its runtime sockets.
  const scratch = mkdtempSync(join(tmpdir(), 'ep-'));
  const isolation = isolatedPodmanOptions(join(scratch, 'podman'), `test-${randomBytes(6).toString('hex')}`);
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
    for (const key of ['CONTAINER_HOST', 'CONTAINER_CONNECTION', 'CONTAINERS_STORAGE_CONF', 'GH_TOKEN', 'GITHUB_TOKEN', 'DBUS_SESSION_BUS_ADDRESS']) assert.equal(options.env[key], undefined);
    verifiedLaunch = { ...options, input: undefined, signal: undefined };
    const command = args.slice(expectedPrefix.length);
    const result = await native.run(file, args, options);
    if (command[0] === 'inspect' || (command[0] === 'volume' && command[1] === 'inspect') || command.includes('show')) observations.push({ command, ...result });
    if (command[0] === 'info') observations.push({ command, code: result.code, stderr: result.stderr });
    return result;
  } };
  const client = new PodmanClient({ ...isolation, executor: guarded });
  const execute = async (spec: any, script: string) => client.exec(spec, randomBytes(16).toString('hex'), ['/bin/bash', '-s'], { input: script, timeoutMs: 30_000 });
  try {
    console.log('Verified isolated Podman launch:', JSON.stringify({ args: expectedPrefix, HOME: paths.home, XDG_RUNTIME_DIR: paths.runtime, TMPDIR: paths.tmp }));
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
