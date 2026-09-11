import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindContainerIdentity, createContainerSpec, createEnvironmentDiskSpec, executionUnit, publicationUnit, volumeLabels } from '../../plugins/sandbox/lib/containerSpec.mjs';
import { cleanPodmanEnv, PodmanClient, SpawnExecutor, isolatedPodmanOptions } from '../../plugins/sandbox/lib/podman.mjs';
import { PROJECT_CONTAINERFILE } from '../../plugins/sandbox/lib/containerBaseImage.mjs';
import { ContainerStorage } from '../../plugins/sandbox/lib/containerStorage.mjs';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'elowen-runtime-test-'));
  roots.push(root);
  const paths = { sandboxDataDir: join(root, 'sandbox'), sitesDataDir: join(root, 'sites'), siteSourcesDir: join(root, 'sources'), siteBrokerDir: join(root, 'brokers') };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const spec = createContainerSpec({ resource: { kind: 'project', id: 7 }, workspaceTarget: '/demo', generation: 2, image: 'localhost/elowen-project-base:test' }, paths);
  return { root, paths, spec };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function inspected(spec: any) {
  return { Id: 'a'.repeat(64), Name: spec.name, ImageName: spec.image, Config: { Labels: spec.labels },
    State: { Status: 'running' }, HostConfig: { Privileged: false, NetworkMode: spec.network, Memory: spec.limits.memoryMb * 1024 * 1024,
      MemorySwap: spec.limits.memoryMb * 1024 * 1024, NanoCpus: spec.limits.cpus * 1e9, PidsLimit: spec.limits.pidsLimit,
      PidMode: 'private', IpcMode: spec.ipcMode, ReadonlyRootfs: false, PortBindings: {} },
    Mounts: spec.mounts.map((mount: any) => ({ Type: mount.type, Destination: mount.target, Source: mount.source, Name: mount.type === 'volume' ? mount.source : undefined, RW: !mount.readOnly })),
  };
}
function fake(spec: any) {
  const row = inspected(spec);
  // Model the store's container-existence state, including removal, instead of always reporting
  // existence: production verifies `rm` by absence, so the fake must be able to observe it.
  const containers = new Map<string, string>([[spec.name, row.Id]]);
  const volumes = new Map<string, any>(spec.volumes.map((volume: any) => [volume.name, { Name: volume.name, Labels: volumeLabels(spec, volume.component), Driver: 'local', Options: { type: 'none', o: 'bind', device: volume.path } }]));
  const executor = { run: vi.fn(async (_file: string, args: string[], _options: any) => {
    if (args[0] === 'container' && args[1] === 'exists') return { code: containers.has(args[2]!) ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'rm') { for (const [name, id] of containers) if (id === args[1]) containers.delete(name); return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'inspect') return { code: 0, stdout: JSON.stringify([row]), stderr: '' };
    if (args[0] === 'volume' && args[1] === 'exists') return { code: volumes.has(args[2]!) ? 0 : 1, stdout: '', stderr: '' };
    // Real `podman volume inspect` accepts several names and answers with one row per name, in order,
    // and fails when any of them is absent. The ownership check inspects every volume of a spec in one
    // invocation, so a fake that only ever answered for args[2] would not be modelling the tool.
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const names = args.slice(2);
      const rows = names.map((name) => volumes.get(name!)).filter(Boolean);
      if (rows.length !== names.length) return { code: 125, stdout: '[]', stderr: 'no such volume' };
      return { code: 0, stdout: JSON.stringify(rows), stderr: '' };
    }
    if (args[0] === 'exec') return { code: 0, stdout: 'LoadState=masked\nActiveState=inactive\nSubState=dead\nControlGroup=\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }) };
  return { row, containers, volumes, executor, client: new PodmanClient({ executor }) };
}

it('mounts a new local-bind restore volume inside the same rootless namespace as import', async () => {
  const { spec, paths } = fixture();
  const target = createContainerSpec({ resource: spec.resource, workspaceTarget: '/demo', generation: 3, image: spec.image }, paths);
  mkdirSync(join(spec.storageRoot, 'snapshots/import-test'), { recursive: true });
  writeFileSync(join(spec.storageRoot, 'snapshots/import-test/workspace.tar'), 'opaque archive');
  const state = fake(target);
  state.volumes.clear();
  const original = state.executor.run.getMockImplementation()!;
  state.executor.run.mockImplementation(async (file, args, options) => {
    if (args[0] === 'container' && args[1] === 'exists') return { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'volume' && args[1] === 'create') {
      const volume = target.volumes[0];
      state.volumes.set(volume.name, { Name: volume.name, Labels: volumeLabels(target, 'workspace'), Driver: 'local', Options: { type: 'none', o: 'bind', device: volume.path } });
    }
    if (args[0] === 'volume' && args[1] === 'import') return { code: 125, stdout: '', stderr: 'volume is using a driver local and volume is not mounted' };
    return original(file, args, options);
  });
  await state.client.importSnapshotVolume(spec, 'import-test', target, 'workspace');
  const archiveCall = state.executor.run.mock.calls.find((call) => call[1][0] === 'unshare');
  expect(archiveCall?.[1][3]).toContain('volume mount');
  expect(archiveCall?.[1][3]).toContain('volume unmount');
  expect(archiveCall?.[1]).toContain(target.volumes[0].name);
});

describe('trusted container specifications', () => {
  it('derives exclusive project storage, persistent HOME and real Git mounts', () => {
    const { spec, root } = fixture();
    expect(spec.name).toBe('elowen-project-7-g2');
    expect(spec.volumes.map((v: any) => v.component)).toEqual(['workspace', 'home', 'data']);
    expect(spec.mounts.map((m: any) => m.target)).toEqual(['/demo', '/root', '/data']);
    expect(spec.workdir).toBe('/demo');
    expect(spec.volumes[0].path).toBe(join(root, 'sandbox/projects/7/storage/2/workspace'));
    expect(spec.limits).toEqual({ cpus: 1, memoryMb: 1024, pidsLimit: 512 });
    expect(Object.isFrozen(spec.mounts[0])).toBe(true);
  });
  it('preserves Sites source and read-only Git stub without accepting arbitrary mounts', () => {
    const { paths } = fixture();
    const spec = createContainerSpec({ resource: { kind: 'site', id: 'abc-123' }, generation: 1, image: 'localhost/site:test', workspaceReadOnly: true }, paths);
    expect(spec.mounts).toContainEqual({ type: 'bind', source: join(paths.siteSourcesDir, 'abc-123'), target: '/workspace', readOnly: true });
    expect(spec.mounts).toContainEqual({ type: 'bind', source: join(paths.sitesDataDir, 'abc-123/environment/git-stub'), target: '/workspace/.git', readOnly: true });
    expect(spec.volumes.map((v: any) => v.component)).toEqual(['data']);
    expect(() => createContainerSpec({ resource: { kind: 'project', id: 1 }, workspaceTarget: '/demo', generation: 1, image: 'test', mounts: [] }, paths)).toThrow(/unknown/i);
  });
  it.each([{ resource: { kind: 'project', id: '../2' } }, { generation: 0 }, { image: '--privileged' }, { limits: { cpus: 0 } }, { network: 'host' }])('rejects invalid spec input %j', (override) => {
    const { paths } = fixture();
    expect(() => createContainerSpec({ resource: { kind: 'project', id: 1 }, workspaceTarget: '/demo', generation: 1, image: 'localhost/test:v1', ...override }, paths)).toThrow();
  });
  it('binds rootfs disk identity and component paths into a new Project specification', () => {
    const { paths } = fixture();
    const resource = { kind: 'project' as const, id: 7 };
    const image = 'localhost/elowen-project-base:test';
    const disk = createEnvironmentDiskSpec({ resource, image }, paths, 'a'.repeat(32));
    const spec = createContainerSpec({ resource, workspaceTarget: '/demo', generation: 2, image, disk }, paths);
    expect(spec.disk.rootfsPath).toBe(join(paths.sandboxDataDir, 'projects/7/disks', 'a'.repeat(32), 'rootfs'));
    expect(spec.volumes.map((volume: any) => volume.path)).toEqual(disk.components.map((entry: any) => entry.path));
    expect(spec.labels['io.elowen.disk']).toBe(disk.id);
    const otherDisk = createEnvironmentDiskSpec({ resource, image }, paths, 'b'.repeat(32));
    const other = createContainerSpec({ resource, workspaceTarget: '/demo', generation: 2, image, disk: otherDisk }, paths);
    expect(other.specHash).not.toBe(spec.specHash);
  });

  it('binds the specification hash to generation, image, limits and paths', () => {
    const { spec, paths } = fixture();
    const other = createContainerSpec({ resource: spec.resource, workspaceTarget: '/demo', generation: 3, image: spec.image }, paths);
    expect(other.labels['io.elowen.spec']).not.toBe(spec.labels['io.elowen.spec']);
    expect(spec.labels['io.elowen.runtime']).toBe('sandbox');
    expect(spec.labels['io.elowen.resource']).toBe('project:7');
  });
});

describe('clean and confined Podman client', () => {
  it('reads the real rootless info field casing without treating missing userbus as success', async () => {
    // Recorded Podman 4.9.3 response excerpt; only temporary paths are normalized.
    const stdout = readFileSync(new URL('./fixtures/podman-4.9.3-isolated-info.json', import.meta.url), 'utf8');
    const executor = { run: vi.fn(async () => ({ code: 0, stdout, stderr: '' })) };
    await expect(new PodmanClient({ executor }).info()).resolves.toEqual({ version: '4.9.3', rootless: true,
      graphRoot: '/isolated/storage', runRoot: '/isolated/runroot', cgroupManager: 'cgroupfs' });
  });
  it('provides a deterministic project recipe with usable Git and systemd execution', () => {
    expect(PROJECT_CONTAINERFILE).toContain('git openssh-client python3');
    expect(PROJECT_CONTAINERFILE).toContain('systemd systemd-sysv');
    expect(PROJECT_CONTAINERFILE).toContain('ENTRYPOINT ["/sbin/init"]');
    expect(PROJECT_CONTAINERFILE).not.toContain('git-stub');
  });
  it('uses fresh private isolation directories and refuses reuse', () => {
    const { root } = fixture();
    const directory = join(root, 'isolated');
    isolatedPodmanOptions(directory, 'one');
    expect(() => isolatedPodmanOptions(directory, 'two')).toThrow(/exists|fresh/i);
  });
  it('launches bounded subprocesses with truncation reporting and stdin', async () => {
    const executor = new SpawnExecutor();
    const result = await executor.run(process.execPath, ['-e', 'process.stdin.on("data", data => process.stdout.write(data))'], {
      env: cleanPodmanEnv(), input: 'abcdefghijklmnop', timeoutMs: 5000, outputLimitBytes: 8,
    });
    expect(result).toEqual({ code: 0, stdout: 'ijklmnop', stderr: '', truncated: true });
  });
  it('cleans timeout and spawn-error paths without an unhandled stdin error', async () => {
    const executor = new SpawnExecutor();
    await expect(executor.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: cleanPodmanEnv(), timeoutMs: 25, outputLimitBytes: 32,
    })).rejects.toThrow(/timed out/);
    await expect(executor.run('/nonexistent/elowen-test-executable', [], {
      env: cleanPodmanEnv(), input: 'test', timeoutMs: 1000, outputLimitBytes: 32,
    })).rejects.toThrow(/ENOENT/);
  });
  it('updates an adopted running container while keeping its creation identity stable', async () => {
    const { spec, root } = fixture();
    const source = join(root, 'adopted-project');
    mkdirSync(source);
    writeFileSync(join(source, 'marker.txt'), 'adopted');
    const { client, executor } = fake(spec);
    await new ContainerStorage(client).adoptWorkspace(spec, source);
    await client.start(spec);

    const requested = { cpus: 2, memoryMb: 6144, pidsLimit: 4096 };
    const updated = await client.update(spec, requested);

    expect(updated.limits).toEqual(requested);
    expect(updated.creationLimits).toEqual(spec.limits);
    expect(executor.run.mock.calls.find(([, args]) => args[0] === 'update')?.[1]).toEqual([
      'update', '--memory=6144m', '--memory-swap=6144m', '--cpus=2', '--pids-limit=4096', 'a'.repeat(64),
    ]);
  });

  it('creates with rootless limits, persistent mounts and no host networking or automatic removal', async () => {
    const { spec } = fixture();
    const { client, executor } = fake(spec);
    await new ContainerStorage(client).prepare(spec);
    const original = executor.run.getMockImplementation()!;
    let created = false;
    executor.run.mockImplementation(async (file, args, opts) => {
      if (args[0] === 'info') return { code: 0, stdout: 'true', stderr: '' };
      if (args[0] === 'container' && args[1] === 'exists') return { code: created ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'create') { created = true; return { code: 0, stdout: 'a'.repeat(64), stderr: '' }; }
      return original(file, args, opts);
    });
    await client.create(spec);
    const args = executor.run.mock.calls.find(([, args]) => args[0] === 'create')![1];
    expect(args).toEqual(expect.arrayContaining(['--cgroups=split', '--systemd=always', '--memory=1024m', '--memory-swap=1024m', '--cpus=1', '--pids-limit=512']));
    expect(args).not.toContain('--rm');
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--network=host');
  });
  it('bounds guest execution with a named cgroup and sends scripts only on stdin', async () => {
    const { spec } = fixture();
    const { client, executor } = fake(spec);
    await client.exec(spec, 'e'.repeat(32), ['/bin/bash', '-s'], { input: 'echo guest-input', timeoutMs: 1000 });
    const [, args, options] = executor.run.mock.calls.find(([, args]) => args.includes('systemd-run'))!;
    expect(args).toContain('--property=KillMode=control-group');
    expect(args).toContain('--property=RuntimeMaxSec=1s');
    // The container's pids cgroup is the declared bound. Without this the guest systemd applies
    // DefaultTasksMax, 15% of it, and an execution suffocates far below the environment's own limit.
    expect(args).toContain('--property=TasksMax=infinity');
    expect(args.join(' ')).not.toContain('echo guest-input');
    expect(options.input).toBe('echo guest-input');
    expect(executor.run.mock.calls.some(([, args]) => args.includes('unmask'))).toBe(true);
  });
  it('checks guest cancellation after a launcher timeout', async () => {
    const { spec } = fixture();
    const { client, executor } = fake(spec);
    const original = executor.run.getMockImplementation()!;
    executor.run.mockImplementation(async (file, args, opts) => {
      if (args.includes('systemd-run')) throw new Error('launcher timed out');
      return original(file, args, opts);
    });
    await expect(client.exec(spec, 'f'.repeat(32), ['/bin/true'])).rejects.toThrow('launcher timed out');
    expect(executor.run.mock.calls.some(([, args]) => args.includes('mask'))).toBe(true);
    expect(executor.run.mock.calls.some(([, args]) => args.includes('show'))).toBe(true);
  });
  it('never inherits daemon credentials or remote Podman settings', () => {
    const env = cleanPodmanEnv({ uid: 123, home: '/home/service', user: 'service' });
    expect(env).toEqual({ HOME: '/home/service', USER: 'service', LOGNAME: 'service', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', XDG_RUNTIME_DIR: '/run/user/123', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/123/bus' });
  });
  it('pins every test store, runroot, runtime, temporary path and namespace', async () => {
    const { root, paths } = fixture();
    const spec = createContainerSpec({ resource: { kind: 'project', id: 7 }, workspaceTarget: '/demo', generation: 2, image: 'localhost/test:v1' }, { ...paths, namespace: 'test-a' });
    const executor = { run: vi.fn(async () => ({ code: 1, stdout: '', stderr: '' })) };
    const options = isolatedPodmanOptions(join(root, 'podman'), 'test-a');
    const client = new PodmanClient({ ...options, executor });
    await client.inspect(spec);
    const [, args, launch] = executor.run.mock.calls[0]! as any;
    expect(args).toEqual(expect.arrayContaining(['--root', join(root, 'podman/storage'), '--runroot', join(root, 'podman/runroot'), '--tmpdir', join(root, 'podman/tmp'), '--storage-driver', 'vfs']));
    expect(launch.env.HOME).toBe(join(root, 'podman/home'));
    expect(launch.env.XDG_RUNTIME_DIR).toBe(join(root, 'podman/runtime'));
    expect(launch.env.TMPDIR).toBe(join(root, 'podman/tmp'));
    expect(args).not.toContain('--namespace');
    const foreign = createContainerSpec({ resource: spec.resource, workspaceTarget: '/demo', generation: 2, image: spec.image }, paths);
    await expect(client.inspect(foreign)).rejects.toThrow(/namespace/);
    expect(executor.run).toHaveBeenCalledOnce();
    expect(() => isolatedPodmanOptions(join(root, 'path-that-is-too-long-for-a-runroot-socket'), 'test')).toThrow(/50 bytes/);
    expect(() => new PodmanClient({ isolation: { root: root } })).toThrow(/isolation/i);
  });
  it('does not expose raw host commands and refuses forged specs', async () => {
    const { spec } = fixture();
    const { client, executor } = fake(spec);
    expect((client as any).run).toBeUndefined();
    await expect(client.start({ ...spec, name: 'foreign' })).rejects.toThrow(/trusted/i);
    expect(executor.run).not.toHaveBeenCalled();
  });
  it.each(['labels', 'mounts', 'image', 'network', 'cpus', 'missingQuota', 'capabilities', 'privileged', 'ports'])('refuses mismatched %s before a mutation', async (field) => {
    const { spec } = fixture();
    const { client, row, executor } = fake(spec);
    if (field === 'labels') row.Config.Labels = { ...row.Config.Labels, 'io.elowen.generation': '1' };
    if (field === 'mounts') row.Mounts.push({ Type: 'bind', Source: '/host', Destination: '/host', RW: true } as any);
    if (field === 'image') row.ImageName = 'foreign';
    if (field === 'network') row.HostConfig.NetworkMode = 'host';
    if (field === 'cpus') row.HostConfig.NanoCpus = 0;
    if (field === 'missingQuota') Object.assign(row.HostConfig, { NanoCpus: 0, CpuPeriod: 100000 });
    if (field === 'capabilities') Object.assign(row.HostConfig, { CapAdd: ['SYS_ADMIN'] });
    if (field === 'privileged') row.HostConfig.Privileged = true;
    if (field === 'ports') row.HostConfig.PortBindings = { '80/tcp': [] };
    const expectedField = field === 'missingQuota' ? 'cpus' : field;
    await expect(client.start(spec)).rejects.toThrow(new RegExp(`mismatch: .*${expectedField}`, 'i'));
    expect(executor.run.mock.calls.some(([, args]) => args[0] === 'start')).toBe(false);
  });
  it('targets the inspected immutable ID rather than the replaceable name', async () => {
    const { spec } = fixture();
    const { client, executor } = fake(spec);
    await client.start(spec);
    expect(executor.run.mock.calls.at(-1)?.[1]).toEqual(['start', 'a'.repeat(64)]);
  });
  it('does not mistake an inspect failure for a missing container', async () => {
    const { spec } = fixture();
    const executor = { run: vi.fn(async () => ({ code: 125, stdout: '', stderr: 'storage permission denied' })) };
    await expect(new PodmanClient({ executor }).inspect(spec)).rejects.toThrow(/125/);
  });
  it('verifies container removal against modeled store state instead of a constant exists', async () => {
    const { spec } = fixture();
    const { client, row, executor } = fake(spec);
    row.State.Status = 'stopped';
    await client.remove(spec);
    const removal = executor.run.mock.calls.find(([, args]) => args[0] === 'rm')!;
    expect(removal![1]).toEqual(['rm', 'a'.repeat(64)]);
    await expect(client.inspect(spec)).resolves.toBeNull();
    await expect(client.remove(spec)).rejects.toThrow(/missing/i);
    expect(executor.run.mock.calls.filter(([, args]) => args[0] === 'rm')).toHaveLength(1);
  });
  // A container row is DATA. If a public cleanup entry point accepted one, any caller could name a
  // different 64-character id and have every `podman exec` below aimed at it without a single inspection
  // — the in-call reuse that saves the duplicate ownership check would have become a way to skip the
  // check entirely. So the public surface takes no row at all, and this pins that: the options a caller
  // can reach must not contain one, and passing one anyway changes nothing.
  it.each(['releaseExecution', 'cancelExecution'] as const)('cannot be made to skip verification by handing %s a forged container row', async (method) => {
    const { spec } = fixture();
    const { client, executor } = fake(spec);
    const forged = { id: 'f'.repeat(64), state: 'running' };
    const executionId = 'c'.repeat(32);

    await client[method](spec, executionId, { persistent: true, container: forged, completionCapture: false } as never)
      .catch(() => { /* the assertions below are about what it DID, not whether it resolved */ });

    // The full ownership check ran regardless: the container and every volume were inspected.
    expect(executor.run.mock.calls.filter(([, args]) => args[0] === 'container' && args[1] === 'exists')).toHaveLength(1);
    expect(executor.run.mock.calls.filter(([, args]) => args[0] === 'inspect')).toHaveLength(1);
    expect(executor.run.mock.calls.filter(([, args]) => args[0] === 'volume' && args[1] === 'inspect')).toHaveLength(1);
    // And nothing was ever addressed to the forged identity.
    expect(executor.run.mock.calls.some(([, args]) => args.includes(forged.id))).toBe(false);
    for (const [, args] of executor.run.mock.calls.filter(([, a]) => a[0] === 'exec')) expect(args[1]).toBe('a'.repeat(64));
  });

  // A prepared execution verified ownership before it launched. Settling it afterwards through the
  // closure the client bound at that moment reuses that verification instead of inspecting the container
  // and every volume all over again, which is most of what an interactive shell command paid for after
  // its own work had already finished.
  it('settles a prepared execution without repeating the ownership inspection', async () => {
    // Production pins the container's immutable identity into the specification once the container
    // exists, and that pin is what makes the reuse below admissible at all.
    const spec = bindContainerIdentity(fixture().spec, 'a'.repeat(64));
    const { client, executor } = fake(spec);
    const executionId = 'b'.repeat(32);
    const prepared = await client.prepareExecution(spec, executionId, ['/bin/bash', '-s'], { input: 'ls\n' });
    expect(prepared.launch.args).toContain('systemd-run');
    executor.run.mockClear();

    await prepared.settle();
    expect(executor.run.mock.calls.filter(([, args]) => args[0] === 'inspect')).toHaveLength(0);
    expect(executor.run.mock.calls.filter(([, args]) => args[0] === 'volume' && args[1] === 'inspect')).toHaveLength(0);
    expect(executor.run.mock.calls.filter(([, args]) => args[0] === 'container' && args[1] === 'exists')).toHaveLength(0);
    // Every command it did issue went to the container preparation verified, never to anything else.
    for (const [, args] of executor.run.mock.calls.filter(([, a]) => a[0] === 'exec')) expect(args[1]).toBe('a'.repeat(64));
  });

  // The closure is the ONLY way that reuse is reachable. It carries the verified row and whether capture
  // was armed as bound state, so there remains nowhere for a caller to put a row of its own.
  it('exposes no way to supply a row to the settlement closure', async () => {
    const spec = bindContainerIdentity(fixture().spec, 'a'.repeat(64));
    const { client, executor } = fake(spec);
    const prepared = await client.prepareExecution(spec, 'd'.repeat(32), ['/bin/bash', '-s'], {});
    executor.run.mockClear();

    const forged = { id: 'f'.repeat(64), state: 'running' };
    await prepared.settle({ container: forged, completionCapture: true } as never).catch(() => { /* what it DID is the point */ });
    expect(executor.run.mock.calls.some(([, args]) => args.includes(forged.id))).toBe(false);
  });

  it('verifies container ownership once per release instead of twice in a row', async () => {
    // A release cancels and then unmasks. The cancellation already inspected the container and every
    // volume; repeating that inspection immediately afterwards cost five extra Podman invocations on
    // every guest operation and could observe nothing the cancellation had not just established.
    const { spec } = fixture();
    const { client, executor } = fake(spec);
    await client.releaseExecution(spec, 'd'.repeat(32));
    const inspections = executor.run.mock.calls.filter(([, args]) => args.includes('inspect'));
    const containerInspections = inspections.filter(([, args]) => args.includes('container'));
    expect(containerInspections).toHaveLength(1);
    // The unmask still runs, so the saving is a removed duplicate rather than a removed step.
    const guest = executor.run.mock.calls.filter(([, args]) => args[0] === 'exec').map(([, args]) => args.slice(2));
    expect(guest.at(-1)).toEqual(['systemctl', 'unmask', '--runtime', executionUnit(spec, 'd'.repeat(32))]);
  });
  it('releases a settled execution on one guest round trip instead of the termination tombstone', async () => {
    // A managed Git read runs five subcommands, and every one of them paid six guest round trips to
    // mask, stop, re-mask, verify and unmask a transient unit that `--collect` had already retired.
    // Measured on the live running project-12 container, seven guest execs cost 5.4s of a 7.3s command
    // while all twenty of its metadata calls together cost 1.9s, so this is the dominant term.
    const { spec } = fixture();
    const { client, executor } = fake(spec);
    const unit = executionUnit(spec, 'e'.repeat(32));
    const original = executor.run.getMockImplementation()!;
    executor.run.mockImplementation(async (file: string, args: string[], options: any) => {
      // A settled launcher's unit is gone: this is what systemd reports for a collected transient unit.
      if (args[0] === 'exec') return { code: 0, stdout: 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\n', stderr: '' };
      return original(file, args, options);
    });
    await client.releaseExecution(spec, 'e'.repeat(32), { persistent: true });
    const guest = executor.run.mock.calls.filter(([, args]) => args[0] === 'exec').map(([, args]) => args.slice(2));
    expect(guest).toEqual([
      ['systemctl', 'show', '--property=LoadState,ActiveState,SubState,ControlGroup', unit],
      ['/usr/bin/rm', '-f', '--', expect.stringContaining('e'.repeat(32))],
    ]);
    // Nothing was masked, so nothing has to be unmasked, and ownership was still verified exactly once.
    expect(executor.run.mock.calls.filter(([, args]) => args[0] === 'inspect' && args.includes('container'))).toHaveLength(1);
  });

  it('still terminates and unmasks when the unit is anything other than proven absent', async () => {
    // The saving is proven absence, never an assumption of it: a unit still loaded, and the masked
    // tombstone an earlier cancellation left behind, both take the full termination path.
    for (const state of ['LoadState=masked\nActiveState=inactive\nSubState=dead\nControlGroup=\n',
      'LoadState=loaded\nActiveState=active\nSubState=running\nControlGroup=/system.slice/x\n']) {
      const { spec } = fixture();
      const { client, executor } = fake(spec);
      let shown = 0;
      const original = executor.run.getMockImplementation()!;
      executor.run.mockImplementation(async (file: string, args: string[], options: any) => {
        // Only the first `show` is the release probe; the tombstone's own verification follows it.
        if (args[0] === 'exec' && args.includes('show') && shown++ === 0) return { code: 0, stdout: state, stderr: '' };
        return original(file, args, options);
      });
      await client.releaseExecution(spec, 'f'.repeat(32));
      const guest = executor.run.mock.calls.filter(([, args]) => args[0] === 'exec')
        .map(([, args]) => (args[2] === 'systemctl' ? args[3] : args[2]));
      expect(guest, `unit reported as ${state.split('\n')[0]}`).toEqual(['show', 'mask', 'stop', 'mask', 'show', '/usr/bin/rm', 'unmask']);
    }
  });

  it('does not read a refused or truncated probe as a retired unit', async () => {
    // A probe that could not answer says nothing about the unit. Treating that silence as absence would
    // skip the termination on exactly the runs where the guest is least healthy, so it terminates instead.
    for (const probe of [{ code: 1, stdout: '', stderr: 'container is not running' },
      { code: 0, stdout: 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\n', stderr: '', truncated: true }]) {
      const { spec } = fixture();
      const { client, executor } = fake(spec);
      let shown = 0;
      const original = executor.run.getMockImplementation()!;
      executor.run.mockImplementation(async (file: string, args: string[], options: any) => {
        if (args[0] === 'exec' && args.includes('show') && shown++ === 0) return probe;
        return original(file, args, options);
      });
      await client.releaseExecution(spec, 'f'.repeat(32));
      const guest = executor.run.mock.calls.filter(([, args]) => args[0] === 'exec')
        .map(([, args]) => (args[2] === 'systemctl' ? args[3] : args[2]));
      expect(guest, `probe rc=${probe.code} truncated=${probe.truncated ?? false}`).toEqual(['show', 'mask', 'stop', 'mask', 'show', '/usr/bin/rm', 'unmask']);
    }
  });

  it('refuses to release a container that is no longer running', async () => {
    // Release verifies the container it is releasing from. A stopped or replaced one cannot prove that
    // the execution ended, and that is reported rather than passed off as a completed cleanup.
    const { spec } = fixture();
    const { client, row } = fake(spec);
    row.State.Status = 'stopped';
    await expect(client.releaseExecution(spec, 'f'.repeat(32))).rejects.toThrow(/termination cannot be verified/i);
  });

  it('bounds command input before launching and retains truncation metadata', async () => {
    const { spec } = fixture();
    const { client, executor } = fake(spec);
    await expect(client.exec(spec, 'a'.repeat(32), ['/bin/bash', '-s'], { input: 'a'.repeat(1024 * 1024 + 1) })).rejects.toThrow(/input/i);
    expect(executor.run).not.toHaveBeenCalled();
  });
  it('masks late starts, stops guest cgroups and verifies termination', async () => {
    const { spec } = fixture();
    const { client, executor } = fake(spec);
    const id = 'b'.repeat(32);
    await expect(client.cancelExecution(spec, id)).resolves.toMatchObject({ terminated: true, unit: executionUnit(spec, id) });
    const guest = executor.run.mock.calls.filter(([, args]) => args[0] === 'exec').map(([, args]) => args.slice(2));
    expect(guest[0]).toEqual(['systemctl', 'mask', '--runtime', executionUnit(spec, id)]);
    expect(guest[1]).toEqual(['systemctl', 'stop', executionUnit(spec, id)]);
    expect(guest[2]).toEqual(['systemctl', 'mask', '--runtime', executionUnit(spec, id)]);
    expect(guest[3]).toContain('show');
  });
  it('re-establishes the cancellation mask after the recorded transient-unit collection', async () => {
    const { spec } = fixture();
    const { client, executor } = fake(spec);
    const collected = JSON.parse(readFileSync(new URL('./fixtures/podman-4.9.3-collected-unit.json', import.meta.url), 'utf8'));
    const original = executor.run.getMockImplementation()!;
    let stopped = false;
    let remasked = false;
    executor.run.mockImplementation(async (file, args, opts) => {
      if (args.includes('stop')) stopped = true;
      if (args.includes('mask') && stopped) remasked = true;
      if (args.includes('show') && stopped && !remasked) return collected;
      return original(file, args, opts);
    });
    await expect(client.cancelExecution(spec, 'a'.repeat(32))).resolves.toMatchObject({ terminated: true });
    expect(remasked).toBe(true);
  });
  it('reports failed guest termination instead of equating client exit to cancellation', async () => {
    const { spec } = fixture();
    const { client, executor } = fake(spec);
    const original = executor.run.getMockImplementation()!;
    executor.run.mockImplementation(async (file, args, opts) => args.includes('show') ? { code: 0, stdout: 'LoadState=loaded\nActiveState=deactivating\nControlGroup=/work\n', stderr: '' } : original(file, args, opts));
    await expect(client.cancelExecution(spec, 'c'.repeat(32))).rejects.toThrow(/termination/i);
  });
});

// A project adopted in place keeps its directory where it was until the first start of its environment;
// this is the moment it becomes the project's own workspace volume, and the branch that runs depends on
// whether the volume lives on the same filesystem. /dev/shm is the one other filesystem a Linux test can
// be sure of; where it is the same one, the case cannot be constructed and the test says so.
const otherFilesystem = (() => {
  try { return lstatSync('/dev/shm').isDirectory() && lstatSync('/dev/shm').dev !== lstatSync(tmpdir()).dev ? mkdtempSync(join('/dev/shm', 'elowen-adopt-')) : null; }
  catch { return null; }
})();
afterEach(() => { if (otherFilesystem) rmSync(otherFilesystem, { recursive: true, force: true }); });

describe('adopted project workspace', () => {
  it('brings an adopted host directory into the project workspace volume exactly once', async () => {
    const { spec, root } = fixture();
    const source = join(root, 'host-project');
    mkdirSync(join(source, 'src'), { recursive: true });
    writeFileSync(join(source, 'src/index.js'), 'module.exports = 1');
    writeFileSync(join(source, 'README.md'), 'read me');
    symlinkSync('src/index.js', join(source, 'link'));
    const storage = new ContainerStorage({});

    expect(await storage.adoptWorkspace(spec, source)).toBe(true);
    const workspace = spec.volumes.find((volume: any) => volume.component === 'workspace')!.path;
    expect(readFileSync(join(workspace, 'src/index.js'), 'utf8')).toBe('module.exports = 1');
    expect(readlinkSync(join(workspace, 'link'))).toBe('src/index.js');
    // The second start finds a workspace that already holds the project and moves nothing, so the
    // operation is idempotent on the one condition it can actually observe.
    expect(await storage.adoptWorkspace(spec, source)).toBe(false);
    expect(await storage.releaseWorkspace(spec, source)).toBe(true);
    expect(readFileSync(join(source, 'src/index.js'), 'utf8')).toBe('module.exports = 1');
    expect(() => lstatSync(workspace)).toThrow();
  });

  it('refuses an adopted directory that is missing or reached through a symlink, and ignores an empty one', async () => {
    const { spec, root } = fixture();
    const storage = new ContainerStorage({});
    const empty = join(root, 'empty-project');
    mkdirSync(empty);
    expect(await storage.adoptWorkspace(spec, empty)).toBe(false);
    await expect(storage.adoptWorkspace(spec, join(root, 'never-existed'))).rejects.toThrow(/missing/);
    const real = join(root, 'real-project');
    mkdirSync(real);
    writeFileSync(join(real, 'file.txt'), 'content');
    const alias = join(root, 'project-alias');
    symlinkSync(real, alias);
    await expect(storage.adoptWorkspace(spec, alias)).rejects.toThrow(/symlink/i);
  });

  it.runIf(otherFilesystem !== null)('stages and verifies a cross-filesystem move before removing the original', async () => {
    const { spec } = fixture();
    const source = join(otherFilesystem!, 'host-project');
    mkdirSync(join(source, 'src'), { recursive: true });
    writeFileSync(join(source, 'src/index.js'), 'module.exports = 1');
    symlinkSync('src/index.js', join(source, 'link'));
    expect(await new ContainerStorage({}).adoptWorkspace(spec, source)).toBe(true);
    const workspace = spec.volumes.find((volume: any) => volume.component === 'workspace')!.path;
    expect(readFileSync(join(workspace, 'src/index.js'), 'utf8')).toBe('module.exports = 1');
    expect(readlinkSync(join(workspace, 'link'))).toBe('src/index.js');
    expect(() => lstatSync(source)).toThrow();
    expect(() => lstatSync(`${workspace}.adopting`)).toThrow();
    expect(await new ContainerStorage({}).releaseWorkspace(spec, source)).toBe(true);
    expect(readFileSync(join(source, 'src/index.js'), 'utf8')).toBe('module.exports = 1');
    expect(() => lstatSync(workspace)).toThrow();
    expect(() => lstatSync(`${source}.releasing`)).toThrow();
  });
});

describe('durable publication transport', () => {
  // A publication's forwarder is persistent and re-established rather than leased, so the arguments the
  // guest unit is configured with, and the checks around it, are the whole of its contract.
  function publishing() {
    const { paths, root } = fixture();
    const spec = createContainerSpec({ resource: { kind: 'project', id: 7 }, workspaceTarget: '/demo', generation: 2,
      image: 'localhost/elowen-project-base:test', previewBroker: true }, paths);
    const state = fake(spec);
    const original = state.executor.run.getMockImplementation()!;
    state.executor.run.mockImplementation(async (file: string, args: string[], options: any) => {
      if (args[0] === 'exec' && args.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
      if (args[0] === 'exec' && args.includes('stop')) return { code: 0, stdout: '', stderr: '' };
      return original(file, args, options);
    });
    return { spec, root, ...state };
  }
  const forwarded = (executor: any) => executor.run.mock.calls.filter(([, args]: any[]) => args[0] === 'exec').map(([, args]: any[]) => args.slice(2));

  it('establishes a forwarder as a named persistent unit, retiring a leftover one first', async () => {
    const { spec, client, executor } = publishing();
    await client.startPublication(spec, 'shop', ['/usr/bin/python3', '-c', 'forwarder', '8080', '/run/elowen/pub-shop.sock']);
    const run = executor.run.mock.calls.find(([, args]: any[]) => args.includes('systemd-run'))![1];
    expect(run).toContain(`--unit=${publicationUnit('shop')}`);
    expect(run).toContain('--collect');
    expect(run).toContain('--property=KillMode=control-group');
    // Not an execution: nothing waits for it, nothing bounds how long it may live, and it never reads a
    // caller's stdin.
    expect(run.join(' ')).not.toMatch(/--wait|--pipe|RuntimeMaxSec/);
    // A forwarder left over under the same name refuses a second systemd-run, so it is retired first…
    expect(forwarded(executor)[0]).toEqual(['systemctl', 'stop', publicationUnit('shop')]);
    // …and the unit is only believed once systemd reports it active.
    expect(forwarded(executor).at(-1)).toEqual(['systemctl', 'is-active', publicationUnit('shop')]);
    expect(await client.activePublications(spec, ['shop', 'blog'])).toEqual(['shop']);
    expect(forwarded(executor).at(-1)).toEqual(['systemctl', 'is-active', publicationUnit('shop'), publicationUnit('blog')]);
    expect(Buffer.byteLength(publicationUnit('6cd4e63e-5c4b-4f74-8b91-d61cd8da4d90'))).toBeLessThan(64);
  });

  it('refuses a forwarder that never became active and one that did not stop', async () => {
    const { spec, client, executor } = publishing();
    const original = executor.run.getMockImplementation()!;
    let reported = 'active\n';
    executor.run.mockImplementation(async (file: string, args: string[], options: any) =>
      (args[0] === 'exec' && args.includes('is-active') ? { code: 0, stdout: reported, stderr: '' } : original(file, args, options)));
    reported = 'inactive\n';
    await expect(client.startPublication(spec, 'shop', ['/usr/bin/python3', '-c', 'forwarder', '8080', '/run/elowen/pub-shop.sock']))
      .rejects.toThrow(/did not start/);
    reported = 'active\n';
    await expect(client.stopPublication(spec, 'shop')).rejects.toThrow(/did not stop/);
    // A publication transport without the guest mount it forwards through is refused outright.
    const { paths } = fixture();
    const plain = createContainerSpec({ resource: { kind: 'project', id: 7 }, workspaceTarget: '/demo', generation: 2, image: 'localhost/test:v1' }, paths);
    await expect(client.startPublication(plain, 'shop', ['/bin/true'])).rejects.toThrow(/unavailable/);
    expect(() => publicationUnit('Shop 1')).toThrow(/token/i);
  });
});

describe('project container storage and crash-consistent snapshots', () => {
  it('captures and restores format 2 rootfs and components into a new disk', async () => {
    const { paths } = fixture();
    const resource = { kind: 'project' as const, id: 7 };
    const image = 'localhost/elowen-project-base:test';
    const disk = createEnvironmentDiskSpec({ resource, image }, paths, 'c'.repeat(32));
    const spec = createContainerSpec({ resource, workspaceTarget: '/demo', generation: 2, image, disk }, paths);
    mkdirSync(disk.rootfsPath, { recursive: true });
    for (const component of disk.components) mkdirSync(component.path, { recursive: true });
    writeFileSync(join(disk.rootfsPath, 'etc-marker'), 'before');
    for (const component of disk.components) writeFileSync(join(component.path, 'marker'), component.component);
    writeFileSync(join(disk.rootfsPath, '..', 'disk.json'), JSON.stringify({ sourceImageId: 'sha256:' + 'd'.repeat(64) }));
    const copyDiskTree = vi.fn(async (source: string, target: string) => {
      for (const name of readdirSync(source)) cpSync(join(source, name), join(target, name), { recursive: true, preserveTimestamps: true });
    });
    const fingerprintDiskTree = vi.fn(async (root: string) => {
      const rows: string[] = [];
      let logicalBytes = 0;
      const walk = (directory: string, prefix = '') => {
        for (const name of readdirSync(directory).sort()) {
          const path = join(directory, name); const stat = lstatSync(path); const relative = prefix ? `${prefix}/${name}` : name;
          logicalBytes += stat.size;
          if (stat.isDirectory()) { rows.push(`${relative}/`); walk(path, relative); }
          else rows.push(`${relative}:${readFileSync(path, 'hex')}`);
        }
      };
      walk(root);
      return { logicalBytes, allocatedBytes: 0, digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
    });
    const client = { inspect: vi.fn(async () => ({ state: 'running' })), pause: vi.fn(), unpause: vi.fn(), copyDiskTree,
      syncDiskTree: vi.fn(), fingerprintDiskTree, ensureVolume: vi.fn(), inspectSnapshotImage: vi.fn(), inspectRetainedSiteImage: vi.fn() };
    const storage = new ContainerStorage(client);
    const manifest: any = await storage.snapshot(spec, 'disk-snapshot');
    expect(manifest.version).toBe(2);
    expect(manifest.trees.map((tree: any) => tree.component)).toEqual(['rootfs', 'workspace', 'home', 'data']);
    writeFileSync(join(disk.rootfsPath, 'etc-marker'), 'after');

    const targetDisk = createEnvironmentDiskSpec({ resource, image }, paths, 'd'.repeat(32));
    const target = createContainerSpec({ resource, workspaceTarget: '/demo', generation: 3, image, disk: targetDisk }, paths);
    await storage.restoreVolumes(spec, 'disk-snapshot', target);
    expect(readFileSync(join(targetDisk.rootfsPath, 'etc-marker'), 'utf8')).toBe('before');
    expect(readFileSync(join(targetDisk.components[0]!.path, 'marker'), 'utf8')).toBe('workspace');
    expect(readFileSync(join(disk.rootfsPath, 'etc-marker'), 'utf8')).toBe('after');
  });

  it('rejects symlinked storage ancestors before creating a volume', async () => {
    const { spec, paths, root } = fixture();
    symlinkSync(root, join(paths.sandboxDataDir, 'projects'));
    const { client, executor } = fake(spec);
    await expect(new ContainerStorage(client).prepare(spec)).rejects.toThrow(/symlink/i);
    expect(executor.run).not.toHaveBeenCalled();
  });
  it('refuses an existing foreign volume even if its name matches', async () => {
    const { spec } = fixture();
    const { client, volumes } = fake(spec);
    volumes.set(spec.volumes[0].name, { Name: spec.volumes[0].name, Labels: {}, Driver: 'local', Options: {} });
    await expect(new ContainerStorage(client).prepare(spec)).rejects.toThrow(/ownership|mismatch/i);
  });
  it('captures rootfs, workspace/Git, HOME and data while paused, then durably completes the manifest', async () => {
    const { spec } = fixture();
    const calls: string[] = [];
    const client = {
      inspect: vi.fn(async () => ({ id: 'a'.repeat(64), state: 'running' })),
      pause: vi.fn(async () => { calls.push('pause'); }),
      unpause: vi.fn(async () => { calls.push('unpause'); }),
      snapshotImage: vi.fn(async () => { calls.push('rootfs'); return 'sha256:' + 'd'.repeat(64); }),
      exportVolume: vi.fn(async (spec: any, component: string, snapshotId: string) => { calls.push(component); writeFileSync(join(spec.storageRoot, 'snapshots', snapshotId, `${component}.tar`), component); }),
    };
    const manifest: any = await new ContainerStorage(client).snapshot(spec, 'snap-1');
    expect(calls).toEqual(['pause', 'rootfs', 'workspace', 'home', 'data', 'unpause']);
    expect(manifest.completeProject).toBe(true);
    expect(manifest.consistency).toBe('crash-consistent');
    expect(manifest.components.map((c: any) => c.component)).toEqual(['workspace', 'home', 'data']);
    expect(JSON.parse(readFileSync(join(spec.storageRoot, 'snapshots/snap-1/manifest.json'), 'utf8'))).toEqual(manifest);
    expect(() => readFileSync(join(spec.storageRoot, 'snapshots/snap-1/pending.json'))).toThrow();
  });
  it('preserves partial snapshots and exposes both export and resume failures', async () => {
    const { spec } = fixture();
    const client = { inspect: vi.fn(async () => ({ state: 'running' })), pause: vi.fn(), unpause: vi.fn(async () => { throw new Error('resume failed'); }),
      snapshotImage: vi.fn(async () => 'sha256:' + 'd'.repeat(64)), exportVolume: vi.fn(async () => { throw new Error('disk full'); }) };
    await expect(new ContainerStorage(client).snapshot(spec, 'snap-fail')).rejects.toThrow(/disk full.*resume failed/s);
    expect(client.unpause).toHaveBeenCalledOnce();
    expect(() => readFileSync(join(spec.storageRoot, 'snapshots/snap-fail/manifest.json'))).toThrow();
    expect(readFileSync(join(spec.storageRoot, 'snapshots/snap-fail/pending.json'), 'utf8')).toContain('snap-fail');
  });
  it('rechecks an ambiguous pause failure and restores the observed running state', async () => {
    const { spec } = fixture();
    const client = { inspect: vi.fn().mockResolvedValueOnce({ state: 'running' }).mockResolvedValue({ state: 'paused' }),
      pause: vi.fn(async () => { throw new Error('pause client timed out'); }), unpause: vi.fn() };
    await expect(new ContainerStorage(client).snapshot(spec, 'pause-fail')).rejects.toThrow('pause client timed out');
    expect(client.unpause).toHaveBeenCalledOnce();
  });
  it('validates snapshots and restores every component only into a new generation', async () => {
    const { spec, paths } = fixture();
    const imageId = 'sha256:' + 'd'.repeat(64);
    const client = { inspect: vi.fn(async () => ({ state: 'stopped' })), snapshotImage: vi.fn(async () => imageId),
      inspectSnapshotImage: vi.fn(async () => imageId), importSnapshotVolume: vi.fn(),
      exportVolume: vi.fn(async (spec: any, component: string, id: string) => writeFileSync(join(spec.storageRoot, 'snapshots', id, `${component}.tar`), component)) };
    const storage = new ContainerStorage(client);
    await storage.snapshot(spec, 'restore-1');
    const target = createContainerSpec({ resource: spec.resource, workspaceTarget: '/demo', generation: 3, image: imageId }, paths);
    const manifest = await storage.restoreVolumes(spec, 'restore-1', target);
    expect(manifest.completeProject).toBe(true);
    expect(client.importSnapshotVolume.mock.calls.map((call: any[]) => call[3])).toEqual(['workspace', 'home', 'data']);
    await expect(storage.restoreVolumes(spec, 'restore-1', spec)).rejects.toThrow(/generation|image/);
    writeFileSync(join(spec.storageRoot, 'snapshots/restore-1/data.tar'), 'changed');
    await expect(storage.readSnapshot(spec, 'restore-1')).rejects.toThrow(/integrity/);
  });
  it('labels volumes by exact resource, storage generation and component', () => {
    const { spec } = fixture();
    expect(volumeLabels(spec, 'workspace')).toMatchObject({ 'io.elowen.resource': 'project:7', 'io.elowen.generation': '2', 'io.elowen.component': 'workspace' });
  });
});
