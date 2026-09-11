import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertContainerSpec, executionUnit, hostPath, publicationUnit, resourceToken, withContainerLimits } from './containerSpec.mjs';
import { checkedHostPath } from './containerPaths.mjs';
import { cleanPodmanEnv, GUEST_SYSTEM_BUS, OUTPUT_LIMIT, positive, SpawnExecutor, unitProperties, validateInput } from './podman.mjs';

/** The one privileged executable, shared with the published-sites gateway: two typed domains behind one
 *  root-owned binary and one pinned sudoers line, because two executables reachable by the same service
 *  account are not a privilege boundary. Every root-only operation arrives on its stdin as a bounded JSON
 *  request. This mirrors `NSPAWN_HELPER_PATH` in `src/shared/nspawnRuntime.ts`, which a bundled plugin
 *  cannot import at runtime; `tests/contract/nspawnHelper.test.ts` holds this constant, the argv below,
 *  the daemon-side control and the sudoers line against each other. */
export const HELPER_PATH = '/usr/local/libexec/elowen-site-gateway';
const SUDO = '/usr/bin/sudo';
const SYSTEMCTL = '/usr/bin/systemctl';
const MACHINECTL = '/usr/bin/machinectl';
/** Our own unit template, not the shipped `systemd-nspawn@.service`: that one hardcodes
 *  `/var/lib/machines/%i`, which the environment disk layout does not use. */
export const UNIT_TEMPLATE_PATH = '/etc/systemd/system/elowen-machine@.service';
export const NSPAWN_CONFIG_DIR = '/etc/systemd/nspawn';
export const UNIT_DROPIN_NAME = '10-elowen.conf';
/** Live `systemctl set-property` writes systemd's OWN record of the applied limits here. It appears in
 *  `DropInPaths` and is deliberately not part of the envelope the ownership proof compares. */
const CONTROL_DROPIN_PREFIX = '/etc/systemd/system.control/';
export const MACHINE_PATTERN = /^elowen-(project|site)-[a-z0-9-]{1,64}-g[0-9]{1,9}$/;
/** Where the disk records which environment, generation and uid range it belongs to. Outside the rootfs
 *  on purpose: a marker inside the tree proves nothing, because the guest is root over that tree. */
const IDENTITY_RELATIVE = join('.elowen', 'identity.json');
/** Capabilities dropped from nspawn's default bound. Every one of them is also denied by rootless
 *  Podman's default set; what remains is what systemd needs to boot a container, and those are
 *  namespaced. */
export const DROPPED_CAPABILITIES = Object.freeze(['CAP_AUDIT_CONTROL', 'CAP_AUDIT_READ', 'CAP_SYS_PTRACE',
  'CAP_SYS_TTY_CONFIG', 'CAP_LEASE', 'CAP_LINUX_IMMUTABLE', 'CAP_IPC_LOCK', 'CAP_IPC_OWNER', 'CAP_BLOCK_SUSPEND',
  'CAP_WAKE_ALARM', 'CAP_SYSLOG', 'CAP_MAC_ADMIN', 'CAP_MAC_OVERRIDE', 'CAP_SYS_MODULE', 'CAP_SYS_RAWIO',
  'CAP_SYS_TIME', 'CAP_SYS_PACCT']);
/** The measured guest state this capability list produces, and the seccomp allowlist nspawn applies by
 *  default. The real proof test asserts these against a live machine. */
export const EXPECTED_CAPABILITY_BOUND = 0xa9e43dffn;
export const EXPECTED_SECCOMP_MODE = 2;
export const EXPECTED_SECCOMP_FILTERS = 5;
/** The uid range every machine is shifted into. Fixed per environment and allocated once by the helper:
 *  a range picked per boot costs a second full ownership pass over the whole tree. */
export const UID_RANGE_SIZE = 65536;
const REQUEST_LIMIT = 256 * 1024;
const GUEST_COMMAND_TIMEOUT_MS = 30_000;
const HELPER_OPERATIONS = new Set(['materialize', 'write-envelope', 'shift-ownership', 'exec', 'freeze', 'thaw',
  'tree-copy', 'tree-fingerprint', 'tree-preflight', 'tree-remove', 'tree-sync', 'tree-verify', 'destroy']);

/** Every privileged request is built here and nowhere else, so the daemon side of the contract has one
 *  shape to read and one place to change. `domain` is what separates the nspawn dispatch table from the
 *  Sites one inside the shared helper. */
export function helperRequest(operation, fields) {
  if (!HELPER_OPERATIONS.has(operation)) throw new Error('Unknown privileged runtime operation');
  const request = { domain: 'nspawn', op: operation, ...fields };
  for (const [key, value] of Object.entries(request)) {
    if (value === undefined) throw new Error(`Missing privileged request field: ${key}`);
  }
  return request;
}

/** The request as it reaches fd 0: a fixed nine-byte header of eight zero-padded decimal digits and a
 *  newline, exactly that many bytes of JSON, and then nothing of ours. A guest execution carries up to a
 *  megabyte of its OWN stdin straight after the header, so the helper reads the frame with exact byte
 *  counts and leaves the remainder of the pipe for the child; a buffered reader would swallow the guest's
 *  first bytes. Mirrors `encodeHelperRequest` in `src/shared/siteGateway.ts`. */
export function helperFrame(request, input) {
  const body = Buffer.from(JSON.stringify(request), 'utf8');
  if (body.length > REQUEST_LIMIT) throw new Error('Privileged request exceeds its bound');
  validateInput(input);
  const payload = input === undefined ? Buffer.alloc(0) : Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return Buffer.concat([Buffer.from(`${String(body.length).padStart(8, '0')}\n`, 'latin1'), body, payload]);
}

export const unitFor = (machine) => `elowen-machine@${machine}.service`;
/** Where the envelope's two files live. `configRoot` is the same kind of seam as the injected executor
 *  beside it: trusted module code and the test harness choose it, and nothing reachable from a plugin
 *  control does. The daemon only ever READS these paths; the helper is what writes them. */
export function envelopePaths(machine, configRoot = '') {
  return { nspawn: join(configRoot, NSPAWN_CONFIG_DIR, `${machine}.nspawn`),
    dropIn: join(configRoot, '/etc/systemd/system', `${unitFor(machine)}.d`, UNIT_DROPIN_NAME) };
}

/** `systemctl show` renders every USec property through systemd's own timespan formatter, so
 *  `CPUQuota=75%` reads back as `750ms` and `CPUQuota=100%` as `1s`. There is no raw form to ask for.
 *  This parses that formatter's output back into microseconds. */
export function timespanMicroseconds(value) {
  const text = String(value).trim();
  if (text === 'infinity') return Infinity;
  const units = { us: 1, ms: 1000, s: 1_000_000, min: 60_000_000, h: 3_600_000_000, d: 86_400_000_000 };
  let total = 0;
  let matched = false;
  for (const part of text.split(/\s+/).filter(Boolean)) {
    const token = /^([0-9]+)(us|ms|min|s|h|d)$/.exec(part);
    if (!token) return null;
    total += Number(token[1]) * units[token[2]];
    matched = true;
  }
  return matched ? total : null;
}

/** `ActiveState`, `SubState` and `FreezerState` onto the runtime-neutral vocabulary of `inspect`.
 *  `activating` reads as running on purpose: it is an envelope whose boot is under way, and the one
 *  question every caller asks of a non-stopped state is whether it still has to be stopped first. */
export function machineState(properties) {
  const active = properties.ActiveState;
  if (active === 'active' && ['frozen', 'freezing', 'thawing'].includes(properties.FreezerState)) return 'paused';
  if (['active', 'activating', 'reloading'].includes(active)) return 'running';
  if (active === 'deactivating') return 'stopping';
  if (['inactive', 'failed'].includes(active)) return 'stopped';
  throw new Error('Invalid machine state');
}

function absent(path) {
  try { lstatSync(path); return false; }
  catch (cause) { if (cause.code === 'ENOENT') return true; throw cause; }
}

/** The envelope's own configuration files, read as bytes. The identity below hashes exactly what is on
 *  disk rather than what this process would have written, so the two sides of the contract do not have to
 *  agree on whitespace for an environment to stay ownable. Both live under root-owned system
 *  configuration directories the service account cannot write, which is what makes them evidence. */
function readEnvelope(paths) {
  const read = (path) => {
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0) throw new Error('Untrusted machine envelope file');
    return readFileSync(path, 'utf8');
  };
  return { nspawn: read(paths.nspawn), dropIn: read(paths.dropIn) };
}

/** The disk's own record of which environment it belongs to. The helper writes it as root at 0640 with
 *  the service group, which is what lets this run as a plain read: `inspect` is on the execution path, and
 *  a privileged round trip there would cost more than the entire state poll it belongs to.
 *
 *  It sits in the disk directory, outside the root filesystem, where the guest has no path to it at all —
 *  a marker inside the tree would prove nothing, because the guest is root over that tree. What it
 *  establishes is that this directory belongs to this environment, generation and uid range, and every
 *  field in it is held against the specification below. */
function readIdentity(diskDirectory) {
  const path = join(diskDirectory, IDENTITY_RELATIVE);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) throw new Error('Untrusted environment disk identity');
  if (stat.size > 8192) throw new Error('Environment disk identity exceeds its bound');
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Concrete internal driver for systemd-nspawn machines, behind the same interface as `PodmanClient`.
 *
 *  Two transports and no third. The machine LIFECYCLE runs as the service account over a unit-scoped
 *  polkit rule with no sudo at all: start, stop, set-property, show, list. Everything that needs root —
 *  guest execution, freeze and thaw, and every operation on a tree owned by the machine's uid range —
 *  goes through the single privileged helper, which re-derives its own paths and command lines.
 *
 *  The guest side of that line is intended capability: what runs inside a managed environment is the
 *  environment's purpose, so `argv` is carried through untouched and only its transport hygiene is
 *  bounded, exactly as `podman.mjs` bounds it today. */
export class NspawnClient {
  #executor;
  #env;
  #images;
  #helperPath;
  #configRoot;
  #timeoutMs;
  #outputLimit;
  #namespace;

  constructor(options = {}) {
    if (!options.images) throw new Error('An image builder client is required; nspawn has no image store');
    this.#executor = options.executor ?? new SpawnExecutor();
    this.#images = options.images;
    this.#env = cleanPodmanEnv(options);
    this.#helperPath = options.helperPath ?? HELPER_PATH;
    this.#configRoot = options.configRoot === undefined ? '' : hostPath(options.configRoot);
    this.#timeoutMs = positive(options.timeoutMs ?? 120_000, 15 * 60_000, 'timeout');
    this.#outputLimit = positive(options.outputLimitBytes ?? OUTPUT_LIMIT, 16 * 1024 * 1024, 'output');
    this.#namespace = options.namespace === undefined ? null : resourceToken(options.namespace);
  }

  async #run(file, args, options = {}) {
    if (args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid machine command argument');
    const result = await this.#executor.run(file, args, {
      env: { ...this.#env }, timeoutMs: positive(options.timeoutMs ?? this.#timeoutMs, 15 * 60_000, 'timeout'),
      outputLimitBytes: this.#outputLimit, input: options.input, signal: options.signal,
    });
    if (!Number.isInteger(result.code) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw new Error('Invalid machine command result');
    const bounded = { code: result.code, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated ?? false };
    if (bounded.code !== 0 && !options.allowFailure) throw new Error(`${options.label ?? args[0]} failed (${bounded.code}): ${bounded.stderr.trim()}`);
    return bounded;
  }

  /** Exactly the argv the sudoers drop-in pins. The empty final argument is part of that pin: it leaves
   *  the helper no argv of its own to be steered by, and the operation arrives on stdin instead. */
  #helperArgv() { return ['-n', this.#helperPath, '']; }

  #systemctl(args, options = {}) { return this.#run(SYSTEMCTL, args, { label: `systemctl ${args[0]}`, ...options }); }
  #machinectl(args, options = {}) { return this.#run(MACHINECTL, args, { label: `machinectl ${args[0]}`, ...options }); }

  /** One privileged round trip. The helper answers every operation with a JSON verdict on its own
   *  stdout and exits zero; a non-zero exit is the helper itself failing, never the guest. */
  async #send(request, options = {}) {
    const result = await this.#run(SUDO, this.#helperArgv(), { label: `privileged ${request.op}`,
      timeoutMs: options.timeoutMs, signal: options.signal, input: helperFrame(request, options.input) });
    if (result.truncated) throw new Error(`Privileged ${request.op} output exceeded its bound`);
    let reply;
    try { reply = JSON.parse(result.stdout); }
    catch { throw new Error(`Privileged ${request.op} produced no usable answer`); }
    if (!reply || typeof reply !== 'object' || reply.ok !== true) throw new Error(`Privileged ${request.op} failed: ${String(reply?.detail ?? 'unknown reason').slice(0, 500)}`);
    return reply;
  }

  async #helper(operation, fields, options = {}) {
    return await this.#send(helperRequest(operation, fields), options);
  }

  /** A guest execution's verdict, in the shape every caller of this runtime already reads. The child's
   *  streams come back separately and base64-encoded, so a command's exact bytes survive the transport,
   *  and its status is its own: an exit code of 42 is 42 and not a transport error. */
  async #execute(request, options = {}) {
    const reply = await this.#send(request, options);
    if (reply.timedOut === true) throw new Error(`Guest command timed out after ${request.timeoutSeconds}s`);
    const decode = (value) => Buffer.from(String(value ?? ''), 'base64').toString('utf8');
    const result = { code: Number.isInteger(reply.exitCode) ? reply.exitCode : 1,
      stdout: decode(reply.stdout), stderr: decode(reply.stderr), truncated: reply.truncated === true };
    if (result.code !== 0 && !options.allowFailure) throw new Error(`Guest command failed (${result.code}): ${result.stderr.trim()}`);
    return result;
  }

  #assertScope(spec) {
    assertContainerSpec(spec);
    if (this.#namespace && spec.namespace !== this.#namespace) throw new Error('Machine namespace differs from the isolated runtime');
    if (!spec.disk) throw new Error('systemd-nspawn runs only rootfs-backed environments');
    if (spec.disk.runtime !== 'nspawn') throw new Error('This environment is not an nspawn environment');
    return spec;
  }

  /** The machine name IS the specification name, which is already `<ns>-<kind>-<id>-g<gen>` and already a
   *  valid machine name. The polkit rule and the helper are both scoped to this exact shape, so a
   *  namespace outside it has no privilege path and is refused here rather than denied later. */
  #machine(spec) {
    this.#assertScope(spec);
    if (!MACHINE_PATTERN.test(spec.name)) throw new Error('Machine name is outside the privileged runtime scope');
    return spec.name;
  }

  #diskDirectory(spec) { return dirname(spec.disk.rootfsPath); }

  #envelopePaths(machine) { return envelopePaths(machine, this.#configRoot); }

  #limitProperties(limits) {
    return [`CPUQuota=${limits.cpus * 100}%`, `MemoryMax=${limits.memoryMb}M`, `TasksMax=${limits.pidsLimit}`];
  }

  async containerExists(spec) {
    const paths = this.#envelopePaths(this.#machine(spec));
    return !absent(paths.nspawn) && !absent(paths.dropIn);
  }

  /** Every machine of a namespace and whether it is up. `machinectl list` reports only RUNNING machines,
   *  which is exactly the question the caller asks; the namespace filter is a name prefix because nspawn
   *  has no labels. */
  async containerInventory(namespace) {
    resourceToken(namespace);
    const result = await this.#machinectl(['list', '--no-legend', '--no-pager']);
    if (result.truncated) throw new Error('Machine inventory exceeded its bound');
    const inventory = new Map();
    for (const line of result.stdout.split('\n')) {
      const name = line.trim().split(/\s+/)[0];
      if (!name || !name.startsWith(`${namespace}-`)) continue;
      resourceToken(name);
      inventory.set(name, 'running');
    }
    return inventory;
  }

  /** The three independent host-side facts that replace `podman inspect`'s twenty-one fields. All of them
   *  have to match or every destructive operation refuses. */
  async inspect(spec) {
    const machine = this.#machine(spec);
    if (!await this.containerExists(spec)) return null;
    const paths = this.#envelopePaths(machine);
    const envelope = readEnvelope(paths);
    const rootfs = realpathSync(spec.disk.rootfsPath);
    const shown = await this.#systemctl(['show', unitFor(machine), '-p',
      'LoadState,FragmentPath,DropInPaths,Environment,ActiveState,SubState,FreezerState,MemoryMax,TasksMax,CPUQuotaPerSecUSec,Slice']);
    const unit = unitProperties(shown.stdout);
    const mismatches = [];
    if (unit.LoadState !== 'loaded') mismatches.push('loadState');
    if (unit.FragmentPath !== join(this.#configRoot, UNIT_TEMPLATE_PATH)) mismatches.push('unitTemplate');
    // Only OUR drop-in is compared. The `50-*` files systemd writes under `/etc/systemd/system.control/`
    // for a live `set-property` are its own record of the applied limits, which the effective values
    // below already hold against the specification.
    const dropIns = String(unit.DropInPaths ?? '').split(/\s+/).filter((path) => path && !path.startsWith(CONTROL_DROPIN_PREFIX));
    if (dropIns.length !== 1 || dropIns[0] !== paths.dropIn) mismatches.push('dropIn');
    if (!String(unit.Environment ?? '').split(/\s+/).includes(`ELOWEN_MACHINE_DIRECTORY=${rootfs}`)) mismatches.push('directory');
    if (unit.Slice !== 'machine.slice') mismatches.push('slice');
    if (Number(unit.MemoryMax) !== spec.limits.memoryMb * 1024 * 1024) mismatches.push('memory');
    if (Number(unit.TasksMax) !== spec.limits.pidsLimit) mismatches.push('pidsLimit');
    const quota = timespanMicroseconds(unit.CPUQuotaPerSecUSec);
    // systemd stores CPUQuota at its own 1% granularity, so the effective figure it reports back can
    // differ from the requested fraction by less than a hundredth of a second and nothing more.
    if (quota === null || Math.abs(quota - spec.limits.cpus * 1_000_000) > 10_000) mismatches.push('cpus');
    const state = mismatches.length ? null : machineState(unit);
    if (state === 'running' || state === 'paused') {
      const machineShown = await this.#machinectl(['show', machine, '-p', 'Unit,RootDirectory'], { allowFailure: true });
      const registered = unitProperties(machineShown.stdout);
      if (machineShown.code !== 0 || registered.Unit !== unitFor(machine) || registered.RootDirectory !== rootfs) mismatches.push('machine');
    }
    const identity = readIdentity(this.#diskDirectory(spec));
    const expected = { namespace: spec.namespace, kind: spec.resource.kind, resource: String(spec.resource.id),
      generation: spec.generation, diskId: spec.disk.id, machine, runtime: 'nspawn',
      specHash: spec.labels['io.elowen.spec'] };
    for (const [key, value] of Object.entries(expected)) {
      if (identity[key] !== value) mismatches.push(`identity.${key}`);
    }
    if (!Number.isSafeInteger(identity.uidBase) || identity.uidBase < 1 || identity.uidSize !== UID_RANGE_SIZE) mismatches.push('identity.uidRange');
    const id = createHash('sha256').update(JSON.stringify([spec.namespace, machine, spec.disk.id, rootfs, envelope.nspawn, envelope.dropIn])).digest('hex');
    if (spec.expectedId && spec.expectedId !== id) mismatches.push('expectedId');
    if (mismatches.length) throw new Error(`Machine ownership or runtime specification mismatch: ${mismatches.join(', ')}`);
    return { id, state };
  }

  async inspectBinding(spec) { return await this.#owned(spec); }

  async #owned(spec) {
    const machine = await this.inspect(spec);
    if (!machine) throw new Error('Container is missing');
    return machine;
  }

  /** Bind mounts as the envelope declares them. `:rootidmap` maps the guest's root onto the host owner of
   *  the source directory, which is the rootless-Podman semantics every existing environment already
   *  depends on: a file the guest writes belongs to the service account on the host. */
  #binds(spec) {
    return spec.mounts.filter((mount) => mount.type === 'bind')
      .map((mount) => ({ source: checkedHostPath(mount.source, { file: mount.target === '/workspace/.git' }), target: mount.target, readOnly: mount.readOnly === true }));
  }

  #envelopeFields(spec) {
    const machine = this.#machine(spec);
    return { machine, namespace: spec.namespace, kind: spec.resource.kind, resource: String(spec.resource.id),
      generation: spec.generation, diskId: spec.disk.id, specHash: spec.labels['io.elowen.spec'],
      limits: { cpus: spec.limits.cpus, memoryMb: spec.limits.memoryMb, pidsLimit: spec.limits.pidsLimit },
      binds: this.#binds(spec), dropCapabilities: [...DROPPED_CAPABILITIES], privateNetwork: true };
  }

  async create(spec) {
    this.#machine(spec);
    if (spec.expectedId) throw new Error('An immutable container binding cannot be recreated');
    if (await this.containerExists(spec)) throw new Error('Container already exists; lifecycle adoption must validate it');
    checkedHostPath(spec.disk.rootfsPath);
    await this.#helper('write-envelope', this.#envelopeFields(spec));
    if (!await this.containerExists(spec)) throw new Error('Machine envelope was not written');
    const created = await this.#owned(spec);
    if (created.state !== 'stopped') throw new Error(`A freshly written machine envelope must be inactive, not ${created.state}`);
    return created;
  }

  async start(spec) {
    const machine = this.#machine(spec);
    await this.#owned(spec);
    await this.#systemctl(['start', unitFor(machine)]);
  }

  /** The unit's own `TimeoutStopSec` governs how long the guest gets; nspawn translates the unit's
   *  SIGTERM into the guest's SIGRTMIN+3, which is the signal a disk-backed Podman envelope is stopped
   *  with today. The argument is validated for parity with that interface and carries no second deadline. */
  async stop(spec, timeoutSeconds = 8) {
    positive(timeoutSeconds, 120, 'stop timeout');
    const machine = this.#machine(spec);
    await this.#owned(spec);
    await this.#systemctl(['stop', unitFor(machine)]);
  }

  async remove(spec) {
    const machine = this.#machine(spec);
    const row = await this.#owned(spec);
    if (!['created', 'configured', 'stopped', 'exited'].includes(row.state)) throw new Error('Stop the container before removal');
    await this.#helper('destroy', { machine, kind: spec.resource.kind, resource: String(spec.resource.id), diskId: spec.disk.id });
    if (await this.containerExists(spec)) throw new Error('Container removal was not verified');
  }

  /** Remove an envelope by NAME, without the ownership proof `remove` demands, for the one repair whose
   *  specification is exactly the thing that changed. The name stays inside this runtime's scope. */
  async removeByName(spec) {
    const machine = this.#machine(spec);
    if (!await this.containerExists(spec)) return;
    await this.#helper('destroy', { machine, kind: spec.resource.kind, resource: String(spec.resource.id), diskId: spec.disk.id });
    if (await this.containerExists(spec)) throw new Error('Container removal was not verified');
  }

  async pause(spec) {
    const machine = this.#machine(spec);
    const row = await this.#owned(spec);
    if (row.state !== 'running') throw new Error('Container is not running');
    await this.#helper('freeze', { machine });
    if ((await this.#owned(spec)).state !== 'paused') throw new Error('Machine freeze was not verified');
  }

  async unpause(spec) {
    const machine = this.#machine(spec);
    const row = await this.#owned(spec);
    if (row.state !== 'paused') throw new Error('Container is not paused');
    await this.#helper('thaw', { machine });
    if ((await this.#owned(spec)).state !== 'running') throw new Error('Machine thaw was not verified');
  }

  async update(spec, requested) {
    const next = withContainerLimits(spec, requested);
    const machine = this.#machine(spec);
    try { await this.#owned(spec); }
    catch (cause) {
      // Recover a completed live update whose durable acknowledgement was interrupted.
      try { await this.#owned(next); return next; } catch { throw cause; }
    }
    await this.#systemctl(['set-property', unitFor(machine), ...this.#limitProperties(next.limits)]);
    await this.#owned(next);
    return next;
  }

  /** Wait until a guest execution is possible at all. `systemctl start` returns once the unit is active,
   *  which is well before the guest's own systemd has activated dbus.socket — and every execution goes
   *  through `systemd-run -M`, which talks to that bus. A guest whose boot stalls for good has to be
   *  reported as a boot that never finished rather than as an opaque bus error. */
  async waitForSystemBus(spec, { timeoutMs = 120_000 } = {}) {
    await this.#owned(spec);
    const deadline = Date.now() + positive(timeoutMs, 15 * 60_000, 'system bus timeout');
    for (;;) {
      const probe = await this.#guest(spec, ['/usr/bin/test', '-S', GUEST_SYSTEM_BUS], { allowFailure: true });
      if (probe.code === 0) return;
      if (Date.now() >= deadline) {
        const status = await this.#guest(spec, ['/usr/bin/systemctl', 'is-system-running'], { allowFailure: true });
        throw new Error(`Guest system bus did not become available within ${Math.round(timeoutMs / 1000)}s (systemd reports ${status.stdout.trim() || 'nothing'})`);
      }
      await new Promise((resolve) => { setTimeout(resolve, 250); });
    }
  }

  async systemRunning(spec, { timeoutMs = 120_000 } = {}) {
    await this.#owned(spec);
    const deadline = Date.now() + positive(timeoutMs, 15 * 60_000, 'system state timeout');
    for (;;) {
      const status = await this.#guest(spec, ['/usr/bin/systemctl', 'is-system-running'], { allowFailure: true });
      const state = status.stdout.trim();
      if (['running', 'degraded'].includes(state)) return state;
      if (Date.now() >= deadline) throw new Error(`Guest systemd did not reach a running state within ${Math.round(timeoutMs / 1000)}s (systemd reports ${state || 'nothing'})`);
      await new Promise((resolve) => { setTimeout(resolve, 250); });
    }
  }

  /** An unleased guest command: this runtime's own probes and the tombstone protocol below. Its unit is
   *  generated per call, so a probe can never collide with the leased execution it is asking about. */
  async #guest(spec, argv, options = {}) {
    const timeoutMs = options.timeoutMs ?? GUEST_COMMAND_TIMEOUT_MS;
    const request = helperRequest('exec', { machine: this.#machine(spec), argv: [...argv], cwd: '/',
      unit: `elowen-probe-${randomBytes(8).toString('hex')}.service`, timeoutSeconds: Math.ceil(timeoutMs / 1000) });
    return await this.#execute(request, { allowFailure: options.allowFailure, timeoutMs });
  }

  /** Persist the host-generated executionId in the existing lease BEFORE calling. The argv is the guest's
   *  business and travels as opaque payload; the bounds below are the transport's, not the command's. */
  #prepareUnit(spec, unit, argv, options = {}) {
    validateInput(options.input);
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > 256 || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
      || argv.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) > 64 * 1024 || !argv[0].startsWith('/')) throw new Error('Invalid guest command arguments');
    const workdir = options.workdir ?? spec.workdir;
    if (typeof workdir !== 'string' || !workdir.startsWith('/') || /[\0\r\n]/.test(workdir) || workdir.length > 4096) throw new Error('Invalid guest working directory');
    const timeoutMs = positive(options.timeoutMs ?? 120_000, 15 * 60_000, 'timeout');
    options.signal?.throwIfAborted();
    return { timeoutMs, unit, workdir };
  }

  /** `mode` is the execution's transport, and it is part of the REQUEST because the two callers below
   *  want different answers from the same command line. This client reads a verdict; the daemon, which
   *  spawns the helper itself, reads the guest's own bytes. */
  async #preparedRequest(spec, unit, argv, options = {}, mode = {}) {
    const prepared = this.#prepareUnit(spec, unit, argv, options);
    const machine = this.#machine(spec);
    const row = await this.#owned(spec);
    if (row.state !== 'running') throw new Error('Container is not running');
    return { ...prepared, container: row,
      request: helperRequest('exec', { machine, unit, argv: [...argv], cwd: prepared.workdir,
        timeoutSeconds: Math.ceil(prepared.timeoutMs / 1000), ...mode }) };
  }

  async #prepareGuest(spec, executionId, argv, options = {}, mode = {}) {
    return await this.#preparedRequest(spec, executionUnit(spec, executionId), argv, options, mode);
  }

  /** The row an in-call cleanup may reuse instead of proving ownership a second time. Private, and it
   *  stays private: the row decides which machine every command below is sent to. It is accepted only
   *  when it matches the immutable envelope identity already pinned into the specification. */
  async #reusableRow(spec, trusted) {
    const pinned = spec.expectedId;
    if (!trusted || typeof trusted.state !== 'string' || typeof trusted.id !== 'string'
      || !/^[a-f0-9]{64}$/.test(pinned ?? '') || trusted.id !== pinned) {
      return await this.#owned(spec);
    }
    return trusted;
  }

  /** Public cancellation. ALWAYS performs its own full ownership verification. */
  async cancelExecution(spec, executionId, { persistent = false } = {}) {
    return await this.#tombstone(spec, executionId, await this.#owned(spec), persistent);
  }

  /** The termination tombstone, against a row this call stack has already verified. The guest stays
   *  systemd-based under nspawn, so this is the Podman protocol verbatim with the transport changed. */
  async #tombstone(spec, executionId, row, persistent) {
    const unit = executionUnit(spec, executionId);
    if (row.state !== 'running') throw new Error('Guest termination cannot be verified in this container state');
    const mask = () => this.#guest(spec, ['/usr/bin/systemctl', 'mask', ...(persistent ? [] : ['--runtime']), unit]);
    // The runtime mask is a tombstone: it blocks a StartTransientUnit arriving after cancellation.
    await mask();
    const stop = await this.#guest(spec, ['/usr/bin/systemctl', 'stop', unit], { allowFailure: true });
    // Collecting a transient unit after stop invalidates its loaded mask state. Re-establish the
    // tombstone after collection and verify it; not-found alone is not proof against late starts.
    await mask();
    const shown = await this.#guest(spec, ['/usr/bin/systemctl', 'show', '--property=LoadState,ActiveState,SubState,ControlGroup', unit]);
    const fields = unitProperties(shown.stdout);
    if (shown.truncated || fields.LoadState !== 'masked' || !['inactive', 'failed'].includes(fields.ActiveState)
      || !['dead', 'failed'].includes(fields.SubState) || fields.ControlGroup !== '' || (stop.code !== 0 && stop.code !== 5)) {
      throw new Error('Guest execution termination could not be verified');
    }
    return { terminated: true, unit, container: row };
  }

  /** Only after the owning launcher has settled and the durable lease forbids redispatch. */
  async releaseExecution(spec, executionId, { persistent = false } = {}) {
    return await this.#release(spec, executionId, await this.#owned(spec), persistent);
  }

  async #release(spec, executionId, row, persistent) {
    const unit = executionUnit(spec, executionId);
    if (row.state === 'running') {
      // A launcher that settled normally leaves nothing to terminate: `--collect` retires the transient
      // unit as it deactivates, and the mask tombstone only closes a race that stays open while a unit is
      // still loaded. Proven absence is the only thing that takes this path.
      const shown = await this.#guest(spec, ['/usr/bin/systemctl', 'show', '--property=LoadState,ActiveState,SubState,ControlGroup', unit], { allowFailure: true });
      const fields = unitProperties(shown.stdout);
      if (!shown.truncated && shown.code === 0 && fields.LoadState === 'not-found'
        && fields.ActiveState === 'inactive' && fields.SubState === 'dead' && fields.ControlGroup === '') return;
    }
    const settled = await this.#tombstone(spec, executionId, row, persistent);
    await this.#guest(spec, ['/usr/bin/systemctl', 'unmask', ...(persistent ? [] : ['--runtime']), unit]);
    return settled;
  }

  /** Runs a guest command to completion and settles it. On EVERY exit from here the guest execution has
   *  been dealt with, EXCEPT when the cleanup itself failed — which is tagged `guestSettled = false`,
   *  because it is the only case where the caller must not retire the lease that still fences the guest. */
  async exec(spec, executionId, argv, options = {}) {
    const persistent = options.persistent === true;
    const prepared = await this.#prepareGuest(spec, executionId, argv, options);
    let result;
    let failure;
    try {
      result = await this.#execute(prepared.request,
        { input: options.input, timeoutMs: prepared.timeoutMs, signal: options.signal, allowFailure: true });
    } catch (error) { failure = error; }
    try {
      const row = await this.#reusableRow(spec, prepared.container);
      if (failure) await this.#tombstone(spec, executionId, row, persistent);
      else await this.#release(spec, executionId, row, persistent);
    } catch (error) {
      throw Object.assign(new AggregateError([...(failure ? [failure] : []), error], `Guest command cleanup failed: ${error.message}`), { guestSettled: false });
    }
    if (failure) throw failure;
    return result;
  }

  /** The launch descriptor the daemon spawns and streams itself. The privileged request travels ahead of
   *  the caller's own stdin in the SAME pipe, which is why the frame is returned as `stdin` rather than
   *  hidden inside the argv the sudoers drop-in pins.
   *
   *  `raw` is what makes this a launch rather than a call. The daemon spawns the helper itself and streams
   *  its stdout and stderr to a terminal, so a base64 verdict on stdout is not the answer anyone here
   *  wants: in raw mode the helper inherits the child's streams and exits with the child's own status,
   *  which is exactly how `podman exec` behaves for the same descriptor. */
  async prepareExecution(spec, executionId, argv, options = {}) {
    if (options.completionCwd === true) throw new Error('Completion cwd capture is not carried by the nspawn transport');
    const prepared = await this.#prepareGuest(spec, executionId, argv, options, { raw: true });
    return {
      launch: { type: 'argv', file: SUDO, args: this.#helperArgv(), env: { ...this.#env } },
      stdin: helperFrame(prepared.request, options.input),
      settle: async ({ cancel = false } = {}) => {
        const row = await this.#reusableRow(spec, prepared.container);
        if (cancel) { await this.#tombstone(spec, executionId, row, true); return; }
        await this.#release(spec, executionId, row, true);
      },
    };
  }

  /** A guest unit that outlives the call that started it — a preview server, a publication forwarder —
   *  so the privileged side drops `--pipe`, `--wait` and the runtime deadline and returns as soon as the
   *  unit is up. `detached` has to come back acknowledged: a helper that ignored it would have waited for
   *  a server that is not going to exit, and a request that hangs until its deadline is not a start. */
  async #startDetached(spec, unit, argv) {
    const prepared = this.#prepareUnit(spec, unit, argv, {});
    const machine = this.#machine(spec);
    const row = await this.#owned(spec);
    if (row.state !== 'running') throw new Error('Container is not running');
    const reply = await this.#send(helperRequest('exec', { machine, unit, argv: [...argv], cwd: prepared.workdir,
      detached: true, timeoutSeconds: Math.ceil(GUEST_COMMAND_TIMEOUT_MS / 1000) }), { timeoutMs: GUEST_COMMAND_TIMEOUT_MS });
    if (reply.detached !== true) throw new Error('The privileged helper did not start the guest unit detached');
  }

  async startPreview(spec, executionId, argv) {
    if (spec.resource.kind !== 'project' || !spec.mounts.some((mount) => mount.target === '/run/elowen')) throw new Error('Project preview transport is unavailable');
    const unit = executionUnit(spec, executionId);
    await this.#startDetached(spec, unit, argv);
    const shown = await this.#guest(spec, ['/usr/bin/systemctl', 'is-active', unit], { allowFailure: true });
    if (shown.stdout.trim() !== 'active') throw new Error('Preview service did not start');
  }

  async startPublication(spec, publicationId, argv) {
    if (spec.resource.kind !== 'project' || !spec.mounts.some((mount) => mount.target === '/run/elowen')) throw new Error('Project publication transport is unavailable');
    const unit = publicationUnit(publicationId);
    await this.#guest(spec, ['/usr/bin/systemctl', 'stop', unit], { allowFailure: true });
    await this.#startDetached(spec, unit, argv);
    const shown = await this.#guest(spec, ['/usr/bin/systemctl', 'is-active', unit], { allowFailure: true });
    if (shown.stdout.trim() !== 'active') throw new Error('Publication service did not start');
  }

  async stopPublication(spec, publicationId) {
    const unit = publicationUnit(publicationId);
    const row = await this.#owned(spec);
    if (row.state !== 'running') throw new Error('Container is not running');
    await this.#guest(spec, ['/usr/bin/systemctl', 'stop', unit], { allowFailure: true });
    const shown = await this.#guest(spec, ['/usr/bin/systemctl', 'is-active', unit], { allowFailure: true });
    if (shown.stdout.trim() === 'active') throw new Error('Publication service did not stop');
  }

  async activePublications(spec, publicationIds) {
    if (!Array.isArray(publicationIds) || publicationIds.length === 0) return [];
    const units = publicationIds.map(publicationUnit);
    const row = await this.#owned(spec);
    if (row.state !== 'running') return [];
    const shown = await this.#guest(spec, ['/usr/bin/systemctl', 'is-active', ...units], { allowFailure: true });
    const states = shown.stdout.trimEnd().split('\n');
    return publicationIds.filter((_id, index) => states[index] === 'active');
  }

  /** The one-time ownership pass that turns a disk extracted inside `podman unshare` into a tree the
   *  machine's own fixed uid range owns. Nothing is copied, and the range is recorded in the disk
   *  identity so it happens once for the life of the disk. */
  async shiftOwnership(spec, { target = 'nspawn', uidBase = null } = {}) {
    if (target !== 'nspawn' && target !== 'podman') throw new Error('Invalid ownership shift target');
    if (target === 'podman' && (!Number.isSafeInteger(uidBase) || uidBase < 0)) throw new Error('Reversing an ownership shift requires the recorded range');
    const machine = this.#machine(spec);
    checkedHostPath(spec.disk.rootfsPath);
    const receipt = await this.#helper('shift-ownership', { machine, namespace: spec.namespace, kind: spec.resource.kind,
      resource: String(spec.resource.id), generation: spec.generation, diskId: spec.disk.id,
      specHash: spec.labels['io.elowen.spec'], target, uidBase }, { timeoutMs: 15 * 60_000 });
    if (target === 'nspawn' && (!Number.isSafeInteger(receipt?.uidBase) || receipt.uidBase < 1
      || receipt.uidSize !== UID_RANGE_SIZE || !Number.isSafeInteger(receipt?.previousUidBase))) throw new Error('Invalid ownership shift receipt');
    return receipt;
  }

  async materializeRootfs(spec) {
    this.#assertScope(spec);
    throw new Error('A fresh nspawn disk is materialized from an export archive; direct image materialization arrives with nspawn environment creation');
  }

  async extractRootfsArchive(spec, archivePath, targetPath) {
    const machine = this.#machine(spec);
    const archive = checkedHostPath(archivePath, { file: true });
    const target = checkedHostPath(targetPath);
    await this.#helper('materialize', { machine, namespace: spec.namespace, kind: spec.resource.kind,
      resource: String(spec.resource.id), generation: spec.generation, diskId: spec.disk.id,
      specHash: spec.labels['io.elowen.spec'], archivePath: archive, targetPath: target },
    { timeoutMs: 15 * 60_000 });
  }

  async verifyExtractedRootfs(archivePath, targetPath) {
    const archive = checkedHostPath(archivePath, { file: true });
    const target = checkedHostPath(targetPath);
    const value = await this.#helper('tree-verify', { archivePath: archive, targetPath: target }, { timeoutMs: 15 * 60_000 });
    if (!Number.isSafeInteger(value?.members) || value.members < 1) throw new Error('The migration export archive named no members');
    return value;
  }

  async copyDiskTree(sourcePath, targetPath) {
    await this.#helper('tree-copy', { sourcePath: checkedHostPath(sourcePath), targetPath: checkedHostPath(targetPath) }, { timeoutMs: 15 * 60_000 });
  }

  async fingerprintDiskTree(path) {
    const value = await this.#helper('tree-fingerprint', { path: checkedHostPath(path) }, { timeoutMs: 15 * 60_000 });
    if (!Number.isSafeInteger(value?.logicalBytes) || !Number.isSafeInteger(value?.allocatedBytes) || !/^[a-f0-9]{64}$/.test(value?.digest ?? '')) throw new Error('Invalid disk tree fingerprint');
    return value;
  }

  async syncDiskTree(path) {
    await this.#helper('tree-sync', { path: checkedHostPath(path) }, { timeoutMs: 15 * 60_000 });
  }

  async preflightDiskCopy(sourcePaths, destinationPath) {
    if (!Array.isArray(sourcePaths) || sourcePaths.length < 1) throw new Error('Disk copy preflight requires source trees');
    const value = await this.#helper('tree-preflight', { sourcePaths: sourcePaths.map((path) => checkedHostPath(path)), destinationPath: checkedHostPath(destinationPath) }, { timeoutMs: 15 * 60_000 });
    if (!Number.isSafeInteger(value?.requiredBytes) || !Number.isSafeInteger(value?.marginBytes) || !Number.isSafeInteger(value?.freeBytes)) throw new Error('Invalid disk copy preflight');
    return value;
  }

  async removeDiskPath(path) {
    await this.#helper('tree-remove', { path: hostPath(path) }, { timeoutMs: 15 * 60_000 });
  }

  async removeStorage(spec) {
    this.#assertScope(spec);
    if (await this.containerExists(spec)) throw new Error('Container still owns environment storage');
    try { checkedHostPath(spec.storageRoot); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
    await this.removeDiskPath(spec.storageRoot);
    if (!absent(spec.storageRoot)) throw new Error('Environment storage removal was not verified');
  }

  async removeGenerationStorage(spec) {
    this.#assertScope(spec);
    if (await this.inspect(spec)) throw new Error('Remove the staging container before its storage');
    const directory = join(spec.storageRoot, 'storage', String(spec.generation));
    try { checkedHostPath(directory); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
    await this.removeDiskPath(directory);
  }

  async removeSnapshotStorage(spec, snapshotId) {
    this.#assertScope(spec); resourceToken(snapshotId);
    const directory = join(spec.storageRoot, 'snapshots', snapshotId);
    try { checkedHostPath(directory); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
    const manifest = JSON.parse(readFileSync(checkedHostPath(join(directory, 'manifest.json'), { file: true }), 'utf8'));
    if (manifest.snapshotId !== snapshotId || manifest.resource?.kind !== spec.resource.kind || manifest.resource?.id !== spec.resource.id
      || manifest.generation !== spec.generation || manifest.specHash !== spec.specHash) throw new Error('Snapshot cleanup ownership mismatch');
    await this.removeDiskPath(directory);
    if (!absent(directory)) throw new Error('Snapshot cleanup was not verified');
  }

  async discardIncompleteSnapshot(spec, snapshotId) {
    this.#assertScope(spec); resourceToken(snapshotId);
    const directory = checkedHostPath(join(spec.storageRoot, 'snapshots', snapshotId));
    const record = JSON.parse(readFileSync(checkedHostPath(join(directory, 'pending.json'), { file: true }), 'utf8'));
    if (record.snapshotId !== snapshotId || record.resource?.kind !== spec.resource.kind || record.resource?.id !== spec.resource.id
      || record.generation !== spec.generation || record.specHash !== spec.specHash) throw new Error('Incomplete snapshot ownership mismatch');
    if (!absent(join(directory, 'manifest.json'))) throw new Error('A completed snapshot cannot be discarded as incomplete');
    await this.removeDiskPath(directory);
  }

  /** The image is still the template a disk is materialized from, so every image operation is delegated
   *  to a client that HAS an image store. nspawn has none and is not asked to pretend otherwise. */
  ensureProjectImage(dataDir, onOutput) { return this.#images.ensureProjectImage(dataDir, onOutput); }
  ensureSiteImage(dataDir, recipe) { return this.#images.ensureSiteImage(dataDir, recipe); }
  imageStatus(reference) { return this.#images.imageStatus(reference); }
  imageIdentity(reference) { return this.#images.imageIdentity(reference); }
  discoverRetainedSiteImage(spec, reference) { return this.#images.discoverRetainedSiteImage(spec, reference); }
  inspectRetainedSiteImage(spec, reference, imageId) { return this.#images.inspectRetainedSiteImage(spec, reference, imageId); }
  removeRetainedSiteImage(spec, reference, imageId) { return this.#images.removeRetainedSiteImage(spec, reference, imageId); }

  /** Snapshots of a disk-backed environment are disk copies, format 2, and never a committed image.
   *  These three exist only for legacy image-backed rows, which are never this client's. */
  async snapshotImage() { throw new Error('A disk-backed environment snapshots its disk, not an image'); }
  async inspectSnapshotImage() { throw new Error('A disk-backed environment snapshots its disk, not an image'); }
  async removeSnapshotImage() { throw new Error('A disk-backed environment snapshots its disk, not an image'); }

  /** Migration SOURCES. Only a legacy image-backed environment is exported, and this client never holds
   *  one; a Podman row migrates to nspawn through `migrate-runtime`, which copies nothing. */
  async preflightRootfsMigration() { throw new Error('Only a legacy image-backed environment is migrated'); }
  async exportContainerRootfs() { throw new Error('Only a legacy image-backed container is exported for migration'); }

  /** Named volumes are a Podman handle over a host directory. A disk-backed environment mounts the disk's
   *  own directories, so there is no handle to create, inspect or remove — and emulating one would add a
   *  second owner of paths the disk record already owns. */
  async ensureVolume() { throw new Error('An nspawn environment has no named volumes'); }
  async inspectVolume() { throw new Error('An nspawn environment has no named volumes'); }
  async removeVolume() { throw new Error('An nspawn environment has no named volumes'); }
  async exportVolume() { throw new Error('An nspawn environment has no named volumes'); }
  async importSnapshotVolume() { throw new Error('An nspawn environment has no named volumes'); }
  async siteDataArchive() { throw new Error('An nspawn environment has no named volumes'); }
}
