import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { assertContainerSpec, executionUnit, hostPath, publicationUnit, resourceToken, withContainerLimits } from './containerSpec.mjs';
import { checkedHostPath } from './containerPaths.mjs';
import { GUEST_SYSTEM_BUS, OUTPUT_LIMIT, positive, serviceProcessEnv, SpawnExecutor, unitProperties, validateInput } from './runtimeProcess.mjs';

/** The one privileged executable, shared with the published-sites gateway: two typed domains behind one
 *  root-owned binary and one pinned sudoers line, because two executables reachable by the same service
 *  account are not a privilege boundary. Every root-only operation arrives on its stdin as a bounded JSON
 *  request. This mirrors `SITE_GATEWAY_HELPER_PATH` in `src/shared/siteGateway.ts`, which a bundled
 *  plugin cannot import at runtime; `tests/contract/nspawnHelper.test.ts` holds this constant, the argv
 *  below, the shared constants and the sudoers line against each other. */
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
/** Capabilities dropped from nspawn's default bound. Every one of them is also denied by the default set
 *  of an ordinary rootless container; what remains is what systemd needs to boot the guest, and those are
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
/** What the privileged answer itself may weigh. It is the transport's ceiling, not the guest's: the
 *  helper wraps a command's streams in its verdict and encodes them, so the envelope is always larger
 *  than the output it carries, and reading it against the caller's own output bound would cut the JSON
 *  rather than the command's bytes. */
const HELPER_RESPONSE_LIMIT = 16 * 1024 * 1024;
const GUEST_COMMAND_TIMEOUT_MS = 30_000;
/** How long one readiness probe may take. Short, because a probe that cannot answer is the answer. */
const PROBE_TIMEOUT_MS = 5_000;
/** `provision` writes root-owned files, runs a package manager and touches the host's packet filter, so it
 *  is not something an ordinary request may cause. It is reachable only from the administrator-only
 *  control above it, and every other operation here still REPORTS an unready host rather than repairing
 *  it — `write-envelope` re-checks the same rows and refuses. That split is the whole point: serving a
 *  project never changes the host, and an operator asking to prepare the host does. */
const HELPER_OPERATIONS = new Set(['status', 'provision', 'materialize', 'write-envelope', 'shift-ownership', 'exec', 'freeze', 'thaw',
  'site-data-archive', 'tree-copy', 'tree-fingerprint', 'tree-preflight', 'tree-remove', 'tree-sync', 'tree-verify', 'destroy']);

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
    // The fraction is not decoration: systemd renders a CPU quota of 150% as `1.500000s`, and a whole
    // second is the only case that comes back without one. An integer-only parser reads that as
    // unparseable and every environment with more than one CPU fails its own limit check.
    const token = /^([0-9]+(?:\.[0-9]+)?)(us|ms|min|s|h|d)$/.exec(part);
    if (!token) return null;
    total += Math.round(Number(token[1]) * units[token[2]]);
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

/** Concrete internal driver for systemd-nspawn machines, behind the runtime-neutral client interface.
 *
 *  Two transports and no third. The machine LIFECYCLE runs as the service account over a unit-scoped
 *  polkit rule with no sudo at all: start, stop, set-property, show, list. Everything that needs root —
 *  guest execution, freeze and thaw, and every operation on a tree owned by the machine's uid range —
 *  goes through the single privileged helper, which re-derives its own paths and command lines.
 *
 *  The guest side of that line is intended capability: what runs inside a managed environment is the
 *  environment's purpose, so `argv` is carried through untouched and only its transport hygiene is
 *  bounded. */
export class NspawnClient {
  #executor;
  #env;
  #artifacts;
  #helperPath;
  #configRoot;
  #timeoutMs;
  #outputLimit;
  #namespace;
  /** Guest executions this client is currently running, by leased unit. `cancelExecution` marks the
   *  record it finds here, and `exec` reads its own record to decide what verdict it owes the caller.
   *  The launcher exits zero whether its command finished or its unit was stopped under it, and asking
   *  the guest afterwards cannot tell the two apart: `--collect` retires the transient unit as it
   *  deactivates, so a lookup races the reaper and answers "masked" or "already gone" depending only on
   *  which ran first. The fact is known here without asking anyone. Entries live exactly as long as the
   *  `exec` that created them. */
  #running = new Map();

  constructor(options = {}) {
    if (!options.artifacts) throw new Error('A root filesystem artifact store is required');
    this.#executor = options.executor ?? new SpawnExecutor();
    this.#artifacts = options.artifacts;
    this.#env = serviceProcessEnv(options);
    this.#helperPath = options.helperPath ?? HELPER_PATH;
    this.#configRoot = options.configRoot === undefined ? '' : hostPath(options.configRoot);
    this.#timeoutMs = positive(options.timeoutMs ?? 120_000, 15 * 60_000, 'timeout');
    this.#outputLimit = positive(options.outputLimitBytes ?? OUTPUT_LIMIT, 16 * 1024 * 1024, 'output');
    this.#namespace = options.namespace === undefined ? null : resourceToken(options.namespace);
  }

  /** Every process this runtime spawns is a control tool or the privileged helper, so its stdout is
   *  transport and is read against the transport's ceiling. No guest byte ever reaches this method: the
   *  guest's own streams arrive encoded inside a verdict, and the caller's output bound is applied to
   *  them once they are decoded, in `#execute`. */
  async #run(file, args, options = {}) {
    if (args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid machine command argument');
    const result = await this.#executor.run(file, args, {
      env: { ...this.#env }, timeoutMs: positive(options.timeoutMs ?? this.#timeoutMs, 15 * 60_000, 'timeout'),
      outputLimitBytes: HELPER_RESPONSE_LIMIT, input: options.input, signal: options.signal,
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
   *  stdout and exits zero; a non-zero exit is the helper itself failing, never the guest.
   *
   *  The verdict is a TRANSPORT artefact, not guest output, so it is read against the transport's own
   *  ceiling rather than the caller's output bound. Bounding the envelope by the caller's figure would
   *  cut the JSON in half and turn a guest that wrote a megabyte into an unparseable answer; the guest's
   *  own bound is applied to its decoded bytes in `#execute`, which is where it belongs. */
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
   *  and its status is its own: an exit code of 42 is 42 and not a transport error.
   *
   *  The caller's output bound applies to the DECODED bytes and keeps their tail, which is what the
   *  container runtime does with the same figure — a command that writes more than the caller asked for
   *  comes back shortened with `truncated` set, not as a failure. The one case that still cannot be
   *  answered that way is a guest whose output outgrows the transport itself: the bytes arrive wrapped in
   *  the verdict, so a cut envelope is not a shortened answer but no answer, and `#send` reports it. */
  async #execute(request, options = {}) {
    const reply = await this.#send(request, options);
    if (reply.timedOut === true) throw new Error(`Guest command timed out after ${request.timeoutSeconds}s`);
    let truncated = reply.truncated === true;
    const decode = (value) => {
      const buffer = Buffer.from(String(value ?? ''), 'base64');
      if (buffer.length <= this.#outputLimit) return buffer.toString('utf8');
      truncated = true;
      return buffer.subarray(buffer.length - this.#outputLimit).toString('utf8');
    };
    const stdout = decode(reply.stdout);
    const stderr = decode(reply.stderr);
    const result = { code: Number.isInteger(reply.exitCode) ? reply.exitCode : 1, stdout, stderr, truncated };
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

  /** What the host still owes this runtime, in the item shape the other readiness surfaces already use:
   *  `{ ready, items: [{ id, label, ok, detail }] }`. Each unmet row's detail carries the exact command an
   *  operator runs, so a caller shows the rows rather than translating them into advice of its own — the
   *  ids are the helper's to name and have moved once already.
   *
   *  Read-only. Provisioning is a separate privileged operation and the daemon never performs it on its
   *  own; a host that is not ready is reported, not repaired. */
  /** `veth` asks the privileged side to include what a virtual ethernet needs: forwarding, the link
   *  configuration service and the five firewall rules. It defaults to on because that is what an
   *  ordinary environment now requests, and a readiness report that omits the rows it will be refused on
   *  would tell a person the runtime is ready right up until the first environment fails to be created. */
  async hostReadiness({ veth = true } = {}) {
    return this.#readiness('status', { veth });
  }

  /** Bring the host up to what `hostReadiness` asks for, and answer with the readiness report as it
   *  stands AFTERWARDS rather than with a claim of success. The two share a shape on purpose: a caller
   *  renders the same rows either way, and a host that is still short of something says which row.
   *
   *  Idempotent, because every step on the privileged side asks before it acts: running it against a
   *  prepared host writes nothing and reloads nothing. It is an ADMINISTRATOR's operation — it installs
   *  packages and applies firewall rules — so the control above it is the gate, and the helper still
   *  refuses a host whose operating system it does not support rather than modifying it anyway.
   *
   *  A host where the privileged helper is not installed or not permitted cannot be repaired from here at
   *  all. That failure is reported with the helper's own message, and the unmet readiness rows already
   *  carry the exact command an operator runs by hand. */
  async provisionHost({ veth = true } = {}) {
    return this.#readiness('provision', { veth }, { timeoutMs: 12 * 60_000 });
  }

  async #readiness(operation, fields, options = {}) {
    const reply = await this.#helper(operation, fields, options);
    if (typeof reply.ready !== 'boolean' || !Array.isArray(reply.items)) throw new Error('Invalid machine runtime readiness report');
    return {
      ready: reply.ready,
      items: reply.items.map((item) => {
        if (typeof item?.id !== 'string' || typeof item?.label !== 'string' || typeof item?.ok !== 'boolean') throw new Error('Invalid machine runtime readiness item');
        return { id: item.id, label: item.label, ok: item.ok, ...(typeof item.detail === 'string' ? { detail: item.detail } : {}) };
      }),
      ...(typeof reply.detail === 'string' && reply.detail ? { detail: reply.detail.slice(0, 500) } : {}),
    };
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

  /** The three independent host-side facts an environment is identified by. All of them have to match or
   *  every destructive operation refuses. */
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
      // One `-p` per property: `machinectl` takes no comma-separated list, which `systemctl` does, and
      // asking it for `Unit,RootDirectory` gets a property by that literal name and therefore no output
      // at all — so every running machine would fail its own ownership proof.
      const machineShown = await this.#machinectl(['show', machine, '-p', 'Unit', '-p', 'RootDirectory'], { allowFailure: true });
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
   *  the source directory, so a file the guest writes belongs to the service account on the host. */
  #binds(spec) {
    return spec.mounts.filter((mount) => mount.type === 'bind')
      .map((mount) => ({ source: checkedHostPath(mount.source, { file: mount.target === '/workspace/.git' }), target: mount.target, readOnly: mount.readOnly === true }));
  }

  /** The Site contract is one dotenv file generated by Sites before creation. Podman consumed that file
   *  directly; nspawn has no env-file option, so this client parses the same file once and sends only its
   *  values to the typed helper, which writes them into the machine envelope. */
  #environment(spec) {
    if (!spec.envFile) return {};
    const path = checkedHostPath(spec.envFile, { file: true });
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || stat.size > 64 * 1024) throw new Error('Untrusted machine environment file');
    const parsed = parseEnv(readFileSync(path, 'utf8'));
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
  }

  #envelopeFields(spec) {
    const machine = this.#machine(spec);
    return { machine, namespace: spec.namespace, kind: spec.resource.kind, resource: String(spec.resource.id),
      generation: spec.generation, diskId: spec.disk.id, specHash: spec.labels['io.elowen.spec'],
      limits: { cpus: spec.limits.cpus, memoryMb: spec.limits.memoryMb, pidsLimit: spec.limits.pidsLimit },
      binds: this.#binds(spec), environment: this.#environment(spec), dropCapabilities: [...DROPPED_CAPABILITIES],
      // The specification's own network policy, carried across rather than decided here. Everything but an
      // explicitly isolated environment gets a virtual ethernet, because that is what the container
      // runtime gives the same specification today: without it a guest has its own loopback and nothing
      // else, so no name resolves, nothing installs, and a user's first `apt` or `npm install` fails.
      // `privateNetwork` is the privileged side's word for the loopback-only shape, so an environment that
      // wants a link asks for `false`. The host guard is not this client's to check: `write-envelope`
      // refuses a link the firewall is not ready to isolate, which is the only place no caller can skip.
      privateNetwork: spec.network === 'none' };
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
    await this.#awaitRegistration(machine);
  }

  /** A started unit is not yet a registered machine. `systemctl start` returns once nspawn has signalled
   *  readiness, and the machine manager finishes registering a moment later; between the two, the unit is
   *  active while `machinectl show` still knows nothing. Every ownership proof reads that registration, so
   *  a caller that inspected immediately after a start would be told the envelope does not match itself.
   *  Waiting here rather than loosening `inspect` keeps the proof strict: an envelope that never registers
   *  is a failure to report, not a state to tolerate. */
  async #awaitRegistration(machine, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const shown = await this.#machinectl(['show', machine, '-p', 'Unit'], { allowFailure: true });
      if (shown.code === 0 && unitProperties(shown.stdout).Unit === unitFor(machine)) return;
      if (Date.now() >= deadline) throw new Error('The machine did not register with the machine manager');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** The unit's own `TimeoutStopSec` governs how long the guest gets; nspawn translates the unit's
   *  SIGTERM into the guest's SIGRTMIN+3, which is how a systemd guest is asked to shut down. The
   *  argument is validated for parity with the client interface and carries no second deadline. */
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
    // Each probe is itself a guest command, and a guest command needs the very bus being waited for, so a
    // machine whose bus never comes up answers each probe only when the launcher's own activation timeout
    // expires. Bounding the probe by the time that is actually left keeps the wait as long as the caller
    // asked for and no longer, instead of overrunning it by a whole probe.
    const probeMs = () => Math.max(1000, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()));
    for (;;) {
      const probe = await this.#guest(spec, ['/usr/bin/test', '-S', GUEST_SYSTEM_BUS], { allowFailure: true, timeoutMs: probeMs() });
      if (probe.code === 0) return;
      if (Date.now() >= deadline) {
        const status = await this.#guest(spec, ['/usr/bin/systemctl', 'is-system-running'], { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS });
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
    const row = await this.#owned(spec);
    // Recorded BEFORE the termination, not after it. The tombstone below stops the unit half way through,
    // and stopping the unit is exactly what makes the launcher return, so an execution marked afterwards
    // would already have read its record and reported the kill as a success. The intent is the fact `exec`
    // needs and it is known here; it is not withdrawn if the verification then fails, because a caller
    // whose cancellation could not be confirmed still cannot trust the verdict it would otherwise get.
    const record = this.#running.get(executionUnit(spec, executionId));
    if (record) record.cancelled = true;
    return await this.#tombstone(spec, executionId, row, persistent);
  }

  /** The termination tombstone, against a row this call stack has already verified. The guest is
   *  systemd-based, so termination is proven through the unit rather than through a host process. */
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
    const key = executionUnit(spec, executionId);
    const record = { cancelled: false };
    // The record has to outlive the launcher: a cancellation lands while the command is running, and the
    // answer is read after it returns. It is dropped in the `finally` at the end of this method.
    this.#running.set(key, record);
    try {
      let result;
      let failure;
      try {
        result = await this.#execute(prepared.request,
          { input: options.input, timeoutMs: prepared.timeoutMs, signal: options.signal, allowFailure: true });
      } catch (error) { failure = error; }
      try {
        const row = await this.#reusableRow(spec, prepared.container);
        if (failure) await this.#tombstone(spec, executionId, row, persistent);
        // A cancellation already ran the full tombstone against this unit and the mask has to stand: it is
        // what stops a launch still in flight from bringing the unit back. There is nothing left to settle.
        else if (!record.cancelled) await this.#release(spec, executionId, row, persistent);
      } catch (error) {
        throw Object.assign(new AggregateError([...(failure ? [failure] : []), error], `Guest command cleanup failed: ${error.message}`), { guestSettled: false });
      }
      if (failure) throw failure;
      // A launcher whose unit was stopped out from under it still exits zero, so the verdict alone cannot
      // tell a cancelled command from one that ran to completion — and reporting a killed command as a
      // success with no output is how a caller comes to act on work that never happened. A cancellation is
      // reported the way the deadline above is: as the execution not having run to completion.
      if (record.cancelled) throw Object.assign(new Error('Guest command was cancelled'), { cancelled: true });
      return result;
    } finally { this.#running.delete(key); }
  }

  /** The launch descriptor the daemon spawns and streams itself. The privileged request travels ahead of
   *  the caller's own stdin in the SAME pipe, which is why the frame is returned as `stdin` rather than
   *  hidden inside the argv the sudoers drop-in pins.
   *
   *  `raw` is what makes this a launch rather than a call. The daemon spawns the helper itself and streams
   *  its stdout and stderr to a terminal, so a base64 verdict on stdout is not the answer anyone here
   *  wants: in raw mode the helper inherits the child's streams and exits with the child's own status,
   *  which is what any ordinary remote-execution command does for the same descriptor. */
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

  /** The one-time ownership pass that puts an existing disk tree onto the machine's own fixed uid range.
   *  Nothing is copied, and the range is recorded in the disk identity so it happens once for the life of
   *  the disk. */
  async shiftOwnership(spec) {
    const machine = this.#machine(spec);
    checkedHostPath(spec.disk.rootfsPath);
    const receipt = await this.#helper('shift-ownership', { machine, namespace: spec.namespace, kind: spec.resource.kind,
      resource: String(spec.resource.id), generation: spec.generation, diskId: spec.disk.id,
      specHash: spec.labels['io.elowen.spec'] }, { timeoutMs: 15 * 60_000 });
    if (!Number.isSafeInteger(receipt?.uidBase) || receipt.uidBase < 1
      || receipt.uidSize !== UID_RANGE_SIZE) throw new Error('Invalid ownership shift receipt');
    return receipt;
  }

  /** A fresh disk for a new environment, unpacked from the published root filesystem its specification
   *  names. `disk.sourceImage` is that name — an artifact reference such as `project-base@1` — and the
   *  store resolves it to bytes it has already verified against the pinned digest.
   *
   *  The privileged helper does the extraction because only root can preserve the archive's ownership and
   *  then shift the whole tree into the machine's uid range, which is the step that makes the tree a
   *  machine's. What comes back is the artifact's digest, which the disk record keeps as provenance: it
   *  says which bytes this filesystem came from, and nothing ever needs those bytes again. */
  async materializeRootfs(spec, pendingPath, options = {}) {
    this.#assertScope(spec);
    const pending = checkedHostPath(pendingPath);
    // The artifact store hashes the blob against the pinned digest before it hands the path over — on a
    // cache hit as much as on a download — so what arrives here is verified bytes rather than a verified
    // history, and nothing here cleans it up: the blob is a shared cache entry owned by the store, not a
    // per-environment temporary. Unpacking copies the bytes out, which is what lets the store reclaim it
    // afterwards without touching this disk.
    const artifact = await this.#artifacts.ensure(spec.disk.sourceImage, options);
    await this.extractRootfsArchive(spec, artifact.path, pending);
    return artifact.digest;
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

  /** Whether this host already holds the bytes a reference names, and fetching them when it does not.
   *  Both are the artifact store's, and both are answered without an image store existing anywhere. */
  artifactStatus(reference) { return this.#artifacts.status(reference); }
  ensureArtifact(reference, options) { return this.#artifacts.ensure(reference, options); }
  collectArtifacts(referenced) { return this.#artifacts.collect(referenced); }

  /** Seeding or capturing a Site's `data` directory as one archive, which is what the Sites `import-data`
   *  and `export-data` actions and the bootstrap seed on Site creation all route through.
   *
   *  The container runtime streamed a named volume; a machine has no such handle, because the data
   *  directory is a plain tree on the disk owned by the machine's uid range — so the work itself belongs
   *  to the privileged helper, which re-derives the environment's storage root from the resource identity
   *  and accepts only the `data` tree under it. What is decided here is the contract around that call.
   *
   *  An import is refused unless the machine is down. The container runtime allowed `created`,
   *  `configured`, `stopped` and `exited`, which is every state in which nothing inside is writing; a
   *  machine reports `running`, `paused`, `stopping` or `stopped`, so the same rule leaves exactly one
   *  state. Replacing the tree under a live guest races whatever it is writing, and a frozen guest thaws
   *  into a directory that changed underneath it. An environment with no envelope at all is a Site being
   *  created, which is precisely when the seed arrives, and is allowed.
   *
   *  @param {object} spec A Site specification.
   *  @param {'import'|'export'} operation
   *  @param {string} archivePath The archive to read, or the one to create; an export never overwrites. */
  async siteDataArchive(spec, operation, archivePath) {
    this.#machine(spec);
    if (spec.resource.kind !== 'site') throw new Error('Sites data authority is required');
    if (operation !== 'import' && operation !== 'export') throw new Error('Invalid Site data archive operation');
    const component = spec.disk.components.find((entry) => entry.component === 'data');
    if (!component) throw new Error('This environment has no Site data directory');
    const data = checkedHostPath(component.path);
    const archive = hostPath(archivePath);
    if (operation === 'import') {
      const current = await this.inspect(spec);
      if (current && current.state !== 'stopped') throw new Error(`Stop the machine before importing Site data; it is ${current.state}`);
      checkedHostPath(archive, { file: true });
    } else {
      checkedHostPath(dirname(archive), { create: true });
      if (!absent(archive)) throw new Error('Archive destination already exists');
    }
    // `componentGeneration` is the disk record's own field and is sent whenever it carries one: it is the
    // only thing that tells the helper whether this environment's `data` component lives in the disk
    // directory or under `storage/<generation>`, and the helper accepts exactly the one path it derives
    // from it rather than any directory under the storage root that happens to be called `data`.
    await this.#helper('site-data-archive', { kind: spec.resource.kind, resource: String(spec.resource.id),
      diskId: spec.disk.id, operation, dataPath: data, archivePath: archive,
      ...(spec.disk.componentGeneration === undefined ? {} : { componentGeneration: spec.disk.componentGeneration }) },
    { timeoutMs: 15 * 60_000 });
  }
}
