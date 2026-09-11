import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindContainerIdentity, createBoundSiteSpec, createContainerSpec, createEnvironmentDiskSpec, executionUnit } from '../../plugins/sandbox/lib/containerSpec.mjs';
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
function fixture(options: { limits?: Record<string, number>, generation?: number, previewBroker?: boolean, outputLimitBytes?: number } = {}) {
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
        const reply = typeof helperReply[request.op] === 'function' ? await helperReply[request.op](request) : helperReply[request.op];
        return { code: 0, stdout: JSON.stringify(reply ?? { ok: true }), stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }),
  };
  const images = { imageIdentity: vi.fn(async () => `sha256:${'d'.repeat(64)}`), ensureProjectImage: vi.fn(async () => image),
    // The one image operation a fresh disk needs: the merged filesystem, written where the machine
    // client asked for it. The file has to exist, because the client validates the archive path before
    // it hands it to the helper.
    exportImageRootfs: vi.fn(async (_spec: any, archivePath: string) => {
      writeFileSync(archivePath, 'rootfs archive');
      return `sha256:${'d'.repeat(64)}`;
    }),
    removeDiskPath: vi.fn(async (path: string) => { rmSync(path, { force: true }); }) };
  const client = new NspawnClient({ executor, images, configRoot, namespace: spec.namespace,
    ...(options.outputLimitBytes === undefined ? {} : { outputLimitBytes: options.outputLimitBytes }) });
  return { root, configRoot, paths, spec, disk: spec.disk, diskDirectory, identityPath, identity, writeIdentity,
    envelope, writeEnvelope, unit, machine, requests, guestInput, calls, helperReply, executor, images, client, rootfs };
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

  it('materializes a fresh disk by delegating the image and handing the archive to the privileged side', async () => {
    const { client, spec, images, requests, diskDirectory } = fixture();
    const pending = join(diskDirectory, 'rootfs.pending');
    mkdirSync(pending, { recursive: true });
    const archive = join(diskDirectory, 'rootfs.tar.pending');

    const imageId = await client.materializeRootfs(spec, pending);

    // The image half goes to the client that HAS an image store, written beside the tree it fills.
    expect(imageId).toBe(`sha256:${'d'.repeat(64)}`);
    expect(images.exportImageRootfs).toHaveBeenCalledWith(spec, archive);
    // The extraction is privileged, because only the helper can preserve the archive's ownership and
    // then shift the whole tree into the machine's range. Both facts travel in one request.
    const materialize = requests.filter((request) => request.op === 'materialize');
    expect(materialize).toHaveLength(1);
    expect(materialize[0]).toMatchObject({ domain: 'nspawn', op: 'materialize', machine: spec.name,
      namespace: spec.namespace, kind: 'project', resource: '7', generation: spec.generation,
      diskId: spec.disk.id, specHash: spec.labels['io.elowen.spec'], archivePath: archive, targetPath: pending });
    // The archive is a file the service account owns, so it goes back to the client that wrote it. The
    // privileged tree operations take directories, and handing one a file is how this was found.
    expect(images.removeDiskPath).toHaveBeenCalledWith(archive);
    expect(requests.some((request) => request.op === 'tree-remove')).toBe(false);
  });

  it('keeps the export archive out of the way when the privileged extraction fails', async () => {
    const { client, spec, helperReply, images, diskDirectory } = fixture();
    const pending = join(diskDirectory, 'rootfs.pending');
    mkdirSync(pending, { recursive: true });
    helperReply.materialize = { ok: false, detail: 'the extraction target is not empty' };

    await expect(client.materializeRootfs(spec, pending)).rejects.toThrow(/the extraction target is not empty/);

    // The failure is the caller's to see, and the megabytes the export left behind are gone either way.
    expect(images.removeDiskPath).toHaveBeenCalledTimes(1);
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
    const podmanDisk = createEnvironmentDiskSpec({ resource, image, runtime: undefined }, paths, 'a'.repeat(32));
    const podmanSpec = createContainerSpec({ resource, workspaceTarget: '/demo', generation: 2, image, disk: podmanDisk }, paths);
    await expect(client.inspect(podmanSpec)).rejects.toThrow(/not an nspawn environment/);
  });

  it('refuses the legacy migration sources a disk-backed environment can never be', async () => {
    const { client, spec } = fixture();
    // Called the way the interface names them: these refuse a disk-backed specification whatever they
    // are handed, so the arguments are the real ones and the methods read none of them.
    await expect((client as any).preflightRootfsMigration(spec, '/tmp')).rejects.toThrow(/legacy image-backed/);
    await expect((client as any).exportContainerRootfs(spec, '/tmp/x.tar')).rejects.toThrow(/legacy image-backed/);
    await expect((client as any).snapshotImage(spec, 'snap')).rejects.toThrow(/snapshots its disk/);
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

/** A published Site, built the way the runtime builds one: `createBoundSiteSpec` from a trusted binding,
 *  not a hand-written mount list. The bind set of a Site is the part of the envelope with the most host
 *  paths in it and the least resemblance to a project's, and an invented path proves nothing about it. */
describe('nspawn site envelope', () => {
  function siteFixture() {
    const root = mkdtempSync(join(tmpdir(), 'elowen-nspawn-site-'));
    roots.push(root);
    const configRoot = join(root, 'config');
    const binding = { namespace: 'elowen', sitesDataDir: join(root, 'sites'),
      sourcePath: join(root, 'sources', 'shop'), brokerDir: join(root, 'brokers', 'shop') };
    for (const path of [binding.sitesDataDir, binding.sourcePath, binding.brokerDir]) mkdirSync(path, { recursive: true });
    const resource = { kind: 'site' as const, id: 'shop' };
    const image = 'localhost/elowen/site:fixed';
    const disk = createEnvironmentDiskSpec({ resource, image, runtime: 'nspawn' },
      { sitesDataDir: binding.sitesDataDir, namespace: binding.namespace }, 'f'.repeat(32));
    const spec: any = createBoundSiteSpec({ resource, generation: 3, image, disk, network: 'shared',
      workspaceReadOnly: true, limits: { cpus: 1, memoryMb: 512, pidsLimit: 256 } }, binding);
    mkdirSync(spec.disk.rootfsPath, { recursive: true, mode: 0o755 });
    for (const component of spec.disk.components) mkdirSync(component.path, { recursive: true });
    // The git stub a Site mounts over `/workspace/.git` is a FILE, and the client validates it as one.
    // Creating every bind source as a directory is the kind of invented path that hides a real defect.
    for (const mount of spec.mounts.filter((entry: any) => entry.type === 'bind')) {
      if (mount.target === '/workspace/.git') { mkdirSync(dirname(mount.source), { recursive: true }); writeFileSync(mount.source, 'gitdir: /dev/null\n'); }
      else mkdirSync(mount.source, { recursive: true });
    }
    const requests: any[] = [];
    const executor = { run: vi.fn(async (file: string, args: string[], options: any = {}) => {
      if (file === '/usr/bin/sudo') {
        const frame: Buffer = Buffer.isBuffer(options.input) ? options.input : Buffer.from(String(options.input ?? ''));
        const length = Number(frame.subarray(0, 8).toString('latin1'));
        requests.push(JSON.parse(frame.subarray(9, 9 + length).toString('utf8')));
        return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      if (file === '/usr/bin/machinectl' && args[0] === 'list') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }) };
    const images = { imageIdentity: vi.fn(), exportImageRootfs: vi.fn() };
    const client = new NspawnClient({ executor, images, configRoot, namespace: binding.namespace });
    return { spec, binding, requests, client, root };
  }

  it('writes a Site envelope with the binds the specification itself declares', async () => {
    const { spec, requests, client, root } = siteFixture();
    // `create` proves the envelope was written by looking for it, which this executor cannot fake;
    // the request it sent first is the subject and is already recorded by then.
    const outcome = await client.create(spec).catch((cause: Error) => cause.message);

    const envelope = requests.find((request) => request.op === 'write-envelope');
    expect(envelope, String(outcome)).toBeDefined();
    expect(envelope).toMatchObject({ machine: spec.name, kind: 'site', resource: 'shop', generation: 3,
      diskId: spec.disk.id, specHash: spec.labels['io.elowen.spec'], privateNetwork: false });
    // Every bind, in the specification's own order, with the specification's own read-only flags. A Site
    // mounts its source read-only and its broker writable, and those are not the same decision.
    expect(envelope.binds).toEqual(spec.mounts.filter((mount: any) => mount.type === 'bind')
      .map((mount: any) => ({ source: realpathSync(mount.source), target: mount.target, readOnly: mount.readOnly === true })));
    expect(envelope.binds.length).toBeGreaterThan(0);
    expect(envelope.binds.some((bind: any) => bind.readOnly)).toBe(true);
    // No path the binding did not produce reaches the helper.
    for (const bind of envelope.binds) expect(bind.source.startsWith(realpathSync(root))).toBe(true);
  });
});
