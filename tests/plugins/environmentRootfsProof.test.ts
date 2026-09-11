import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PROJECT_BASE_IMAGE_TAG } from '../../plugins/sandbox/lib/containerBaseImage.mjs';
import { createContainerSpec, createEnvironmentDiskSpec } from '../../plugins/sandbox/lib/containerSpec.mjs';
import { ContainerStorage } from '../../plugins/sandbox/lib/containerStorage.mjs';
import { cleanPodmanEnv, PodmanClient } from '../../plugins/sandbox/lib/podman.mjs';

/**
 * Podman 4.9.3 Phase 0 proof for a persistent, exploded Project root filesystem.
 *
 * Observed inspect contract and quirks on the production rootless engine:
 * - the immutable binding is top-level `Rootfs`, which equals the direct host path; `Image` and
 *   `ImageName` are empty, while `Config.CreateCommand` also retains `--rootfs` and the path;
 * - `Config.SystemdMode` is true and `Config.StopSignal` is numeric 37 (`SIGRTMIN+3`);
 * - rootless mapping is implicit (`HostConfig.UsernsMode` is empty), and `--cgroups=split` is retained
 *   in `Config.CreateCommand` although `HostConfig.Cgroups` reads `default`;
 * - `HostConfig.Tmpfs` is empty even though Podman's systemd mode makes `/run` and `/tmp` volatile;
 * - the rootfs path must be used directly. A `:O` suffix asks Podman for an overlay upper layer and
 *   would move writes back into the replaceable container envelope.
 *
 * Image materialization uses `podman export` followed by GNU tar inside `podman unshare`, with numeric
 * owners, hard links, xattrs and sparse-file handling enabled. The envelope then repeats the current
 * Sandbox systemd, cgroup, IPC, limit, network, workdir, environment and mount settings explicitly,
 * because an exploded rootfs carries no image configuration into `podman create`.
 */

const podmanEnv = cleanPodmanEnv();
const availability = process.platform === 'linux'
  ? spawnSync('/usr/bin/podman', ['info', '--format', '{{.Host.Security.Rootless}}'], {
      encoding: 'utf8', env: podmanEnv, timeout: 10_000,
    })
  : null;
const podmanAvailable = availability?.status === 0 && availability.stdout.trim() === 'true';

type RunOptions = { allowFailure?: boolean; timeoutMs?: number };
function podman(args: string[], options: RunOptions = {}) {
  const result = spawnSync('/usr/bin/podman', args, {
    encoding: 'utf8', env: podmanEnv, timeout: options.timeoutMs ?? 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const row = { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  if (!options.allowFailure && row.code !== 0) {
    throw new Error(`podman ${args[0]} failed (${row.code}): ${row.stderr.trim()}`);
  }
  return row;
}

function inspect(name: string) {
  const rows = JSON.parse(podman(['inspect', '--type', 'container', name]).stdout);
  expect(rows).toHaveLength(1);
  return rows[0];
}

function waitForSystemd(name: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const bus = podman(['exec', name, '/usr/bin/test', '-S', '/run/dbus/system_bus_socket'], { allowFailure: true, timeoutMs: 5_000 });
    const state = podman(['exec', name, 'systemctl', 'is-system-running'], { allowFailure: true, timeoutMs: 5_000 });
    if (bus.code === 0 && ['running', 'degraded'].includes(state.stdout.trim())) return state.stdout.trim();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  const status = podman(['exec', name, 'systemctl', 'is-system-running'], { allowFailure: true });
  throw new Error(`systemd did not become ready: ${status.stdout.trim() || status.stderr.trim()}`);
}

it.skipIf(!podmanAvailable)('boots and recreates a systemd envelope over one durable exploded rootfs', async () => {
  const version = podman(['version', '--format', '{{.Client.Version}}']).stdout.trim();
  expect(version).toBe('4.9.3');

  const root = mkdtempSync(join(tmpdir(), 'elowen-p0-rootfs-'));
  const token = randomBytes(6).toString('hex');
  const seed = `elowen-p0-${token}-seed`;
  const first = `elowen-p0-${token}-one`;
  const second = `elowen-p0-${token}-two`;
  const rootfs = join(root, 'rootfs');
  const archive = join(root, 'rootfs.tar');
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const data = join(root, 'data');
  const containers = [seed, first, second];

  const createEnvelope = (name: string) => podman([
    'create', '--rootfs', '--name', name,
    '--label', `io.elowen.p0=${token}`,
    '--cgroups=split', '--systemd=always', '--stop-signal', 'SIGRTMIN+3',
    '--ipc=private', '--memory=512m', '--memory-swap=512m', '--cpus=1', '--pids-limit=512',
    '--network=none', '--workdir=/p0-workspace', '--env=HOME=/root', '--env=container=podman',
    '--mount', `type=bind,src=${workspace},dst=/p0-workspace`,
    '--mount', `type=bind,src=${home},dst=/root`,
    '--mount', `type=bind,src=${data},dst=/data`,
    rootfs, '/sbin/init',
  ]);

  try {
    mkdirSync(rootfs);
    mkdirSync(workspace);
    mkdirSync(home);
    mkdirSync(data);

    const client = new PodmanClient({ timeoutMs: 15 * 60_000 });
    expect(await client.ensureProjectImage(root)).toBe(PROJECT_BASE_IMAGE_TAG);

    podman(['create', '--name', seed, PROJECT_BASE_IMAGE_TAG]);
    podman(['export', '--output', archive, seed], { timeoutMs: 15 * 60_000 });
    podman(['rm', seed]);
    podman([
      'unshare', '/usr/bin/tar', '--extract', '--file', archive, '--directory', rootfs,
      '--numeric-owner', '--same-owner', '--xattrs', '--xattrs-include=*', '--sparse',
    ], { timeoutMs: 15 * 60_000 });

    expect(lstatSync(rootfs).uid).toBe(process.getuid?.());
    expect(podman(['unshare', '/usr/bin/stat', '--format=%u:%g', join(rootfs, 'etc')]).stdout.trim()).toBe('0:0');
    expect(existsSync(join(rootfs, 'sbin/init'))).toBe(true);

    createEnvelope(first);
    const created = inspect(first);
    expect(created.Rootfs).toBe(realpathSync(rootfs));
    expect(created.Image).toBe('');
    expect(created.ImageName).toBe('');
    expect(created.Path).toBe('/sbin/init');
    expect(created.Config.SystemdMode).toBe(true);
    expect(created.Config.StopSignal).toBe(37);
    expect(created.Config.CreateCommand).toContain('--rootfs');
    expect(created.Config.CreateCommand).toContain(realpathSync(rootfs));
    expect(created.HostConfig.UsernsMode).toBe('');
    expect(created.HostConfig.Cgroups).toBe('default');
    expect(created.HostConfig.Tmpfs).toEqual({});
    expect(created.Mounts.map((mount: { Destination: string }) => mount.Destination).sort()).toEqual([
      '/data', '/p0-workspace', '/root',
    ]);

    podman(['start', first]);
    expect(['running', 'degraded']).toContain(waitForSystemd(first));
    podman(['exec', first, '/bin/bash', '-lc', [
      'set -eu',
      'printf marker >/etc/elowen-p0-marker',
      'printf "#!/bin/sh\\necho installed\\n" >/usr/local/bin/elowen-p0-installed',
      'chmod 755 /usr/local/bin/elowen-p0-installed',
      'printf temporary >/tmp/elowen-p0-volatile',
      'printf runtime >/run/elowen-p0-volatile',
      'printf workspace >/p0-workspace/proof',
      'printf home >/root/proof',
      'printf data >/data/proof',
    ].join('; ')]);

    podman(['stop', '-t', '8', first]);
    const stopped = inspect(first);
    expect(stopped.Config.StopSignal).toBe(37);
    expect(stopped.State.Status).toBe('exited');
    expect(stopped.State.ExitCode).toBe(0);
    expect(stopped.State.StoppedByUser).toBe(true);
    podman(['rm', first]);

    expect(readFileSync(join(rootfs, 'etc/elowen-p0-marker'), 'utf8')).toBe('marker');
    expect(existsSync(join(rootfs, 'usr/local/bin/elowen-p0-installed'))).toBe(true);

    createEnvelope(second);
    const recreated = inspect(second);
    expect(recreated.Id).not.toBe(created.Id);
    expect(recreated.Rootfs).toBe(created.Rootfs);
    podman(['start', second]);
    expect(['running', 'degraded']).toContain(waitForSystemd(second));
    const persisted = podman(['exec', second, '/bin/bash', '-lc', [
      'set -eu',
      'test "$(cat /etc/elowen-p0-marker)" = marker',
      'test "$(/usr/local/bin/elowen-p0-installed)" = installed',
      'test "$(cat /p0-workspace/proof)" = workspace',
      'test "$(cat /root/proof)" = home',
      'test "$(cat /data/proof)" = data',
      'test ! -e /tmp/elowen-p0-volatile',
      'test ! -e /run/elowen-p0-volatile',
    ].join('; ')]);
    expect(persisted.code).toBe(0);

    podman(['stop', '-t', '8', second]);
    expect(inspect(second).State.ExitCode).toBe(0);
    podman(['rm', second]);
  } finally {
    for (const name of containers.reverse()) {
      if (podman(['container', 'exists', name], { allowFailure: true, timeoutMs: 10_000 }).code === 0) {
        podman(['rm', '--force', name], { allowFailure: true });
      }
    }
    podman(['unshare', '/usr/bin/rm', '-rf', '--', root], { allowFailure: true, timeoutMs: 180_000 });
    expect(existsSync(root)).toBe(false);
  }
}, 10 * 60_000);

it.skipIf(!podmanAvailable)('runs the production disk, envelope, snapshot and restore path', async () => {
  const token = randomBytes(6).toString('hex');
  const root = mkdtempSync(join(tmpdir(), `elowen-p2-${token}-`));
  const namespace = `elowen-p2-${token}`;
  const projectId = Number.parseInt(token.slice(0, 6), 16) + 1;
  const paths = { sandboxDataDir: root, namespace };
  const resource = { kind: 'project', id: projectId } as const;
  const client = new PodmanClient({ timeoutMs: 15 * 60_000 });
  const storage = new ContainerStorage(client);
  let source: any;
  let target: any;
  try {
    const image = await client.ensureProjectImage(root);
    const disk = createEnvironmentDiskSpec({ resource, image }, paths, `${token}${'a'.repeat(20)}`);
    source = createContainerSpec({ resource, workspaceTarget: '/proof', generation: 1, image, disk, network: 'isolated' }, paths);
    await storage.prepare(source);
    await client.create(source);
    await client.start(source);
    await client.waitForSystemBus(source);
    expect(podman(['exec', source.name, '/bin/bash', '-lc', 'printf before >/etc/elowen-p2-marker']).code).toBe(0);
    await client.stop(source); await client.remove(source);
    await client.create(source); await client.start(source); await client.waitForSystemBus(source);
    expect(podman(['exec', source.name, '/bin/cat', '/etc/elowen-p2-marker']).stdout).toBe('before');
    await storage.snapshot(source, 'elowen-p2-snapshot');

    const targetDisk = createEnvironmentDiskSpec({ resource, image }, paths, `${token}${'b'.repeat(20)}`);
    target = createContainerSpec({ resource, workspaceTarget: '/proof', generation: 2, image, disk: targetDisk, network: 'isolated' }, paths);
    await storage.restoreVolumes(source, 'elowen-p2-snapshot', target);
    await client.create(target); await client.start(target); await client.waitForSystemBus(target);
    expect(podman(['exec', target.name, '/bin/cat', '/etc/elowen-p2-marker']).stdout).toBe('before');
  } finally {
    for (const spec of [target, source].filter(Boolean)) {
      try { const row = await client.inspect(spec); if (row?.state === 'running' || row?.state === 'paused') await client.stop(spec); } catch {}
      try { if (await client.inspect(spec)) await client.remove(spec); } catch {}
      for (const volume of spec.volumes) try { await client.removeVolume(spec, volume.component); } catch {}
    }
    podman(['unshare', '/usr/bin/rm', '-rf', '--', root], { allowFailure: true, timeoutMs: 180_000 });
    expect(existsSync(root)).toBe(false);
  }
}, 15 * 60_000);
