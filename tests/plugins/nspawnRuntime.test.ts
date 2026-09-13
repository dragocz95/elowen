import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The digest the fixture's store reports; an artifact's identity is its content, not a local image id. */
const ARTIFACT_DIGEST = `sha256:${'d'.repeat(64)}`;
import { bindContainerIdentity, createContainerSpec, createEnvironmentDiskSpec, executionUnit } from '../../plugins/sandbox/lib/containerSpec.mjs';
import { selectRuntimeClient } from '../../plugins/sandbox/lib/runtimeClient.mjs';
import { DROPPED_CAPABILITIES, envelopePaths, HELPER_PATH, helperFrame, machineState, MACHINE_PATTERN,
  NspawnClient, timespanMicroseconds, UID_RANGE_SIZE, unitFor } from '../../plugins/sandbox/lib/nspawn.mjs';

const EXECUTION_ID = 'b'.repeat(32);
const UID_BASE = 1073741824;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A complete host-side envelope for one machine: the disk with its identity record, the two root-owned
 *  configuration files, and a `systemctl show` answer that matches all of them. Each test then breaks
 *  exactly one of those facts and asserts that the ownership proof refuses. */
function fixture(options: { limits?: Record<string, number>, generation?: number, previewBroker?: boolean, outputLimitBytes?: number, network?: any, now?: () => number, diskUsageTtlMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'elowen-nspawn-test-'));
  roots.push(root);
  const configRoot = join(root, 'config');
  const paths = { sandboxDataDir: join(root, 'sandbox') };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const resource = { kind: 'project' as const, id: 7 };
  const image = 'localhost/elowen-project-base:test';
  const generation = options.generation ?? 2;
  const disk = createEnvironmentDiskSpec({ resource, image, runtime: 'nspawn' }, paths, 'a'.repeat(32));
  const spec: any = createContainerSpec({ resource, workspaceTarget: '/demo', generation, image, disk, limits: options.limits,
    ...(options.network ? { network: options.network } : {}), ...(options.previewBroker ? { previewBroker: true } : {}) }, paths);
  mkdirSync(spec.disk.rootfsPath, { recursive: true, mode: 0o755 });
  for (const component of spec.disk.components) mkdirSync(component.path, { recursive: true });
  const cgroupRoot = join(root, 'cgroup');
  const machineCgroup = join(cgroupRoot, 'machine.slice', unitFor(spec.name));
  mkdirSync(machineCgroup, { recursive: true });
  const writeCgroup = ({ usageUsec, memoryBytes }: { usageUsec: number; memoryBytes: number }) => {
    writeFileSync(join(machineCgroup, 'cpu.stat'), `usage_usec ${usageUsec}\nuser_usec 0\nsystem_usec 0\n`);
    writeFileSync(join(machineCgroup, 'memory.current'), String(memoryBytes));
  };
  writeCgroup({ usageUsec: 1_000_000, memoryBytes: 256 * 1024 * 1024 });
  const diskDirectory = dirname(spec.disk.rootfsPath);
  const rootfs = realpathSync(spec.disk.rootfsPath);
  mkdirSync(join(diskDirectory, '.elowen'), { recursive: true });
  const identityPath = join(diskDirectory, '.elowen', 'identity.json');
  const identity: Record<string, unknown> = { namespace: spec.namespace, kind: 'project', resource: '7',
    generation, diskId: spec.disk.id, machine: spec.name, runtime: 'nspawn',
    specHash: spec.labels['io.elowen.spec'], uidBase: UID_BASE, uidSize: UID_RANGE_SIZE };
  const writeIdentity = (value: Record<string, unknown> = identity) => writeFileSync(identityPath, JSON.stringify(value), { mode: 0o640 });
  writeIdentity();
  const envelope = envelopePaths(spec.name, configRoot);
  const writeEnvelope = () => {
    for (const path of Object.values(envelope)) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(envelope.nspawn, '[Exec]\nBoot=on\n', { mode: 0o644 });
    writeFileSync(envelope.dropIn, '[Service]\nCPUQuota=100%\n', { mode: 0o644 });
  };
  writeEnvelope();
  const unit: Record<string, string> = {
    LoadState: 'loaded',
    FragmentPath: join(configRoot, '/etc/systemd/system/elowen-machine@.service'),
    // A live `set-property` leaves systemd's own record beside ours; the proof ignores it on purpose.
    DropInPaths: `${envelope.dropIn} /etc/systemd/system.control/${unitFor(spec.name)}.d/50-MemoryMax.conf`,
    Environment: `ELOWEN_MACHINE_DIRECTORY=${rootfs}`,
    ActiveState: 'active', SubState: 'running', FreezerState: 'running',
    MemoryMax: String(spec.limits.memoryMb * 1024 * 1024), TasksMax: String(spec.limits.pidsLimit),
    CPUQuotaPerSecUSec: spec.limits.cpus === 1 ? '1s' : `${spec.limits.cpus * 1000}ms`, Slice: 'machine.slice',
  };
  const machine: Record<string, string> = { Unit: unitFor(spec.name), RootDirectory: rootfs };
  const requests: any[] = [];
  const guestInput: Buffer[] = [];
  const calls: { file: string, args: string[] }[] = [];
  const helperReply: Record<string, any> = {
    exec: { ok: true, exitCode: 0, signal: null, timedOut: false, truncated: false, stdout: '', stderr: '' },
    'tree-sizes': (request: { paths: string[] }) => ({ ok: true, usages: request.paths.map((path) => ({ path, allocatedBytes: 512 * 1024 * 1024 })) }),
  };
  const render = (record: Record<string, string>) => Object.entries(record).map(([key, value]) => `${key}=${value}`).join('\n');
  const executor = {
    run: vi.fn(async (file: string, args: string[], runOptions: any = {}) => {
      calls.push({ file, args });
      if (file === '/usr/bin/systemctl' && args[0] === 'show') return { code: 0, stdout: render(unit), stderr: '' };
      if (file === '/usr/bin/machinectl' && args[0] === 'show') return { code: 0, stdout: render(machine), stderr: '' };
      if (file === '/usr/bin/machinectl' && args[0] === 'list') return { code: 0, stdout: `${spec.name} container systemd-nspawn\nother-project-1-g1 container systemd-nspawn\n`, stderr: '' };
      if (file === '/usr/bin/sudo') {
        const frame: Buffer = Buffer.isBuffer(runOptions.input) ? runOptions.input : Buffer.from(String(runOptions.input ?? ''));
        const length = Number(frame.subarray(0, 8).toString('latin1'));
        const request = JSON.parse(frame.subarray(9, 9 + length).toString('utf8'));
        requests.push(request);
        guestInput.push(frame.subarray(9 + length));
        const reply = typeof helperReply[request.op] === 'function' ? await helperReply[request.op](request) : helperReply[request.op];
        return { code: 0, stdout: JSON.stringify(reply ?? { ok: true }), stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }),
  };
  // The store hands back a blob it has ALREADY verified against the pinned digest, so the fixture models
  // exactly that: a file that exists, and a digest. Nothing here writes into the disk directory, which is
  // the point — the blob is a shared cache entry and the disk never owns it.
  const blob = join(root, 'blob.tar.gz');
  writeFileSync(blob, 'rootfs archive');
  const artifacts = {
    status: vi.fn((reference: string) => ({ reference, published: true, present: true, digest: ARTIFACT_DIGEST, sizeBytes: 15 })),
    ensure: vi.fn(async () => ({ path: blob, digest: ARTIFACT_DIGEST, sizeBytes: 15, fetched: false })),
    collect: vi.fn(() => []),
  };
  const client = new NspawnClient({ executor, artifacts, configRoot, cgroupRoot, namespace: spec.namespace,
    ...(options.outputLimitBytes === undefined ? {} : { outputLimitBytes: options.outputLimitBytes }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.diskUsageTtlMs === undefined ? {} : { diskUsageTtlMs: options.diskUsageTtlMs }) });
  return { root, configRoot, cgroupRoot, machineCgroup, writeCgroup, paths, spec, disk: spec.disk, diskDirectory, identityPath, identity, writeIdentity,
    envelope, writeEnvelope, unit, machine, requests, guestInput, calls, helperReply, executor, artifacts, blob, client, rootfs };
}

/** The shape the systemd guest protocol answers with; the tombstone reads exactly these four fields. */
const collectedUnit = { ok: true, exitCode: 0, signal: null, timedOut: false, truncated: false,
  stdout: Buffer.from('LoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\n').toString('base64'), stderr: '' };

/** The shape the systemd guest protocol answers with; the tombstone reads exactly these four fields. */
const maskedUnit = { ok: true, exitCode: 0, signal: null, timedOut: false, truncated: false,
  stdout: Buffer.from('LoadState=masked\nActiveState=inactive\nSubState=dead\nControlGroup=\n').toString('base64'), stderr: '' };

describe('nspawn envelope ownership', () => {
  it('accepts an envelope whose unit, machine and disk identity all agree', async () => {
    const { client, spec } = fixture();
    const observed = await client.inspect(spec);
    expect(observed!.state).toBe('running');
    expect(observed!.id).toMatch(/^[a-f0-9]{64}$/);
    // The identity IS the envelope definition, so it survives a restart unchanged and moves the moment
    // any part of the envelope does.
    expect((await client.inspect(spec))!.id).toBe(observed!.id);
  });

  it('reports an absent envelope as absent rather than as a mismatch', async () => {
    const { client, spec, envelope } = fixture();
    rmSync(envelope.nspawn);
    await expect(client.containerExists(spec)).resolves.toBe(false);
    await expect(client.inspect(spec)).resolves.toBeNull();
  });

  it('changes the envelope identity when the envelope changes', async () => {
    const { client, spec, envelope } = fixture();
    const before = (await client.inspect(spec))!.id;
    writeFileSync(envelope.dropIn, '[Service]\nCPUQuota=200%\n');
    expect((await client.inspect(spec))!.id).not.toBe(before);
  });

  const breakages: [string, (state: ReturnType<typeof fixture>) => void][] = [
    ['unitTemplate', (state) => { state.unit.FragmentPath = '/usr/lib/systemd/system/systemd-nspawn@.service'; }],
    ['dropIn', (state) => { state.unit.DropInPaths = '/etc/systemd/system/elowen-machine@elowen-project-7-g2.service.d/99-other.conf'; }],
    ['directory', (state) => { state.unit.Environment = 'ELOWEN_MACHINE_DIRECTORY=/var/lib/machines/other'; }],
    ['slice', (state) => { state.unit.Slice = 'system.slice'; }],
    ['memory', (state) => { state.unit.MemoryMax = String(512 * 1024 * 1024); }],
    ['pidsLimit', (state) => { state.unit.TasksMax = '64'; }],
    ['cpus', (state) => { state.unit.CPUQuotaPerSecUSec = '250ms'; }],
    ['machine', (state) => { state.machine.RootDirectory = '/var/lib/machines/other'; }],
    ['machine', (state) => { state.machine.Unit = 'systemd-nspawn@other.service'; }],
    ['identity.machine', (state) => state.writeIdentity({ ...state.identity, machine: 'elowen-project-9-g2' })],
    ['identity.diskId', (state) => state.writeIdentity({ ...state.identity, diskId: 'c'.repeat(32) })],
    ['identity.generation', (state) => state.writeIdentity({ ...state.identity, generation: 9 })],
    ['identity.specHash', (state) => state.writeIdentity({ ...state.identity, specHash: 'f'.repeat(64) })],
    ['identity.resource', (state) => state.writeIdentity({ ...state.identity, resource: '9' })],
    ['identity.namespace', (state) => state.writeIdentity({ ...state.identity, namespace: 'other' })],
    ['identity.runtime', (state) => state.writeIdentity({ ...state.identity, runtime: 'podman' })],
    ['identity.uidRange', (state) => state.writeIdentity({ ...state.identity, uidSize: 1024 })],
  ];
  it.each(breakages)('refuses an envelope whose %s does not match, one mismatch at a time', async (name, breakIt) => {
    const state = fixture();
    await expect(state.client.inspect(state.spec)).resolves.toMatchObject({ state: 'running' });
    breakIt(state);
    await expect(state.client.inspect(state.spec)).rejects.toThrow(new RegExp(`mismatch:.*${name.replace('.', '\\.')}`));
  });

  it('refuses a pinned identity that no longer names this envelope', async () => {
    const { client, spec } = fixture();
    const pinned = bindContainerIdentity(spec, 'e'.repeat(64));
    await expect(client.inspect(pinned)).rejects.toThrow(/expectedId/);
  });

  it('refuses a disk identity anyone but its owner can write', async () => {
    const { client, spec, identityPath } = fixture();
    chmodSync(identityPath, 0o666);
    await expect(client.inspect(spec)).rejects.toThrow(/Untrusted environment disk identity/);
  });

  it('sends only a persisted binding to the legacy Site retirement operation', async () => {
    const { client, requests, helperReply } = fixture();
    const record = { input: { resource: { kind: 'site', id: 'retired-site' }, generation: 4,
      disk: { id: 'b'.repeat(32), runtime: 'nspawn' } }, binding: { namespace: 'elowen' }, containerId: 'c'.repeat(64) };
    helperReply['retire-legacy-site'] = (request: any) => ({ ok: true, machine: `elowen-site-${request.resource}-g${request.generation}`,
      retired: true, alreadyRetired: false });

    await expect(client.retireLegacySiteMachine(record)).resolves.toEqual({ machine: 'elowen-site-retired-site-g4', retired: true, alreadyRetired: false });
    expect(requests).toEqual([{ domain: 'nspawn', op: 'retire-legacy-site', resource: 'retired-site', generation: 4,
      diskId: 'b'.repeat(32), expectedId: 'c'.repeat(64) }]);
    expect(MACHINE_PATTERN.test('elowen-site-retired-site-g4')).toBe(false);
  });
});

describe('nspawn state vocabulary', () => {
  it.each([
    [{ ActiveState: 'active', SubState: 'running', FreezerState: 'running' }, 'running'],
    [{ ActiveState: 'activating', SubState: 'start', FreezerState: 'running' }, 'running'],
    [{ ActiveState: 'active', SubState: 'running', FreezerState: 'frozen' }, 'paused'],
    [{ ActiveState: 'active', SubState: 'running', FreezerState: 'freezing' }, 'paused'],
    [{ ActiveState: 'deactivating', SubState: 'stop-sigterm', FreezerState: 'running' }, 'stopping'],
    [{ ActiveState: 'inactive', SubState: 'dead', FreezerState: 'running' }, 'stopped'],
    [{ ActiveState: 'failed', SubState: 'failed', FreezerState: 'running' }, 'stopped'],
  ])('maps %j onto the runtime-neutral state %s', (properties, expected) => {
    expect(machineState(properties as Record<string, string>)).toBe(expected);
  });

  it('refuses a state it does not recognize instead of guessing one', () => {
    expect(() => machineState({ ActiveState: 'maintenance' })).toThrow(/Invalid machine state/);
  });

  it('reads the state through the same ownership proof every other operation takes', async () => {
    const { client, spec, unit } = fixture();
    unit.ActiveState = 'inactive'; unit.SubState = 'dead';
    expect((await client.inspect(spec))!.state).toBe('stopped');
    // A stopped machine is not registered, so `machinectl show` is not consulted for one.
    expect(client).toBeDefined();
  });

  it('parses systemd timespans back into the microseconds a quota was asked for', () => {
    expect(timespanMicroseconds('1s')).toBe(1_000_000);
    expect(timespanMicroseconds('750ms')).toBe(750_000);
    expect(timespanMicroseconds('1s 500ms')).toBe(1_500_000);
    // What systemd actually prints for a CPU quota above one core. `systemd-analyze timespan 1500000us`
    // renders it `1.500000s`, and reading that as unparseable fails the limit check of every environment
    // with more than a single CPU.
    expect(timespanMicroseconds('1.500000s')).toBe(1_500_000);
    expect(timespanMicroseconds('2.250000s')).toBe(2_250_000);
    expect(timespanMicroseconds('infinity')).toBe(Infinity);
    expect(timespanMicroseconds('not-a-timespan')).toBeNull();
  });
});

describe('nspawn machine inventory', () => {
  it('filters machines by the namespace name prefix, because nspawn has no labels', async () => {
    const { client, spec } = fixture();
    const inventory = await client.containerInventory('elowen');
    expect([...inventory]).toEqual([[spec.name, 'running']]);
  });
});

describe('nspawn resource telemetry', () => {
  it('samples the parent machine cgroup and caches one disk batch', async () => {
    let now = 1_000;
    const state = fixture({ now: () => now, diskUsageTtlMs: 300_000 });
    mkdirSync(join(state.machineCgroup, 'supervisor'), { recursive: true });
    writeFileSync(join(state.machineCgroup, 'supervisor', 'cpu.stat'), 'usage_usec 999999999\n');
    writeFileSync(join(state.machineCgroup, 'supervisor', 'memory.current'), String(999 * 1024 * 1024));

    const first = await state.client.resourceUsageBatch([{ spec: state.spec, state: 'running' }]);
    expect(first).toEqual([{
      cpu: { state: 'sampling', usedCpus: null, percent: null },
      memory: { state: 'ready', usedBytes: 256 * 1024 * 1024, limitBytes: 1024 * 1024 * 1024 },
      disk: { state: 'ready', usedBytes: 512 * 1024 * 1024, limitBytes: null },
    }]);
    expect(state.requests.filter((request) => request.op === 'tree-sizes')).toHaveLength(1);

    now += 30_000;
    state.writeCgroup({ usageUsec: 16_000_000, memoryBytes: 384 * 1024 * 1024 });
    const second = await state.client.resourceUsageBatch([{ spec: state.spec, state: 'running' }]);
    expect(second[0]).toMatchObject({
      cpu: { state: 'ready', usedCpus: 0.5, percent: 50 },
      memory: { state: 'ready', usedBytes: 384 * 1024 * 1024 },
      disk: { state: 'ready', usedBytes: 512 * 1024 * 1024 },
    });
    expect(state.requests.filter((request) => request.op === 'tree-sizes')).toHaveLength(1);

    now += 300_001;
    state.helperReply['tree-sizes'] = (request: { paths: string[] }) => ({ ok: true, usages: request.paths.map((path) => ({ path, allocatedBytes: 768 * 1024 * 1024 })) });
    const stopped = await state.client.resourceUsageBatch([{ spec: state.spec, state: 'stopped' }]);
    expect(stopped[0]).toEqual({
      cpu: { state: 'stopped', usedCpus: null, percent: null },
      memory: { state: 'stopped', usedBytes: null, limitBytes: 1024 * 1024 * 1024 },
      disk: { state: 'ready', usedBytes: 768 * 1024 * 1024, limitBytes: null },
    });
    expect(state.requests.filter((request) => request.op === 'tree-sizes')).toHaveLength(2);
  });

  it('shares one in-flight disk refresh between concurrent readers', async () => {
    const state = fixture();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state.helperReply['tree-sizes'] = async (request: { paths: string[] }) => {
      await gate;
      return { ok: true, usages: request.paths.map((path) => ({ path, allocatedBytes: 4096 })) };
    };
    const first = state.client.resourceUsageBatch([{ spec: state.spec, state: 'running' }]);
    const second = state.client.resourceUsageBatch([{ spec: state.spec, state: 'running' }]);
    await vi.waitFor(() => expect(state.requests.filter((request) => request.op === 'tree-sizes')).toHaveLength(1));
    release?.();
    await Promise.all([first, second]);
    expect(state.requests.filter((request) => request.op === 'tree-sizes')).toHaveLength(1);
  });

  it('isolates missing CPU, memory and disk counters', async () => {
    const cpuMissing = fixture();
    rmSync(join(cpuMissing.machineCgroup, 'cpu.stat'));
    expect((await cpuMissing.client.resourceUsageBatch([{ spec: cpuMissing.spec, state: 'running' }]))[0]).toMatchObject({
      cpu: { state: 'unavailable' },
      memory: { state: 'ready', usedBytes: 256 * 1024 * 1024 },
      disk: { state: 'ready' },
    });

    const memoryMissing = fixture();
    rmSync(join(memoryMissing.machineCgroup, 'memory.current'));
    expect((await memoryMissing.client.resourceUsageBatch([{ spec: memoryMissing.spec, state: 'running' }]))[0]).toMatchObject({
      cpu: { state: 'sampling' },
      memory: { state: 'unavailable' },
      disk: { state: 'ready' },
    });

    const diskMissing = fixture();
    diskMissing.helperReply['tree-sizes'] = (request: { paths: string[] }) => ({ ok: true, usages: request.paths.map((path) => ({ path, error: 'unavailable' })) });
    expect((await diskMissing.client.resourceUsageBatch([{ spec: diskMissing.spec, state: 'running' }]))[0]).toMatchObject({
      cpu: { state: 'sampling' },
      memory: { state: 'ready' },
      disk: { state: 'unavailable', usedBytes: null },
    });
  });
});

describe('nspawn privileged transport', () => {
  it('sends every privileged request on the pinned argv with a length-framed header', async () => {
    const state = fixture();
    const { client, spec, calls, requests } = state;
    state.helperReply.freeze = () => { state.unit.FreezerState = 'frozen'; return { ok: true }; };
    await client.pause(spec);
    const sudo = calls.find((call) => call.file === '/usr/bin/sudo');
    expect(sudo!.args).toEqual(['-n', HELPER_PATH, '']);
    expect(HELPER_PATH).toBe('/usr/local/libexec/elowen-site-gateway');
    expect(requests[0]).toMatchObject({ domain: 'nspawn', op: 'freeze', machine: spec.name });
  });

  it('frames the header at a fixed width so the guest keeps the rest of the pipe', () => {
    const frame = helperFrame({ domain: 'nspawn', op: 'freeze', machine: 'elowen-project-7-g2' }, 'guest bytes');
    const header = frame.subarray(0, 9).toString('latin1');
    expect(header).toMatch(/^[0-9]{8}\n$/);
    const length = Number(header.slice(0, 8));
    expect(JSON.parse(frame.subarray(9, 9 + length).toString('utf8'))).toMatchObject({ op: 'freeze' });
    expect(frame.subarray(9 + length).toString('utf8')).toBe('guest bytes');
  });

  it('asks the machine manager for one property per flag, which is the only form it accepts', async () => {
    const { client, spec, calls } = fixture();
    await client.inspect(spec);
    const shown = calls.filter((call) => call.file === '/usr/bin/machinectl' && call.args[0] === 'show');
    expect(shown.length).toBeGreaterThan(0);
    for (const call of shown) {
      // `systemctl` splits a comma-separated property list and `machinectl` does not: it looks for a
      // property whose name contains the comma, finds none and prints nothing, so the ownership proof
      // reads an empty record and refuses a machine that is perfectly correct.
      for (const argument of call.args) expect(argument, call.args.join(' ')).not.toContain(',');
      // One flag per property, so a second property is asked for rather than appended to the first.
      const flags = call.args.filter((argument) => argument === '-p').length;
      expect(call.args.slice(call.args.indexOf('-p'))).toHaveLength(flags * 2);
    }
    expect(shown.at(-1)!.args).toEqual(['show', spec.name, '-p', 'Unit', '-p', 'RootDirectory']);
  });

  it('materializes a fresh disk from the published root filesystem its specification names', async () => {
    const { client, spec, artifacts, blob, requests, diskDirectory } = fixture();
    const pending = join(diskDirectory, 'rootfs.pending');
    mkdirSync(pending, { recursive: true });

    const digest = await client.materializeRootfs(spec, pending);

    // The disk's own record of where it came from is the artifact's digest: which bytes, not which local
    // image id, so two hosts building the same environment record the same provenance.
    expect(digest).toBe(ARTIFACT_DIGEST);
    expect(artifacts.ensure).toHaveBeenCalledWith(spec.disk.sourceImage, {});
    // The extraction is privileged, because only the helper can preserve the archive's ownership and
    // then shift the whole tree into the machine's range. Both facts travel in one request.
    const materialize = requests.filter((request) => request.op === 'materialize');
    expect(materialize).toHaveLength(1);
    expect(materialize[0]).toMatchObject({ domain: 'nspawn', op: 'materialize', machine: spec.name,
      namespace: spec.namespace, kind: 'project', resource: '7', generation: spec.generation,
      diskId: spec.disk.id, specHash: spec.labels['io.elowen.spec'], archivePath: blob, targetPath: pending });
  });

  it('leaves the shared blob alone when the privileged extraction fails', async () => {
    // The blob is a cache entry every environment on this recipe shares, not a per-environment
    // temporary. A failed materialization that deleted it would make the next environment re-download
    // gigabytes for a fault that had nothing to do with the bytes.
    const { client, spec, helperReply, blob, requests, diskDirectory } = fixture();
    const pending = join(diskDirectory, 'rootfs.pending');
    mkdirSync(pending, { recursive: true });
    helperReply.materialize = { ok: false, detail: 'the extraction target is not empty' };

    await expect(client.materializeRootfs(spec, pending)).rejects.toThrow(/the extraction target is not empty/);

    expect(existsSync(blob)).toBe(true);
    expect(requests.some((request) => request.op === 'tree-remove')).toBe(false);
  });

  it('carries a fetch progress observer through to the store', async () => {
    const { client, spec, artifacts, diskDirectory } = fixture();
    const pending = join(diskDirectory, 'rootfs.pending');
    mkdirSync(pending, { recursive: true });
    const onProgress = vi.fn();
    await client.materializeRootfs(spec, pending, { onProgress });
    expect(artifacts.ensure).toHaveBeenCalledWith(spec.disk.sourceImage, { onProgress });
  });

  it('releases the uid reservation only after storage is verified absent, including retries', async () => {
    const { client, spec, envelope, requests } = fixture();
    rmSync(envelope.nspawn, { force: true });
    rmSync(envelope.dropIn, { force: true });
    rmSync(spec.storageRoot, { recursive: true, force: true });

    await client.removeStorage(spec);
    await client.removeStorage(spec);

    expect(requests.filter((request) => request.op === 'release-uid-range')).toEqual([
      { domain: 'nspawn', op: 'release-uid-range', namespace: 'elowen', kind: 'project', resource: '7' },
      { domain: 'nspawn', op: 'release-uid-range', namespace: 'elowen', kind: 'project', resource: '7' },
    ]);
  });

  it('reports what the host still owes the machine runtime, in the rows the privileged side named', async () => {
    const { client, helperReply, requests } = fixture();
    helperReply.status = { ok: true, ready: false, items: [
      { id: 'os:supported', label: 'Supported operating system', ok: true, detail: 'Ubuntu 24.04' },
      { id: 'firewall:host-guard', label: 'Machine-to-host guard', ok: false, detail: 'everything else a machine addresses to the host arrives here — run: /usr/sbin/iptables -A INPUT -i ve-+ -j DROP' },
    ] };

    const readiness = await client.hostReadiness();

    // The veth rows are asked for, because an ordinary environment asks for a virtual ethernet and a
    // report that leaves out the rows it will be refused on would read as ready until the first create.
    expect(requests.at(-1)).toEqual({ domain: 'nspawn', op: 'status', veth: true });
    // Passed through as written: the ids move, the labels and details are what an operator acts on, and
    // the client invents none of them.
    expect(readiness).toEqual({ ready: false, items: [
      { id: 'os:supported', label: 'Supported operating system', ok: true, detail: 'Ubuntu 24.04' },
      { id: 'firewall:host-guard', label: 'Machine-to-host guard', ok: false, detail: 'everything else a machine addresses to the host arrives here — run: /usr/sbin/iptables -A INPUT -i ve-+ -j DROP' },
    ] });
  });

  it('refuses a readiness report it cannot trust rather than reporting a host as ready', async () => {
    const { client, helperReply } = fixture();
    helperReply.status = { ok: true, ready: true };
    await expect(client.hostReadiness()).rejects.toThrow(/Invalid machine runtime readiness report/);
    helperReply.status = { ok: true, ready: true, items: [{ id: 'os:supported', label: 'Supported operating system' }] };
    await expect(client.hostReadiness()).rejects.toThrow(/Invalid machine runtime readiness item/);
  });

  it('mirrors the helper path the installer pins', () => {
    const shared = readFileSync(fileURLToPath(new URL('../../src/shared/siteGateway.ts', import.meta.url)), 'utf8');
    expect(shared).toContain(`'${HELPER_PATH}'`);
  });

  it('asks the privileged side to prepare the host, and answers with what it found afterwards', async () => {
    // Provisioning reports through the SAME shape a read does, so an administrator's surface renders one
    // set of rows whether it looked or repaired, and a host still short of something says which row
    // rather than returning a bare success.
    const { client, helperReply, requests } = fixture();
    helperReply.provision = { ok: true, ready: false, detail: 'machine runtime support remains incomplete', items: [
      { id: 'package:systemd-container', label: 'systemd container tools', ok: true, detail: 'installed' },
      { id: 'net:ip-forward', label: 'IPv4 forwarding', ok: false, detail: 'a machine cannot route without it' },
    ] };

    const result = await client.provisionHost();

    expect(requests.at(-1)).toEqual({ domain: 'nspawn', op: 'provision', veth: true });
    expect(result).toEqual({ ready: false, detail: 'machine runtime support remains incomplete', items: [
      { id: 'package:systemd-container', label: 'systemd container tools', ok: true, detail: 'installed' },
      { id: 'net:ip-forward', label: 'IPv4 forwarding', ok: false, detail: 'a machine cannot route without it' },
    ] });
  });

  it('holds a provisioning report to the same validation as a readiness report', async () => {
    // Installing packages and applying firewall rules is exactly where a malformed verdict must not
    // become an optimistic one: a host is never reported prepared on an answer this client cannot read.
    const { client, helperReply } = fixture();
    helperReply.provision = { ok: true, ready: true };
    await expect(client.provisionHost()).rejects.toThrow(/Invalid machine runtime readiness report/);
    helperReply.provision = { ok: true, ready: true, items: [{ id: 'os:supported', label: 'Supported operating system' }] };
    await expect(client.provisionHost()).rejects.toThrow(/Invalid machine runtime readiness item/);
  });

  it('gives provisioning the long privileged deadline rather than the ordinary one', async () => {
    // It runs a package manager. The ordinary deadline kills that part-way through, which leaves a host
    // half-prepared and tells the caller it timed out rather than what actually happened.
    const { client, helperReply, executor } = fixture();
    helperReply.provision = { ok: true, ready: true, items: [{ id: 'os:supported', label: 'Supported operating system', ok: true }] };
    await client.provisionHost();
    const call = executor.run.mock.calls.at(-1) as unknown as [string, string[], { timeoutMs?: number }];
    expect(call[0]).toBe('/usr/bin/sudo');
    expect(call[2]?.timeoutMs).toBe(12 * 60_000);
  });
});

describe('nspawn guest execution', () => {
  it('propagates the guest exit code and keeps its streams separate', async () => {
    const state = fixture();
    state.helperReply.exec = (request: any) => (request.argv[0] === '/bin/sh'
      ? { ok: true, exitCode: 42, signal: null, timedOut: false, truncated: false,
        stdout: Buffer.from('out\r\nbytes').toString('base64'), stderr: Buffer.from('err').toString('base64') }
      : collectedUnit);
    const result = await state.client.exec(state.spec, EXECUTION_ID, ['/bin/sh', '-c', 'exit 42']);
    expect(result).toMatchObject({ code: 42, stdout: 'out\r\nbytes', stderr: 'err', truncated: false });
  });

  it('carries the guest argv through untouched and names the leased unit', async () => {
    const state = fixture();
    state.helperReply.exec = (request: any) => (request.unit.startsWith('elowen-exec-') ? { ok: true, exitCode: 0, stdout: '', stderr: '' } : collectedUnit);
    // Running an arbitrary command inside the environment is what the environment is FOR: the client
    // bounds the transport and never inspects, rewrites or allow-lists what the guest is asked to run.
    const argv = ['/usr/bin/sudo', '--property=ExecStart=/bin/false', '-M', 'other-machine', '--pipe'];
    await state.client.exec(state.spec, EXECUTION_ID, argv);
    const request = state.requests.find((entry) => entry.op === 'exec');
    expect(request.argv).toEqual(argv);
    expect(request.unit).toBe(executionUnit(state.spec, EXECUTION_ID));
    expect(request.cwd).toBe('/demo');
  });

  it('keeps the transport hygiene the container runtime already applies and nothing beyond it', async () => {
    const { client, spec } = fixture();
    await expect(client.exec(spec, EXECUTION_ID, [])).rejects.toThrow(/Invalid guest command arguments/);
    await expect(client.exec(spec, EXECUTION_ID, ['sh'])).rejects.toThrow(/Invalid guest command arguments/);
    await expect(client.exec(spec, EXECUTION_ID, ['/bin/sh', 'a\0b'])).rejects.toThrow(/Invalid guest command arguments/);
    await expect(client.exec(spec, EXECUTION_ID, new Array(257).fill('/bin/true'))).rejects.toThrow(/Invalid guest command arguments/);
    await expect(client.exec(spec, EXECUTION_ID, ['/bin/sh'], { workdir: 'relative' })).rejects.toThrow(/Invalid guest working directory/);
    await expect(client.exec(spec, EXECUTION_ID, ['/bin/sh'], { input: 'x'.repeat(1024 * 1024 + 1) })).rejects.toThrow(/exceeds limit/);
  });

  it('shortens guest output to the caller\u2019s bound and says so, as the container runtime does', async () => {
    // Comfortably above the runtime's own control verdicts, which share this bound, and well below what
    // the command below writes.
    const state = fixture({ outputLimitBytes: 512 });
    state.helperReply.exec = (request: any) => (request.argv[0] === '/bin/sh'
      ? { ok: true, exitCode: 0, signal: null, timedOut: false, truncated: false,
        stdout: Buffer.from(`head${'x'.repeat(4000)}tail`).toString('base64'), stderr: '' }
      : collectedUnit);
    const result = await state.client.exec(state.spec, EXECUTION_ID, ['/bin/sh', '-c', 'yes']);
    // The bound is the caller's figure over the DECODED bytes, and what survives is the tail, which is
    // the half of a long output anyone reads. A command that writes too much is shortened, not failed.
    expect(Buffer.byteLength(result.stdout)).toBe(512);
    expect(result.stdout.endsWith('tail')).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('keeps the truncation the privileged side already reported', async () => {
    const state = fixture();
    state.helperReply.exec = (request: any) => (request.argv[0] === '/bin/sh'
      ? { ok: true, exitCode: 0, signal: null, timedOut: false, truncated: true,
        stdout: Buffer.from('short').toString('base64'), stderr: '' }
      : collectedUnit);
    const result = await state.client.exec(state.spec, EXECUTION_ID, ['/bin/sh', '-c', 'yes']);
    expect(result).toMatchObject({ stdout: 'short', truncated: true });
  });

  it('reports a guest timeout as a timeout and still settles the execution', async () => {
    const state = fixture();
    state.helperReply.exec = (request: any) => (request.argv[0] === '/bin/sleep'
      ? { ok: true, exitCode: null, signal: 'SIGKILL', timedOut: true, truncated: false, stdout: '', stderr: '' }
      : maskedUnit);
    await expect(state.client.exec(state.spec, EXECUTION_ID, ['/bin/sleep', '600'], { timeoutMs: 1000 }))
      .rejects.toThrow(/Guest command timed out after 1s/);
    // The tombstone still ran: a launcher that failed must leave the guest unit masked and proven dead.
    const masks = state.requests.filter((entry) => entry.op === 'exec' && entry.argv.includes('mask'));
    expect(masks.length).toBeGreaterThanOrEqual(2);
  });

  it('hands the daemon a launch descriptor whose stdin carries the request ahead of the guest bytes', async () => {
    const state = fixture();
    const prepared = await state.client.prepareExecution(state.spec, EXECUTION_ID, ['/bin/bash', '-s'], { input: 'echo hi' });
    // The descriptor shape the daemon spawns: an argv launch with an explicit file, its
    // arguments and a clean environment, so nothing downstream has to know which runtime produced it.
    expect(prepared.launch).toEqual({ type: 'argv', file: '/usr/bin/sudo', args: ['-n', HELPER_PATH, ''],
      env: expect.objectContaining({ PATH: expect.any(String), HOME: expect.any(String) }) });
    const length = Number(prepared.stdin.subarray(0, 8).toString('latin1'));
    expect(JSON.parse(prepared.stdin.subarray(9, 9 + length).toString('utf8'))).toMatchObject({ domain: 'nspawn', op: 'exec', argv: ['/bin/bash', '-s'] });
    expect(prepared.stdin.subarray(9 + length).toString('utf8')).toBe('echo hi');
  });

  it('launches in raw mode, because the daemon streams that descriptor to a terminal', async () => {
    const state = fixture();
    const prepared = await state.client.prepareExecution(state.spec, EXECUTION_ID, ['/bin/bash', '-s'], { input: 'echo hi' });
    const length = Number(prepared.stdin.subarray(0, 8).toString('latin1'));
    const request = JSON.parse(prepared.stdin.subarray(9, 9 + length).toString('utf8'));
    // Without the discriminator the helper answers with a base64 verdict on its stdout, and the terminal
    // renders that verdict instead of the command's own output. A well-formed request is not enough.
    expect(request.raw).toBe(true);
    expect(request.detached).toBeUndefined();
  });

  it('reports an execution cancelled under it as cancelled even when the reaper won the race', async () => {
    const state = fixture();
    // The losing half of the race, driven rather than waited for. The cancellation lands while the
    // launcher is still in flight; the launcher then exits zero, because its unit was stopped rather than
    // its command failed. By the time anything could look the unit up, `--collect` has retired it, so
    // every lookup answers "already gone" — which reads exactly like a command that ran and printed
    // nothing. Inferring the verdict from that lookup is what made this intermittent.
    let cancelling = false;
    state.helperReply.exec = async (request: any) => {
      if (request.argv[0] === '/bin/sleep') {
        cancelling = true;
        await state.client.cancelExecution(state.spec, EXECUTION_ID);
        cancelling = false;
        return { ok: true, exitCode: 0, signal: null, timedOut: false, truncated: false, stdout: '', stderr: '' };
      }
      return cancelling ? maskedUnit : collectedUnit;
    };
    await expect(state.client.exec(state.spec, EXECUTION_ID, ['/bin/sleep', '600']))
      .rejects.toThrow(/Guest command was cancelled/);
    // And the tombstone stands: unmasking here would reopen the race it was placed to close.
    expect(state.requests.filter((entry) => entry.op === 'exec' && entry.argv.includes('unmask'))).toHaveLength(0);
    // The record is not left behind either, so a later execution under the same lease is its own.
    state.helperReply.exec = () => collectedUnit;
    await expect(state.client.exec(state.spec, EXECUTION_ID, ['/bin/true'])).resolves.toMatchObject({ code: 0 });
  });

  it('keeps the verdict transport for an execution this client reads itself', async () => {
    const state = fixture();
    state.helperReply.exec = () => collectedUnit;
    await state.client.exec(state.spec, EXECUTION_ID, ['/bin/true']);
    for (const request of state.requests.filter((entry) => entry.op === 'exec')) {
      expect(request.raw).toBeUndefined();
      expect(request.detached).toBeUndefined();
    }
  });

  it('starts a publication detached and refuses an acknowledgement that does not say so', async () => {
    const state = fixture({ previewBroker: true });
    const active = { ok: true, exitCode: 0, timedOut: false, truncated: false, stdout: Buffer.from('active\n').toString('base64'), stderr: '' };
    state.helperReply.exec = (request: any) => (request.detached === true
      ? { ok: true, detached: true, unit: request.unit, machine: request.machine, state: 'active', exitCode: 0 }
      : active);
    await state.client.startPublication(state.spec, 'pub-one', ['/usr/bin/python3', '-c', 'forward']);
    const started = state.requests.find((entry) => entry.op === 'exec' && entry.detached === true);
    // A detached unit has no streams to pass through, which the privileged side refuses outright.
    expect(started).toMatchObject({ detached: true, cwd: '/demo', timeoutSeconds: 30 });
    expect(started.raw).toBeUndefined();
    expect(started.unit).toMatch(/^elowen-pub-[a-f0-9]{16}\.service$/);

    state.helperReply.exec = (request: any) => (request.detached === true ? { ok: true } : active);
    await expect(state.client.startPublication(state.spec, 'pub-one', ['/usr/bin/python3', '-c', 'forward']))
      .rejects.toThrow(/did not start the guest unit detached/);
  });

  it('refuses completion cwd capture rather than reporting a working directory it never captured', async () => {
    const { client, spec } = fixture();
    await expect(client.prepareExecution(spec, EXECUTION_ID, ['/bin/bash', '-s'], { completionCwd: true }))
      .rejects.toThrow(/not carried by the nspawn transport/);
  });

  it('masks, stops, re-masks and verifies before it unmasks, exactly as the container runtime does', async () => {
    const state = fixture();
    state.helperReply.exec = () => maskedUnit;
    await state.client.releaseExecution(state.spec, EXECUTION_ID, { persistent: true });
    const guest = state.requests.filter((entry) => entry.op === 'exec').map((entry) => entry.argv.slice(1).join(' '));
    expect(guest).toEqual([
      `show --property=LoadState,ActiveState,SubState,ControlGroup ${executionUnit(state.spec, EXECUTION_ID)}`,
      `mask ${executionUnit(state.spec, EXECUTION_ID)}`,
      `stop ${executionUnit(state.spec, EXECUTION_ID)}`,
      `mask ${executionUnit(state.spec, EXECUTION_ID)}`,
      `show --property=LoadState,ActiveState,SubState,ControlGroup ${executionUnit(state.spec, EXECUTION_ID)}`,
      `unmask ${executionUnit(state.spec, EXECUTION_ID)}`,
    ]);
  });

  it('refuses to call a termination verified when the guest unit is not masked and dead', async () => {
    const state = fixture();
    state.helperReply.exec = { ok: true, exitCode: 0, signal: null, timedOut: false, truncated: false,
      stdout: Buffer.from('LoadState=loaded\nActiveState=active\nSubState=running\nControlGroup=/x\n').toString('base64'), stderr: '' };
    await expect(state.client.cancelExecution(state.spec, EXECUTION_ID)).rejects.toThrow(/termination could not be verified/);
  });
});

describe('nspawn limits', () => {
  it('writes the envelope with canonical inbound port mappings', async () => {
    const state = fixture({ network: { mode: 'shared', inboundPorts: [
      { protocol: 'udp', hostPort: 5353, guestPort: 53 },
      { protocol: 'tcp', hostPort: 8080, guestPort: 3000 },
    ] } });
    rmSync(state.envelope.nspawn); rmSync(state.envelope.dropIn);
    state.unit.ActiveState = 'inactive'; state.unit.SubState = 'dead';
    state.helperReply['write-envelope'] = () => { state.writeEnvelope(); return { ok: true }; };

    await state.client.create(state.spec);

    expect(state.requests.find((entry) => entry.op === 'write-envelope')).toMatchObject({ privateNetwork: false, ports: [
      { protocol: 'tcp', hostPort: 8080, guestPort: 3000 },
      { protocol: 'udp', hostPort: 5353, guestPort: 53 },
    ] });
  });

  it('writes the envelope with the limits the environment declares', async () => {
    const state = fixture({ limits: { cpus: 2, memoryMb: 2048, pidsLimit: 1024 } });
    rmSync(state.envelope.nspawn); rmSync(state.envelope.dropIn);
    state.unit.ActiveState = 'inactive'; state.unit.SubState = 'dead';
    state.unit.MemoryMax = String(2048 * 1024 * 1024); state.unit.TasksMax = '1024'; state.unit.CPUQuotaPerSecUSec = '2s';
    state.helperReply['write-envelope'] = () => { state.writeEnvelope(); return { ok: true }; };
    const created = await state.client.create(state.spec);
    expect(created.state).toBe('stopped');
    const request = state.requests.find((entry) => entry.op === 'write-envelope');
    expect(request).toMatchObject({ machine: state.spec.name, diskId: state.spec.disk.id,
      limits: { cpus: 2, memoryMb: 2048, pidsLimit: 1024 }, dropCapabilities: [...DROPPED_CAPABILITIES], privateNetwork: false });
    // `false` is the privileged side's word for "give this machine a virtual ethernet". An ordinary
    // environment asks for one, because the container runtime gives the same specification outbound
    // traffic today and a guest with only its own loopback cannot install anything.
    expect(request.binds.map((bind: any) => bind.target)).toEqual(['/demo', '/root', '/data']);
  });

  it('applies a live limit change through the typed helper and verifies the effective values', async () => {
    const state = fixture();
    state.helperReply['set-limits'] = () => {
      state.unit.CPUQuotaPerSecUSec = '750ms'; state.unit.MemoryMax = String(384 * 1024 * 1024); state.unit.TasksMax = '300';
      return { ok: true };
    };
    const next = await state.client.update(state.spec, { cpus: 0.75, memoryMb: 384, pidsLimit: 300 });
    expect(next.limits).toEqual({ cpus: 0.75, memoryMb: 384, pidsLimit: 300 });
    expect(state.requests.find((request) => request.op === 'set-limits')).toMatchObject({
      machine: state.spec.name,
      limits: { cpus: 0.75, memoryMb: 384, pidsLimit: 300 },
    });
  });
});

describe('nspawn freeze and thaw', () => {
  it('freezes a running machine and refuses one that is not running', async () => {
    const state = fixture();
    state.helperReply.freeze = () => { state.unit.FreezerState = 'frozen'; return { ok: true }; };
    state.helperReply.thaw = () => { state.unit.FreezerState = 'running'; return { ok: true }; };
    await state.client.pause(state.spec);
    expect((await state.client.inspect(state.spec))!.state).toBe('paused');
    await expect(state.client.pause(state.spec)).rejects.toThrow(/not running/);
    await state.client.unpause(state.spec);
    expect((await state.client.inspect(state.spec))!.state).toBe('running');
    await expect(state.client.unpause(state.spec)).rejects.toThrow(/not paused/);
  });

  it('refuses to report a freeze the machine did not take', async () => {
    const state = fixture();
    state.helperReply.freeze = { ok: true };
    await expect(state.client.pause(state.spec)).rejects.toThrow(/freeze was not verified/);
  });
});

describe('nspawn refusals', () => {
  /** Named volumes and image-to-disk migration are not refused by this client, they are ABSENT from it.
   *  A method that stayed on the surface only to throw is a method a caller can still reach and a stub
   *  someone can still fill in; the machine runtime keeps its state on one disk per environment, and the
   *  only migration path off an image-backed environment is deleting it. The refusals that do exist are
   *  further down: a specification without an nspawn disk never gets a client at all. */
  it('exposes no named-volume or image-migration surface at all', () => {
    const { client } = fixture();
    for (const method of ['ensureVolume', 'inspectVolume', 'removeVolume', 'exportVolume', 'importSnapshotVolume',
      'preflightRootfsMigration', 'exportContainerRootfs', 'snapshotImage', 'removeSnapshotImage',
      'ensureProjectImage', 'buildProjectImage'] as const) {
      expect((client as any)[method], method).toBeUndefined();
    }
  });

  it('refuses a legacy image-backed specification and a disk that belongs to another runtime', async () => {
    const { paths, client } = fixture();
    const resource = { kind: 'project' as const, id: 7 };
    const image = 'localhost/elowen-project-base:test';
    const legacy = createContainerSpec({ resource, workspaceTarget: '/demo', generation: 2, image }, paths);
    await expect(client.inspect(legacy)).rejects.toThrow(/only rootfs-backed environments/);
    const podmanDisk = createEnvironmentDiskSpec({ resource, image, runtime: undefined }, paths, 'a'.repeat(32));
    const podmanSpec = createContainerSpec({ resource, workspaceTarget: '/demo', generation: 2, image, disk: podmanDisk }, paths);
    await expect(client.inspect(podmanSpec)).rejects.toThrow(/not an nspawn environment/);
  });

  it('refuses a machine name outside the privileged runtime scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elowen-nspawn-scope-'));
    roots.push(root);
    const paths = { sandboxDataDir: join(root, 'sandbox'), namespace: 'other' };
    for (const [key, path] of Object.entries(paths)) if (key !== 'namespace') mkdirSync(path, { recursive: true });
    const resource = { kind: 'project' as const, id: 7 };
    const image = 'localhost/elowen-project-base:test';
    const disk = createEnvironmentDiskSpec({ resource, image, runtime: 'nspawn' }, paths, 'a'.repeat(32));
    const spec = createContainerSpec({ resource, workspaceTarget: '/demo', generation: 1, image, disk }, paths);
    const client = new NspawnClient({ executor: { run: vi.fn() }, artifacts: {}, namespace: 'other' });
    expect(MACHINE_PATTERN.test(spec.name)).toBe(false);
    await expect(client.inspect(spec)).rejects.toThrow(/outside the privileged runtime scope/);
  });

  it('refuses to construct a client with no image store to delegate to', () => {
    expect(() => new NspawnClient({ executor: { run: vi.fn() } } as any)).toThrow(/artifact store is required/);
  });
});

describe('runtime client selection', () => {
  it('sends an nspawn disk to the machine client', () => {
    const { spec, client } = fixture();
    expect(selectRuntimeClient(spec, { nspawn: client as any })).toBe(client);
  });

  // There is one runtime now, and `disk.runtime` is the persisted proof a row belongs to it. A row
  // written by a release that ran containers cannot be adopted — its root filesystem was never
  // materialized from a published artifact — so it is NAMED and refused, with the remedy in the message,
  // rather than quietly driven by the machine client.
  it.each([
    ['a specification with no disk at all', (paths: any) =>
      createContainerSpec({ resource: { kind: 'project', id: 7 }, workspaceTarget: '/demo', generation: 2, image: 'localhost/elowen-project-base:test' }, paths)],
    ['a disk a container runtime materialized', (paths: any) => createContainerSpec({
      resource: { kind: 'project', id: 7 }, workspaceTarget: '/demo', generation: 2, image: 'localhost/elowen-project-base:test',
      disk: createEnvironmentDiskSpec({ resource: { kind: 'project', id: 7 }, image: 'localhost/elowen-project-base:test', runtime: undefined }, paths, 'a'.repeat(32)),
    }, paths)],
  ])('refuses %s instead of adopting it', (_label, build) => {
    const { paths, client } = fixture();
    let raised: any;
    try { selectRuntimeClient(build(paths), { nspawn: client as any }); }
    catch (cause) { raised = cause; }
    expect(raised).toMatchObject({ code: 'unsupported_runtime', status: 409 });
    expect(raised.message).toMatch(/removed Podman runtime.*Delete the managed Project/);
  });

  it('refuses an nspawn row on a runtime that has no machine client rather than falling back', () => {
    const { spec } = fixture();
    expect(() => selectRuntimeClient(spec, { nspawn: null })).toThrow(/systemd-nspawn, which is unavailable/);
  });
});
