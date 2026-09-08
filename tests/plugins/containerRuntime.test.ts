import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContainerSpec, createLegacySiteSpec, executionUnit, volumeLabels } from '../../plugins/sandbox/lib/containerSpec.mjs';
import { cleanPodmanEnv, PodmanClient, SpawnExecutor, isolatedPodmanOptions } from '../../plugins/sandbox/lib/podman.mjs';
import { PROJECT_CONTAINERFILE } from '../../plugins/sandbox/lib/containerBaseImage.mjs';
import { ContainerStorage } from '../../plugins/sandbox/lib/containerStorage.mjs';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'elowen-runtime-test-'));
  roots.push(root);
  const paths = { sandboxDataDir: join(root, 'sandbox'), sitesDataDir: join(root, 'sites'), siteSourcesDir: join(root, 'sources'), siteBrokerDir: join(root, 'brokers') };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const spec = createContainerSpec({ resource: { kind: 'project', id: 7 }, generation: 2, image: 'localhost/elowen-project-base:test' }, paths);
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
    if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: JSON.stringify([volumes.get(args[2]!)]), stderr: '' };
    if (args[0] === 'exec') return { code: 0, stdout: 'LoadState=masked\nActiveState=inactive\nSubState=dead\nControlGroup=\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }) };
  return { row, containers, volumes, executor, client: new PodmanClient({ executor }) };
}

it('mounts a new local-bind restore volume inside the same rootless namespace as import', async () => {
  const { spec, paths } = fixture();
  const target = createContainerSpec({ resource: spec.resource, generation: 3, image: spec.image }, paths);
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
    expect(spec.mounts.map((m: any) => m.target)).toEqual(['/workspace', '/root', '/data']);
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
    expect(() => createContainerSpec({ resource: { kind: 'project', id: 1 }, generation: 1, image: 'test', mounts: [] }, paths)).toThrow(/unknown/i);
  });
  it.each([{ resource: { kind: 'project', id: '../2' } }, { generation: 0 }, { image: '--privileged' }, { limits: { cpus: 0 } }, { network: 'host' }])('rejects invalid spec input %j', (override) => {
    const { paths } = fixture();
    expect(() => createContainerSpec({ resource: { kind: 'project', id: 1 }, generation: 1, image: 'localhost/test:v1', ...override }, paths)).toThrow();
  });
  it('binds the specification hash to generation, image, limits and paths', () => {
    const { spec, paths } = fixture();
    const other = createContainerSpec({ resource: spec.resource, generation: 3, image: spec.image }, paths);
    expect(other.labels['io.elowen.spec']).not.toBe(spec.labels['io.elowen.spec']);
    expect(spec.labels['io.elowen.runtime']).toBe('sandbox');
    expect(spec.labels['io.elowen.resource']).toBe('project:7');
  });
});

describe('explicit legacy Site handover binding', () => {
  function legacyFixture() {
    const { root, paths } = fixture();
    const binding = { sitesDataDir: paths.sitesDataDir, sourcePath: join(root, 'original-project/source'), brokerDir: join(paths.siteBrokerDir, 'site-1'),
      containerId: 'a'.repeat(64), imageId: 'd'.repeat(64), volumeMountpoint: join(root, 'legacy-podman/volumes/elowen-site-site-1-data/_data') };
    const spec = createLegacySiteSpec({ resource: { kind: 'site', id: 'site-1' }, generation: 8, image: 'localhost/site:v1', workspaceReadOnly: true }, binding);
    for (const mount of spec.mounts.filter((mount: any) => mount.type === 'bind')) {
      if (mount.target === '/workspace/.git') { mkdirSync(dirname(mount.source), { recursive: true }); writeFileSync(mount.source, ''); }
      else mkdirSync(mount.source, { recursive: true });
    }
    mkdirSync(binding.volumeMountpoint, { recursive: true });
    const state = fake(spec);
    Object.assign(state.row, { Image: binding.imageId });
    // Recorded default-local volume shape; substitute only this fixture's identity and private path.
    const recordedVolume = JSON.parse(readFileSync(new URL('./fixtures/podman-4.9.3-legacy-volume.json', import.meta.url), 'utf8'));
    state.volumes.set(spec.volumes[0].name, { ...recordedVolume, Name: spec.volumes[0].name, Labels: { 'io.elowen.site': 'site-1' }, Mountpoint: binding.volumeMountpoint });
    return { spec, binding, ...state };
  }
  it('preserves the original name, sourcePath, Git stub, broker and named volume', async () => {
    const { spec, binding, client, executor } = legacyFixture();
    expect(spec.name).toBe('elowen-site-site-1');
    expect(spec.volumes[0].name).toBe('elowen-site-site-1-data');
    expect(spec.mounts[0]).toEqual({ type: 'bind', source: binding.sourcePath, target: '/workspace', readOnly: true });
    expect(spec.mounts[1].target).toBe('/workspace/.git');
    expect(spec.mounts[1].readOnly).toBe(true);
    expect(spec.mounts[2].source).toBe(binding.brokerDir);
    expect(spec.labels).toEqual({ 'io.elowen.site': 'site-1' });
    expect(spec.specHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(client.inspectBinding(spec)).resolves.toEqual({ id: binding.containerId, state: 'running' });
    expect(executor.run.mock.calls.every(([, args]) => ['inspect', 'container', 'volume'].includes(args[0]!))).toBe(true);
  });
  it('accepts the recorded isolated IPC default only in an explicit legacy binding', async () => {
    const { spec, client, row } = legacyFixture();
    const recorded = JSON.parse(readFileSync(new URL('./fixtures/podman-4.9.3-container-defaults.json', import.meta.url), 'utf8'));
    Object.assign(row.HostConfig, recorded.HostConfig);
    await expect(client.inspectBinding(spec)).resolves.toMatchObject({ state: 'running' });
    const project = fixture().spec;
    const managed = fake(project);
    Object.assign(managed.row.HostConfig, recorded.HostConfig);
    await expect(managed.client.inspectBinding(project)).rejects.toThrow(/mismatch/);
  });
  it.each(['containerId', 'imageId', 'labels', 'volumeLabels', 'volumePath', 'source', 'gitWritable'])('rejects mismatched legacy %s', async (field) => {
    const { spec, client, row, volumes } = legacyFixture();
    if (field === 'containerId') row.Id = 'b'.repeat(64);
    if (field === 'imageId') Object.assign(row, { Image: 'b'.repeat(64) });
    if (field === 'labels') row.Config.Labels = { ...row.Config.Labels, 'io.elowen.runtime': 'foreign' };
    if (field === 'volumeLabels') volumes.get(spec.volumes[0].name).Labels = { 'io.elowen.site': 'foreign' };
    if (field === 'volumePath') volumes.get(spec.volumes[0].name).Mountpoint = '/foreign';
    if (field === 'source') row.Mounts[0]!.Source = '/foreign';
    if (field === 'gitWritable') row.Mounts[1]!.RW = true;
    await expect(client.inspectBinding(spec)).rejects.toThrow(/mismatch/);
  });
  it('never recreates an adopted legacy container or its missing volume', async () => {
    const { spec, client, volumes, executor } = legacyFixture();
    await expect(client.create(spec)).rejects.toThrow(/legacy|recreat/i);
    volumes.clear();
    await expect(client.ensureVolume(spec, 'data')).rejects.toThrow(/missing/i);
    expect(executor.run.mock.calls.some(([, args]) => args.includes('create'))).toBe(false);
  });
  it('rejects binding input with arbitrary names, mounts, invalid IDs or project identity', () => {
    const { binding } = legacyFixture();
    const input = { resource: { kind: 'site', id: 'site-1' }, generation: 1, image: 'localhost/site:v1' };
    expect(() => createLegacySiteSpec(input, { ...binding, name: 'other-container' })).toThrow(/unknown/i);
    expect(() => createLegacySiteSpec(input, { ...binding, mounts: [] })).toThrow(/unknown/i);
    expect(() => createLegacySiteSpec(input, { ...binding, containerId: 'name' })).toThrow(/identity/i);
    expect(() => createLegacySiteSpec({ ...input, resource: { kind: 'project', id: 1 } }, binding)).toThrow(/site/i);
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
    const spec = createContainerSpec({ resource: { kind: 'project', id: 7 }, generation: 2, image: 'localhost/test:v1' }, { ...paths, namespace: 'test-a' });
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
    const foreign = createContainerSpec({ resource: spec.resource, generation: 2, image: spec.image }, paths);
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
    await expect(client.start(spec)).rejects.toThrow(/mismatch/i);
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
    await expect(client.cancelExecution(spec, id)).resolves.toEqual({ terminated: true, unit: executionUnit(spec, id) });
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

describe('project container storage and crash-consistent snapshots', () => {
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
    const manifest = await new ContainerStorage(client).snapshot(spec, 'snap-1');
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
    const target = createContainerSpec({ resource: spec.resource, generation: 3, image: imageId }, paths);
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
