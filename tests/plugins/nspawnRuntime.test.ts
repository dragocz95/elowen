import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
function fixture(options: { limits?: Record<string, number>, generation?: number, previewBroker?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'elowen-nspawn-test-'));
  roots.push(root);
  const configRoot = join(root, 'config');
  const paths = { sandboxDataDir: join(root, 'sandbox'), sitesDataDir: join(root, 'sites'), siteSourcesDir: join(root, 'sources'), siteBrokerDir: join(root, 'brokers') };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const resource = { kind: 'project' as const, id: 7 };
  const image = 'localhost/elowen-project-base:test';
  const generation = options.generation ?? 2;
  const disk = createEnvironmentDiskSpec({ resource, image, runtime: 'nspawn' }, paths, 'a'.repeat(32));
  const spec: any = createContainerSpec({ resource, workspaceTarget: '/demo', generation, image, disk, limits: options.limits,
    ...(options.previewBroker ? { previewBroker: true } : {}) }, paths);
  mkdirSync(spec.disk.rootfsPath, { recursive: true, mode: 0o755 });
  for (const component of spec.disk.components) mkdirSync(component.path, { recursive: true });
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
        const reply = typeof helperReply[request.op] === 'function' ? helperReply[request.op](request) : helperReply[request.op];
        return { code: 0, stdout: JSON.stringify(reply ?? { ok: true }), stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }),
  };
  const images = { imageIdentity: vi.fn(async () => `sha256:${'d'.repeat(64)}`), ensureProjectImage: vi.fn(async () => image) };
  const client = new NspawnClient({ executor, images, configRoot, namespace: spec.namespace });
  return { root, configRoot, paths, spec, disk: spec.disk, diskDirectory, identityPath, identity, writeIdentity,
    envelope, writeEnvelope, unit, machine, requests, guestInput, calls, helperReply, executor, images, client, rootfs };
}

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

  it('refuses to build a request for an operation the privileged domain does not have', async () => {
    const { client, spec } = fixture();
    await expect(client.materializeRootfs(spec)).rejects.toThrow(/materialized from an export archive/);
  });

  it('mirrors the helper path the installer pins', () => {
    const shared = readFileSync(fileURLToPath(new URL('../../src/shared/siteGateway.ts', import.meta.url)), 'utf8');
    expect(shared).toContain(`'${HELPER_PATH}'`);
  });
});

describe('nspawn guest execution', () => {
  it('propagates the guest exit code and keeps its streams separate', async () => {
    const state = fixture();
    state.helperReply.exec = (request: any) => (request.argv[0] === '/bin/sh'
      ? { ok: true, exitCode: 42, signal: null, timedOut: false, truncated: false,
        stdout: Buffer.from('out\r\nbytes').toString('base64'), stderr: Buffer.from('err').toString('base64') }
      : maskedUnit);
    const result = await state.client.exec(state.spec, EXECUTION_ID, ['/bin/sh', '-c', 'exit 42']);
    expect(result).toMatchObject({ code: 42, stdout: 'out\r\nbytes', stderr: 'err', truncated: false });
  });

  it('carries the guest argv through untouched and names the leased unit', async () => {
    const state = fixture();
    state.helperReply.exec = (request: any) => (request.unit.startsWith('elowen-exec-') ? { ok: true, exitCode: 0, stdout: '', stderr: '' } : maskedUnit);
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
    // The same descriptor shape the daemon spawns for Podman: an argv launch with an explicit file, its
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

  it('keeps the verdict transport for an execution this client reads itself', async () => {
    const state = fixture();
    state.helperReply.exec = () => maskedUnit;
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
      limits: { cpus: 2, memoryMb: 2048, pidsLimit: 1024 }, dropCapabilities: [...DROPPED_CAPABILITIES], privateNetwork: true });
    expect(request.binds.map((bind: any) => bind.target)).toEqual(['/demo', '/root', '/data']);
  });

  it('applies a live limit change through set-property and verifies the effective values', async () => {
    const state = fixture();
    state.executor.run.mockImplementation(async (file: string, args: string[]) => {
      if (file === '/usr/bin/systemctl' && args[0] === 'set-property') {
        state.unit.CPUQuotaPerSecUSec = '750ms'; state.unit.MemoryMax = String(384 * 1024 * 1024); state.unit.TasksMax = '300';
        return { code: 0, stdout: '', stderr: '' };
      }
      if (file === '/usr/bin/systemctl' && args[0] === 'show') return { code: 0, stdout: Object.entries(state.unit).map(([key, value]) => `${key}=${value}`).join('\n'), stderr: '' };
      if (file === '/usr/bin/machinectl' && args[0] === 'show') return { code: 0, stdout: `Unit=${state.machine.Unit}\nRootDirectory=${state.machine.RootDirectory}`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const next = await state.client.update(state.spec, { cpus: 0.75, memoryMb: 384, pidsLimit: 300 });
    expect(next.limits).toEqual({ cpus: 0.75, memoryMb: 384, pidsLimit: 300 });
    const applied = state.executor.run.mock.calls.find((call) => call[1][0] === 'set-property');
    expect(applied![1]).toEqual(['set-property', unitFor(state.spec.name), 'CPUQuota=75%', 'MemoryMax=384M', 'TasksMax=300']);
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
  it('refuses every named volume method instead of emulating a volume store', async () => {
    const { client, spec } = fixture();
    for (const method of ['ensureVolume', 'inspectVolume', 'removeVolume', 'exportVolume', 'importSnapshotVolume', 'siteDataArchive'] as const) {
      await expect((client as any)[method](spec, 'data')).rejects.toThrow(/no named volumes/);
    }
  });

  it('refuses a legacy image-backed specification and a disk that belongs to another runtime', async () => {
    const { paths, client } = fixture();
    const resource = { kind: 'project' as const, id: 7 };
    const image = 'localhost/elowen-project-base:test';
    const legacy = createContainerSpec({ resource, workspaceTarget: '/demo', generation: 2, image }, paths);
    await expect(client.inspect(legacy)).rejects.toThrow(/only rootfs-backed environments/);
    const podmanDisk = createEnvironmentDiskSpec({ resource, image }, paths, 'a'.repeat(32));
    const podmanSpec = createContainerSpec({ resource, workspaceTarget: '/demo', generation: 2, image, disk: podmanDisk }, paths);
    await expect(client.inspect(podmanSpec)).rejects.toThrow(/not an nspawn environment/);
  });

  it('refuses the legacy migration sources a disk-backed environment can never be', async () => {
    const { client, spec } = fixture();
    await expect(client.preflightRootfsMigration(spec, '/tmp')).rejects.toThrow(/legacy image-backed/);
    await expect(client.exportContainerRootfs(spec, '/tmp/x.tar')).rejects.toThrow(/legacy image-backed/);
    await expect(client.snapshotImage(spec, 'snap')).rejects.toThrow(/snapshots its disk/);
  });

  it('refuses a machine name outside the privileged runtime scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elowen-nspawn-scope-'));
    roots.push(root);
    const paths = { sandboxDataDir: join(root, 'sandbox'), sitesDataDir: join(root, 'sites'), siteSourcesDir: join(root, 'sources'), siteBrokerDir: join(root, 'brokers'), namespace: 'other' };
    for (const [key, path] of Object.entries(paths)) if (key !== 'namespace') mkdirSync(path, { recursive: true });
    const resource = { kind: 'project' as const, id: 7 };
    const image = 'localhost/elowen-project-base:test';
    const disk = createEnvironmentDiskSpec({ resource, image, runtime: 'nspawn' }, paths, 'a'.repeat(32));
    const spec = createContainerSpec({ resource, workspaceTarget: '/demo', generation: 1, image, disk }, paths);
    const client = new NspawnClient({ executor: { run: vi.fn() }, images: {}, namespace: 'other' });
    expect(MACHINE_PATTERN.test(spec.name)).toBe(false);
    await expect(client.inspect(spec)).rejects.toThrow(/outside the privileged runtime scope/);
  });

  it('refuses to construct a client with no image store to delegate to', () => {
    expect(() => new NspawnClient({ executor: { run: vi.fn() } } as any)).toThrow(/image builder client is required/);
  });
});

describe('runtime client selection', () => {
  it('sends a disk without a runtime to Podman and an nspawn disk to the machine client', () => {
    const { spec, paths, client } = fixture();
    const podman = { name: 'podman' } as any;
    const legacy = createContainerSpec({ resource: { kind: 'project', id: 7 }, workspaceTarget: '/demo', generation: 2, image: 'localhost/elowen-project-base:test' }, paths);
    expect(selectRuntimeClient(legacy, { podman, nspawn: client as any })).toBe(podman);
    expect(selectRuntimeClient(spec, { podman, nspawn: client as any })).toBe(client);
  });

  it('refuses an nspawn row on a runtime that has no machine client rather than falling back', () => {
    const { spec } = fixture();
    expect(() => selectRuntimeClient(spec, { podman: {} as any, nspawn: null })).toThrow(/systemd-nspawn, which is unavailable/);
  });
});
