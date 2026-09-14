import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, posix } from 'node:path';
import { manageWorktrees } from './managedWorktrees.mjs';
import { createGuestFileTransport, validateUploadOperation, UPLOAD_KINDS } from './guestFileTransport.mjs';
import { managedShellFrame, synchronousShellFrame } from './managedBootstrap.mjs';
import { createEnvironmentStore, hostOperationView, isRequestId, operationView, OPERATION_HISTORY } from './environmentDb.mjs';
import { ownerProvablyDead, processIdentity, withRepoLease } from './db.mjs';
import { createContainerSpec, createEnvironmentDiskSpec, withContainerLimits, normalizeEnvironmentNetwork, resourceToken, bindContainerIdentity, publicationRuntimeToken } from './containerSpec.mjs';
import { managedGuestRoot } from './containerPaths.mjs';
import { NspawnClient } from './nspawn.mjs';
import { selectRuntimeClient, unsupportedRuntime, UNSUPPORTED_RUNTIME_MESSAGE, usesNspawnRuntime } from './runtimeClient.mjs';
import { ContainerStorage } from './containerStorage.mjs';
import { RootfsArtifactStore } from './rootfsArtifacts.mjs';
import { ARTIFACT_MIRROR_SETTING, PROJECT_ARTIFACT, artifactReference, isLegacyImageReference, knownReferences } from './rootfsCatalog.mjs';

const FILE_HELPER = readFileSync(new URL('./guestFiles.py', import.meta.url), 'utf8');
const PREVIEW_HELPER = readFileSync(new URL('./previewProxy.py', import.meta.url), 'utf8');
/** The published root filesystem every NEW managed Project is built from. An environment that already
 *  exists keeps whatever its row was stamped with, exactly as it kept its image tag before: the value is
 *  inside the specification hash and inside the machine's own identity record, so rewriting it under a
 *  live environment would make it unownable. */
const PROJECT_ROOTFS = artifactReference(PROJECT_ARTIFACT);
const DEFAULT_LIMITS = { cpus: 1, memoryMb: 1024, pidsLimit: 512 };
const DEFAULT_NETWORK = Object.freeze({ mode: 'shared', inboundPorts: [] });
const detectedCpuModel = () => cpus().find((cpu) => cpu.model.trim())?.model.trim().slice(0, 160) || null;
const LIMIT_KEYS = Object.keys(DEFAULT_LIMITS);
const HOST_KIND = 'host';
const HOST_RESOURCE = 'nspawn';
/** What each lifecycle operation is made of, in order, with the relative cost of each part. The list is
 *  DECLARED before the work starts, so a surface watching an operation can say "step 2 of 5" from the
 *  first frame instead of discovering the shape as it goes. The weights are rough durations rather than
 *  shares of a bar: building or pulling the base image dominates a first start by an order of magnitude,
 *  and giving it the same fifth as "write the row" would leave the bar at 20% for ten minutes. */
const STEP_PLANS = {
  start: [['image', 10], ['storage', 1], ['container', 2], ['boot', 2], ['ready', 2], ['initialize', 1]],
  recreate: [['remove', 2], ['image', 10], ['storage', 1], ['container', 2], ['boot', 2], ['ready', 2], ['initialize', 1]],
  restart: [['quiesce', 1], ['stop', 2], ['image', 10], ['storage', 1], ['container', 2], ['boot', 2], ['ready', 2], ['initialize', 1]],
  stop: [['quiesce', 1], ['stop', 2]],
  snapshot: [['quiesce', 1], ['capture', 8], ['record', 1]],
  restore: [['quiesce', 1], ['stop', 2], ['import', 8], ['container', 2], ['boot', 2], ['switch', 1], ['cleanup', 1]],
  limits: [['apply', 1]],
  network: [['quiesce', 1], ['stop', 2], ['apply', 1], ['boot', 2]],
  delete: [['stop', 2], ['containers', 2], ['storage', 2], ['records', 1]],
};
/** The file operations that CHANGE the tree. They need write authority and they serialize against each
 *  other; everything else observes and does neither. One list, because a kind that counted as a mutation
 *  for permissions but not for serialization — or the reverse — is exactly the sort of drift that turns
 *  into a data race nobody can see in a diff. */
const MUTATING_FILE_KINDS = new Set(['write', 'remove', 'mkdir', 'rename', ...UPLOAD_KINDS]);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A publication's socket is named after the publication alone — not after an execution — because it is
 *  established again after a container restart and the same one has to be found. */
export const publicationSocketName = (publicationId) => `pub-${publicationRuntimeToken(publicationId)}.sock`;
const error = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const protocolError = (message) => error('guest_protocol', message, 500);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function positive(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw error('invalid_input', `Invalid ${label}`, 400);
  return value;
}
function limits(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).some((key) => !Object.hasOwn(DEFAULT_LIMITS, key))) throw error('invalid_limits', 'Invalid environment limits', 400);
  const result = { ...DEFAULT_LIMITS, ...value };
  if (!Number.isFinite(result.cpus) || result.cpus <= 0 || result.cpus > 1024) throw error('invalid_limits', 'Invalid CPU limit', 400);
  for (const key of ['memoryMb', 'pidsLimit']) positive(result[key], key);
  return result;
}
function effectiveLimits(value) {
  const chosen = {};
  for (const key of LIMIT_KEYS) if (value?.[key] !== undefined) chosen[key] = value[key];
  return limits(chosen);
}
/** The limits a project environment is provisioned with, from the administrator's plugin settings.
 *  An unset or unusable field falls back to the built-in figure per key, so a single bad value cannot
 *  leave a new environment without a ceiling. Read once per provisioning; the settings snapshot refreshes
 *  when the plugin reloads, and environments that already exist keep the limits they were created with. */
function configuredDefaults(config) {
  const keys = { cpus: 'defaultCpus', memoryMb: 'defaultMemoryMb', pidsLimit: 'defaultPidsLimit' };
  const chosen = {};
  for (const [key, setting] of Object.entries(keys)) {
    const value = config?.[setting];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) chosen[key] = value;
  }
  try { return limits(chosen); }
  catch { return { ...DEFAULT_LIMITS }; }
}
function network(value) {
  try { return normalizeEnvironmentNetwork(value); }
  catch (cause) { throw error('invalid_network', cause.message, 400); }
}
function effectiveNetwork(record) {
  try { return network(record?.input?.network); }
  catch { return { ...DEFAULT_NETWORK, inboundPorts: [] }; }
}
function configuredNetwork(config) {
  return config?.defaultNetworkMode === 'isolated'
    ? { mode: 'isolated', inboundPorts: [] }
    : { mode: 'shared', inboundPorts: [] };
}
function action(value) {
  if (!value || typeof value !== 'object') throw error('invalid_action', 'An environment action is required', 400);
  const fields = { start: [], stop: [], restart: [], recreate: [], delete: [], snapshot: ['note', 'includeData'],
    restore: ['snapshotId', 'restoreData'], limits: ['limits'], network: ['network'] };
  if (value.snapshotId !== undefined && (typeof value.snapshotId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.snapshotId))) throw error('invalid_action', 'Invalid retained snapshot identity', 400);
  if (!Object.hasOwn(fields, value.kind) || Object.keys(value).some((key) => key !== 'kind' && !fields[value.kind].includes(key))) throw error('invalid_action', 'Invalid environment action', 400);
  if (value.kind === 'snapshot' && value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 2000)) throw error('invalid_action', 'Snapshot note exceeds its bound', 400);
  for (const key of ['includeData', 'restoreData']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw error('invalid_action', 'Invalid data policy', 400);
  if (value.includeData === false || value.restoreData === false) throw error('invalid_action', 'Project snapshots and restores require every component', 400);
  if (fields[value.kind].includes('snapshotId') && typeof value.snapshotId !== 'string') throw error('invalid_action', 'Missing snapshotId', 400);
  if (value.kind === 'limits') return { kind: 'limits', limits: limits(value.limits) };
  if (value.kind === 'network') return { kind: 'network', network: network(value.network) };
  return { ...value };
}
function guestPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || value.length > 4096) throw error('invalid_path', 'An absolute guest path is required', 400);
  return posix.normalize(value);
}
// `synchronous` is a PARAMETER, not a field of `input`, so that no caller reaching this through the
// public control surface can flip it and hand a duplex consumer a shell that swallows its first frames.
function command(input, synchronous = false) {
  // `bash -s` would read the script off stdin with a buffered reader and take whatever followed it in
  // the same write — which for a duplex consumer (a language server, a CDP client) is its first protocol
  // frames. The bootstrap reads exactly the declared number of bytes, execs bash on them, and leaves the
  // rest of stdin untouched for the program.
  if (input?.type === 'shell' && typeof input.command === 'string' && Buffer.byteLength(input.command) <= 524288) {
    // A SYNCHRONOUS caller sends a script on stdin and reads the result; there is no duplex consumer
    // behind it and therefore nothing after the script for a buffered reader to swallow. `bash -s` is
    // then the whole mechanism, and it is already the canonical managed shell that completion capture
    // requires — so this drops a Python interpreter start-up from every such execution without adding a
    // shape the rest of the runtime does not already use. Everything else the frame protected is
    // untouched: the byte bound above, the input validation and NUL rules in the client, the guest path
    // check on the working directory, the timeout, the exit code and the output sanitizer.
    const frame = synchronous ? synchronousShellFrame(input.command) : managedShellFrame(input.command);
    return { argv: frame.argv, input: frame.stdin };
  }
  if (input?.type === 'argv' && typeof input.file === 'string' && Array.isArray(input.args)) {
    // PATH resolution is performed inside the guest, never by the host launcher.
    return { argv: input.file.startsWith('/') ? [input.file, ...input.args] : ['/usr/bin/env', '--', input.file, ...input.args] };
  }
  throw error('invalid_command', 'Invalid managed execution command', 400);
}
/** How each guest file operation may spell `expectedVersion`, mirroring the `GuestFileOperation` union in
 *  `src/plugins/environmentTypes.ts` — the single declaration of the guest compare-and-swap contract.
 *
 *  `null` is NOT a missing version. It is the CREATE-ONLY swap, which `expected()` in `guestFiles.py`
 *  answers by refusing the write unless the destination is absent, and it is what every managed consumer
 *  sends for a file that does not exist yet: Write and Edit through `plugins/files/managed.mjs`, the MCP
 *  and terminal image writers, and `writeGuestFile` in `src/brain/managedArtifacts.ts`, whose default it
 *  is. Holding every kind to "a string, or omitted" made this the one validator that refused it, while
 *  `validateUploadOperation` accepted the same value on the chunked path and the guest implemented it. So
 *  creating any file through the single-write path was rejected here, with a 400, before the guest ever
 *  saw it — and because that rejection described the REQUEST rather than the destination, repeating it
 *  produced the same answer every time.
 *
 *  `remove` and `rename` stay string-only: an absent file has no version to swap against. `read` may omit
 *  the field, and an explicit `undefined` counts as omitted everywhere — JSON would drop it on the way to
 *  the guest, which would then read the absent key as the create-only swap nobody asked for.
 *
 *  A Map, not an object, for the reason spelled out in `guestFileTransport.mjs`: an object lookup answers
 *  for every key on `Object.prototype`, so a kind named `constructor` or `toString` would find a "rule". */
const VERSION_RULES = new Map(Object.entries({ read: 'optional', write: 'nullable', remove: 'string', rename: 'string' }));
function versionSwap(op) {
  const rule = VERSION_RULES.get(op.kind);
  if (op.expectedVersion === undefined) {
    if (rule && rule !== 'optional') throw error('version_required', 'A content version is required', 400);
    return;
  }
  const valid = op.expectedVersion === null
    ? rule === 'nullable'
    : Boolean(rule) && typeof op.expectedVersion === 'string' && op.expectedVersion.length <= 256;
  if (!valid) throw error('invalid_operation', 'Invalid expected file version', 400);
}
function fileOperation(op) {
  if (UPLOAD_KINDS.includes(op?.kind)) return validateUploadOperation(op);
  const keys = { stat: ['followSymlinks'], list: ['limit', 'cursor', 'metadata'], read: ['maxBytes', 'offset', 'length', 'expectedVersion'], write: ['base64', 'expectedVersion'], remove: ['expectedVersion'], mkdir: [], rename: ['destination', 'expectedVersion'], walk: ['limit', 'skip', 'maxDepth'], search: ['pattern', 'glob', 'caseSensitive', 'limit'] };
  if (op?.followSymlinks !== undefined && typeof op.followSymlinks !== 'boolean') throw error('invalid_operation', 'followSymlinks must be boolean', 400);
  if (!op || !Object.hasOwn(keys, op.kind) || Object.keys(op).some((key) => !['kind', 'path', 'root', ...keys[op.kind]].includes(key))) throw error('invalid_operation', 'Invalid guest file operation', 400);
  guestPath(op.path);
  if (op.root !== undefined) guestPath(op.root);
  versionSwap(op);
  if (op.kind === 'rename') guestPath(op.destination);
  if (Buffer.byteLength(JSON.stringify(op)) > 1024 * 1024) throw error('input_limit', 'Guest input exceeds its bound', 400);
  return op;
}

/** One coordinator for managed Project environments. Forks only write durable intents and execute
 * already-running validated targets. Only daemon reconciliation performs machine lifecycle changes. */
export function createEnvironmentRuntime({ ctx, db, dataDir, namespace = 'elowen',
  artifacts = new RootfsArtifactStore({ dataDir, logger: ctx.logger, ...(ctx.config?.[ARTIFACT_MIRROR_SETTING] ? { baseUrl: ctx.config[ARTIFACT_MIRROR_SETTING] } : {}) }),
  nspawn = new NspawnClient({ artifacts, namespace, outputLimitBytes: 16 * 1024 * 1024 }),
  storage = new ContainerStorage(nspawn), cpuModel = detectedCpuModel(), daemon = typeof process.send !== 'function' }) {
  const store = createEnvironmentStore(db, processIdentity);
  const hostCpuModel = typeof cpuModel === 'string' && cpuModel.trim() ? cpuModel.trim().slice(0, 160) : null;
  const RESOURCE_USAGE_TTL_MS = 25_000;
  /** One promise may refresh several rows, and every row key points at that same promise. The key includes
   * the durable invalidation epoch, so lifecycle movement admits a new refresh without joining obsolete work. */
  const resourceRefreshes = new Map();
  const resourceRefreshFailures = new Map();
  const resourceKey = (row) => `${row.kind}:${row.resource_id}:${row.generation}:${row.resource_refresh_epoch}`;
  /** Which runtime drives THIS specification. The disk record is the only discriminator, and a row whose
   *  disk does not name this runtime is refused by name rather than adopted. */
  const runtimeFor = (spec) => selectRuntimeClient(spec, { nspawn });
  /** Whether anything has ever been built for this environment.
   *
   *  A row is inserted the moment somebody LOOKS at a project, and the runtime it will use is decided at
   *  the first start, because deciding it needs a privileged readiness round trip that a read must not
   *  make. Until then the disk record names no runtime — which is exactly the shape `runtimeFor` refuses.
   *  Stopping or deleting such a row must therefore ask the runtime nothing: no machine was created, no
   *  disk was materialized and no storage directory exists. Reaching for a client here is what made a
   *  never-started environment impossible to delete. */
  const neverMaterialized = (row) => row.spec.runtimePending === true;
  /** What the host still owes the machine runtime, held briefly because two very different callers ask:
   *  the overview a browser polls, and the one-time decision below. The answer is a privileged round trip
   *  and it changes only when an operator changes the host, so a few seconds of staleness costs nothing —
   *  and the helper re-checks its own gates when an envelope is actually written, so a stale `ready` can
   *  delay a refusal but never turn one into a success. */
  const HOST_READINESS_TTL_MS = 15_000;
  let readinessCache = null;
  /** Answers are ordered by when their probe STARTED, never by when one happened to arrive. Every
   *  observation of the host takes the next position before it leaves, and only a position newer than the
   *  one already recorded may write the cache. Probes overlap in normal operation — the ten-second poll
   *  meeting a start's fresh probe, or a whole provisioning run — and without this the slower probe would
   *  win: a sweep that began before the host was prepared could record its stale refusal over the `ready`
   *  the preparation had just established, and every later reader would see that refusal for a full TTL. */
  let readinessProbe = 0;
  let readinessRecorded = 0;
  const nextReadinessProbe = () => ++readinessProbe;
  function recordReadiness(probe, value) {
    if (probe <= readinessRecorded) return;
    readinessRecorded = probe;
    readinessCache = { at: Date.now(), value };
  }
  /** Forget the answer AND retire every probe already in flight: each of them describes a host that has
   *  been changed since, so none of them may be recorded any more. */
  function invalidateReadiness() {
    readinessCache = null;
    readinessRecorded = ++readinessProbe;
  }
  /** `fresh` is for the ONE caller that must not reuse the cached answer: a start, which turns a network
   *  link on and therefore depends on the host's forwarding and firewall rows as they are NOW — a rule can
   *  be flushed between two sweeps, and a cached `ready` would then start a machine onto a link the host no
   *  longer isolates. A fresh probe deliberately does NOT write the cache: the TTL above is the overview's,
   *  and a privileged round trip taken for a start has no business reordering the polled answer. */
  async function hostReadiness(fresh = false) {
    if (!nspawn || typeof nspawn.hostReadiness !== 'function') {
      return { ready: false, items: [{ id: 'runtime:machine', label: 'Machine runtime', ok: false, detail: 'this runtime has no machine client' }] };
    }
    if (!fresh && readinessCache && Date.now() - readinessCache.at < HOST_READINESS_TTL_MS) return readinessCache.value;
    const probe = nextReadinessProbe();
    const value = await nspawn.hostReadiness();
    if (!fresh) recordReadiness(probe, value);
    return value;
  }
  /** What a start that turns a network link ON has to be able to prove first.
   *
   *  A machine given a virtual ethernet is only isolated while the host's forwarding, link and firewall
   *  rows are in place, and the privileged side is the only thing that knows which rows those are — so the
   *  gate is the helper's OWN conjunctive verdict on a fresh probe rather than a list of row ids matched
   *  here, which would be a second source of truth for a naming the helper owns. It refuses by quoting the
   *  unmet rows back, exactly as the creation-time decision does.
   *
   *  An isolated environment is asked nothing: it gets no link, so none of those rows are its to depend on.
   *  Both shapes a start can take — booting a machine and thawing a paused one — pass through this gate
   *  inside `startRow`, which is the ONLY place a start is gated: automatic recovery, which runs operations
   *  through the same `perform`, cannot bring a networked machine up on a host that has lost its firewall.
   *  Stopping is deliberately NOT gated: an environment that is already up has to stay stoppable on a host
   *  that is not ready, and `stopRow` thaws only in order to take the machine down. */
  async function assertNetworkedStartAllowed(row) {
    if (effectiveNetwork(row.spec).mode === 'isolated') return;
    const readiness = await hostReadiness(true);
    if (!readiness.ready) throw error('runtime_not_ready', `This host cannot start a networked environment — ${readinessRefusal(readiness)}`);
  }
  /** How many non-deleted environments belong to a runtime this release cannot drive.
   *
   *  One query over the stored specifications and nothing else: a disk is never opened to answer it,
   *  because this is polled. The same predicate selects the actual runtime client, so historical rootfs
   *  provenance cannot make readiness disagree with the environment's persisted owner. */
  function legacyReferenceRow() {
    const stored = db.prepare("SELECT spec_json FROM p_sandbox_runtimes WHERE kind='project' AND state<>'deleted'").all();
    const pending = stored.filter((entry) => !usesNspawnRuntime(JSON.parse(entry.spec_json).input)).length;
    return { id: 'runtime:legacy-references', label: 'Environment runtime ownership', ok: pending === 0,
      detail: pending === 0
        ? 'every environment belongs to systemd-nspawn'
        : `${pending} environment${pending === 1 ? '' : 's'} still ${pending === 1 ? 'belongs' : 'belong'} to the removed Podman runtime. ${UNSUPPORTED_RUNTIME_MESSAGE}` };
  }
  const readinessArea = (id) => {
    if (id.startsWith('package:')) return 'package';
    if (id.startsWith('polkit:')) return 'polkit';
    if (id.startsWith('firewall:') || id.startsWith('sysctl:') || id.startsWith('resolver:') || id === 'service:systemd-networkd') return 'firewall';
    if (id.startsWith('unit:') || id.startsWith('service:')) return 'systemd';
    return 'helper';
  };
  function artifactReadinessRows() {
    return knownReferences().map((reference) => {
      const status = artifacts.status(reference);
      return { id: `rootfs:${reference}`, area: 'rootfs', label: reference, ok: status.published,
        detail: status.published ? (status.present ? 'published and present on this host' : 'published; downloaded on first use') : 'no published copy is pinned', ...status };
    });
  }
  /** The complete administrator-facing host report. `ready` requires host support and published artifacts;
   *  `prepared` additionally means every verified archive is already local. Legacy rows remain informational
   *  because one old environment must not block creation of an unrelated new one. */
  async function machineReadiness() {
    let host;
    try { host = await hostReadiness(); }
    catch (cause) {
      host = { ready: false, items: [{ id: 'helper:transport', label: 'Privileged machine helper', ok: false, detail: cause.message }] };
    }
    const hostRows = host.items.map((item) => ({ area: readinessArea(item.id), ...item }));
    const rootfs = artifactReadinessRows();
    const latest = store.recentOperations(HOST_KIND, HOST_RESOURCE, 1)[0];
    const ready = host.ready && rootfs.every((item) => item.published);
    const requirements = [...hostRows, ...rootfs, { area: 'runtime', ...legacyReferenceRow() }];
    return { runtime: HOST_RESOURCE, ready, prepared: ready && rootfs.every((item) => item.present), requirements, items: requirements,
      operation: latest ? hostOperationView(latest) : null };
  }
  async function environmentRuntimeReadiness(reference) {
    const host = await hostReadiness();
    const artifact = artifacts.status(reference);
    const items = [...host.items, { id: `rootfs:${reference}`, label: reference, ok: artifact.published,
      detail: artifact.published ? 'published root filesystem' : 'no published copy is pinned', ...artifact }, legacyReferenceRow()];
    return { ready: host.ready && artifact.published, items };
  }
  const readinessRefusal = (readiness) => (readiness.items ?? readiness.requirements).filter((item) => !item.ok)
    .map((item) => `${item.label}: ${item.detail ?? 'not satisfied'}`).join('; ');
  /** Queue the one typed host provisioning operation. The durable row is the idempotency and progress
   *  boundary; daemon reconciliation rechecks the administrator before touching the host. */
  async function provisionMachineRuntime(input) {
    account(input.accountUserId, true);
    if (!stores().usersRead.isAdmin(input.accountUserId)) throw error('admin_required', 'Only administrators may prepare the host for the machine runtime', 403);
    if (!input.action || input.action.kind !== 'provision' || Object.keys(input.action).length !== 1) throw error('invalid_action', 'The provision action is required', 400);
    if (input.requestId !== undefined && !isRequestId(input.requestId)) throw error('invalid_request_id', 'Invalid idempotency key', 400);
    return store.transaction(() => {
      account(input.accountUserId, true);
      if (!stores().usersRead.isAdmin(input.accountUserId)) throw error('admin_required', 'Administrator authority was revoked', 403);
      const prior = input.requestId ? store.prior(HOST_KIND, HOST_RESOURCE, input.accountUserId, input.requestId) : null;
      if (prior && !same(prior.action, input.action)) throw error('request_conflict', 'Idempotency key belongs to another action');
      if (prior && prior.status !== 'failed') return hostOperationView(prior);
      const active = store.active(HOST_KIND, HOST_RESOURCE);
      if (prior) {
        if (active) throw error('environment_busy', 'Host provisioning is already pending');
        prior.status = 'pending'; prior.error = null; delete prior.checkpoint.errorCode; store.saveOperation(prior);
        return hostOperationView(prior);
      }
      if (active) return hostOperationView(active);
      const op = store.enqueueHost(input.accountUserId, { kind: 'provision' }, input.requestId);
      declareSteps(op); store.saveOperation(op);
      return hostOperationView(op);
    });
  }
  /** Which runtime a NEW environment is built on, decided once, here, and nowhere else.
   *
   *  There is no configuration flag and no per-environment choice. A host that can hold a machine holds
   *  every environment created from now on; a host that cannot refuses the creation and names what is
   *  missing. Falling back to a container instead would leave two runtimes in service on one host for a
   *  reason nobody recorded, which is the exact ambiguity `disk.runtime` exists to prevent.
   *
   *  It runs at the moment the disk is about to be materialized, not when the row was inserted: a row is
   *  created by merely LOOKING at a project, and a look must not reach for a privileged round trip. An
   *  environment that already has a disk never reaches here — its runtime is its disk record's, and no
   *  readiness answer can move it. */
  async function decideRuntime(row) {
    if (!row.spec.runtimePending) return;
    const readiness = await environmentRuntimeReadiness(row.spec.input.disk.sourceImage);
    if (!readiness.ready) throw error('runtime_not_ready', `This host cannot run an environment yet — ${readinessRefusal(readiness)}`);
    const disk = row.spec.input.disk;
    row.spec.input.disk = createEnvironmentDiskSpec({ resource: row.spec.input.resource, image: disk.sourceImage, runtime: 'nspawn' },
      row.spec.paths, disk.id, disk.componentGeneration);
    delete row.spec.runtimePending;
    store.save(row);
    store.log(row.kind, row.resource_id, 'environment will run on the machine runtime');
  }
  const transfers = createGuestFileTransport({ db, helperSource: FILE_HELPER, runGuest,
    runCleanup: async (row, _userId, argv, options) => {
      const current = store.get(row.kind, row.resource_id);
      if (!current || current.generation !== row.generation) throw error('generation_changed', 'Upload cleanup generation changed');
      const spec = specFor(row.spec);
      if ((await runtimeFor(spec).inspect(spec))?.state !== 'running') throw error('upload_cleanup_pending', 'Start the environment to clean up its unfinished uploads');
      return await runtimeFor(spec).exec(spec, randomUUID().replaceAll('-', ''), argv, { ...options, persistent: true });
    },
  });
  let disposed = false;
  const AUTO_RECOVERY_DELAYS_MS = [0, 30_000, 120_000, 600_000];
  // Longer than every retry delay, so a container that dies when attempt four becomes eligible cannot be
  // mistaken for one that completed a genuinely stable run.
  const AUTO_RECOVERY_STABILITY_MS = 15 * 60_000;
  /** The sweep this generation is running, or null. It settles when that sweep ends — never with a
   *  failure, so a caller that merely waits for it cannot raise an unhandled rejection — and it is what
   *  `dispose` waits on: a sweep can be part-way through a machine start or stop, and the next generation
   *  must not run one of its own while this one is still touching the host. */
  let reconcileInFlight = null;
  const releasingAdoptions = new Set();
  const previews = new Set();
  const publicationMutations = new Map();
  const publicationRecoveryStates = new Map();
  const legacySiteRetirementErrors = new Map();
  /** Names the machine inventory reports and the envelope cannot prove, by environment: the standing
   *  condition is reported once and again only when the reason changes, exactly as a legacy Site machine
   *  that will not retire is. */
  const unownedNameReports = new Map();
  const stores = () => ctx.host.stores();
  const account = (id, writable = false) => {
    assertLive();
    positive(id, 'account');
    const ambient = ctx.currentAccountUserId();
    if (ambient !== null && ambient !== undefined && ambient !== id) throw error('actor_mismatch', 'The acting account does not match the current actor', 403);
    if (!stores().usersRead.list().some((user) => user.id === id) || !stores().usersRead.mayUsePlugin(id, 'sandbox')) throw error('account_forbidden', 'Account access is unavailable', 403);
    if (writable && ctx.currentAccess().readOnly) throw error('read_only', 'A read-only turn cannot modify an environment', 403);
  };
  const projectId = (ref) => {
    if (ref?.kind !== 'managed' || Object.keys(ref).some((key) => !['kind', 'projectId'].includes(key))) throw error('managed_required', 'An explicit managed Project is required', 400);
    return positive(ref.projectId, 'project');
  };
  async function authorize(id, userId, manage = false, internal = false) {
    if (!internal) account(userId);
    else if (!stores().usersRead.list().some((user) => user.id === userId) || !stores().usersRead.mayUsePlugin(userId, 'sandbox')) throw error('account_forbidden', 'Account access is unavailable', 403);
    const scope = ctx.currentAccess();
    // The narrowing below is a TURN's: a selected Project and the policy's project list. An authenticated
    // API request has neither, so `apiRequest` is the host's positive marker for that scope. Membership is
    // resolved again below so revocation still refuses the operation.
    if (!internal && !scope.apiRequest && ctx.currentAccountUserId() != null && ((scope.projectRef && scope.projectRef.projectId !== Number(id)) || (!scope.admin && scope.projectIds && !scope.projectIds.includes(Number(id))))) throw error('project_scope', 'Project is outside the current turn scope', 403);
    const project = stores().projects.get(Number(id));
    if (!project || project.executionKind !== 'managed' || !(manage ? stores().userProjects.canManage(userId, project.id) : stores().userProjects.canAccess(userId, project.id))) throw error('project_forbidden', 'Project access is denied', 403);
    return project;
  }
  /** Where this project is mounted inside its own container — persisted with the row, so renaming the
   *  project later cannot silently change a running container's identity. */
  const rootOf = (row) => row.spec.input.workspaceTarget;
  function specFor(record) {
    const input = { ...record.input, limits: record.creationLimits ?? record.input.limits };
    const base = createContainerSpec(input, record.paths);
    const spec = same(input.limits, record.input.limits) ? base : withContainerLimits(base, record.input.limits);
    return record.containerId ? bindContainerIdentity(spec, record.containerId) : spec;
  }
  async function rowFor(id, userId, manage = false, internal = false) {
    const authority = await authorize(id, userId, manage, internal);
    let row = store.get('project', id);
    if (row && !row.spec.input.workspaceTarget) {
      // A row built against `/workspace` predates the named project mount, and therefore predates this
      // runtime entirely: its envelope was hashed from a specification this release no longer produces.
      // Filling the mount point in would silently rewrite that identity, so the row is named and refused.
      throw unsupportedRuntime();
    }
    if (!row) {
      const effective = configuredDefaults(ctx.config);
      const paths = { sandboxDataDir: dataDir, namespace };
      const resource = { kind: 'project', id: Number(id) };
      const disk = createEnvironmentDiskSpec({ resource, image: PROJECT_ROOTFS }, paths, randomUUID().replaceAll('-', ''));
      // Nothing is materialized yet, so the runtime is still open. `decideRuntime` closes it at the first
      // start; until then the disk record carries no runtime, which is what keeps the serialization of a
      // row that never starts identical to the rows written before the runtime became explicit.
      const spec = { input: { resource, generation: 1, image: PROJECT_ROOTFS, disk, previewBroker: true, workspaceTarget: managedGuestRoot(authority.slug, Number(id)), limits: { cpus: effective.cpus, memoryMb: effective.memoryMb, pidsLimit: effective.pidsLimit }, network: configuredNetwork(ctx.config) }, paths, runtimePending: true };
      row = store.insert('project', id, Number(id), spec, effective);
    }
    return row;
  }
  /** Which runtime this environment runs on, and — only while that is still open — what the host would
   *  have to satisfy before it can be created at all.
   *
   *  An environment that already has a disk reports its runtime and nothing else: the readiness rows
   *  describe a decision that was made once and cannot be revisited, so showing them beside a running
   *  environment would invite someone to act on them. A probe that fails is REPORTED as an unmet row
   *  rather than failing the read: this is the overview a browser polls, and the reason the probe failed
   *  is the same thing the operator needs to see. */
  async function runtimeView(row) {
    const decided = row?.spec?.input?.disk;
    if (decided && !row.spec.runtimePending) return { name: decided.runtime ?? null, pending: false, readiness: null };
    if (row && !row.spec.runtimePending) return { name: null, pending: false, readiness: null };
    let readiness;
    try { readiness = await environmentRuntimeReadiness(row?.spec?.input?.disk?.sourceImage ?? PROJECT_ROOTFS); }
    catch (cause) {
      readiness = { ready: false, items: [{ id: 'runtime:machine', label: 'Machine runtime', ok: false, detail: cause.message }] };
    }
    return { name: readiness.ready ? 'nspawn' : null, pending: true, readiness };
  }

  const view = (row) => ({ projectId: Number(row.resource_id), generation: row.generation, state: row.state,
    desiredState: row.desired_state, lastError: row.error ?? null, limits: effectiveLimits(row.limits), network: effectiveNetwork(row.spec) });
  /** EnvironmentStatus is a readiness report, not only a process-liveness report. A migrated guest can
   *  keep systemd running while host0 is DOWN because networkd stayed disabled, so surface that standing
   *  defect without rewriting durable lifecycle state from a read. */
  async function environmentView(row) {
    const result = view(row);
    if (result.state !== 'running' || result.network.mode === 'isolated' || !usesNspawnRuntime(row.spec.input)) return result;
    try {
      const spec = specFor(row.spec);
      const runtime = runtimeFor(spec);
      if (typeof runtime.networkReadiness !== 'function') return result;
      const network = await runtime.networkReadiness(spec);
      if (network.ready) return result;
      return { ...result, state: 'failed', lastError: `The guest shared network is not ready — ${network.detail ?? 'host0 has no carrier or address'}` };
    } catch (cause) {
      return { ...result, state: 'failed', lastError: `The guest shared network could not be verified — ${sanitize(cause.message ?? cause)}` };
    }
  }
  const assertGeneration = (row, expected) => { if (expected !== undefined && expected !== row.generation) throw error('generation_changed', 'Environment generation changed'); };

  /** The one place an operation's live state leaves this process. Everything a watcher needs travels in
   *  the event — the operation view and the tail of the same ring buffer the log view reads — so no
   *  surface has to poll the operation endpoint to learn that a step advanced. Publishing is best effort:
   *  a bus that refuses an event must not fail the container work the event was describing. */
  let publishedAt = 0;
  const publishedShape = new Map();
  function publishOperation(op, force = true) {
    if (!ctx.publishEvent) return;
    const now = Date.now();
    // The throttle exists for a build that writes a hundred lines a second, and it must not swallow a
    // frame that SAYS something: a step change, a status change, or the move between a real percentage
    // and an indeterminate one. Only a repeat of what was already published is dropped.
    const shape = `${op.status}|${op.step_index}|${op.percent === null}`;
    if (!force && now - publishedAt < 250 && publishedShape.get(op.id) === shape) return;
    if (['succeeded', 'failed'].includes(op.status)) publishedShape.delete(op.id);
    else publishedShape.set(op.id, shape);
    publishedAt = now;
    try {
      ctx.publishEvent({ type: 'plugin', plugin: 'sandbox', kind: 'environment-operation',
        projectId: op.kind === 'project' ? Number(op.resource_id) : null,
        data: { operation: op.kind === HOST_KIND ? hostOperationView(op) : operationView(op), logTail: store.logTail(op.kind, op.resource_id, 40) } });
    } catch (cause) { ctx.logger.warn(`environment operation progress was not published: ${cause.message}`); }
  }
  const checkpoint = (op, values) => { Object.assign(op.checkpoint, values); store.saveOperation(op); publishOperation(op, false); };
  const stepPlan = (op) => (op.kind === HOST_KIND
    ? [['host', 2], ...knownReferences().map((reference) => [`rootfs:${reference}`, 10]), ['verify', 1]]
    : STEP_PLANS[op.action?.kind]);
  const declareSteps = (op) => { op.steps = stepPlan(op).map(([id]) => id); op.step_index = 0; op.percent = 0; };
  /** Declare the step list on the durable row as the operation is claimed. An operation RESUMED after a
   *  restart already declared it and reached a position its checkpoints kept, so only one that never
   *  declared any starts at zero — otherwise the bar would fall back to the beginning for work that is
   *  not going to be done again. */
  function beginSteps(op) {
    if (!op.steps?.length) declareSteps(op);
    store.saveOperation(op);
    publishOperation(op);
  }
  /** Enter a declared step. `fraction` is progress WITHIN it: a number when the work reports one, and
   *  `null` when it does not — which is what leaves the bar indeterminate instead of inventing a figure. */
  function step(op, id, fraction = 0, streamed = false) {
    const plan = stepPlan(op);
    const index = plan.findIndex(([name]) => name === id);
    if (index < 0) return;
    const total = plan.reduce((sum, [, weight]) => sum + weight, 0);
    const done = plan.slice(0, index).reduce((sum, [, weight]) => sum + weight, 0);
    const inside = fraction === null ? null : plan[index][1] * Math.max(0, Math.min(1, fraction));
    op.steps = plan.map(([name]) => name);
    op.step_index = index;
    op.percent = inside === null ? null : Math.round(((done + inside) / total) * 1000) / 10;
    store.saveOperation(op);
    publishOperation(op, !streamed);
  }
  const assertLive = () => { if (disposed) throw error('runtime_unavailable', 'The environment provider was detached', 503); };
  /** The host's storage root is not a project member's business, in a lifecycle error or a build line any
   *  more than in command output — where `prepareExecution` has always replaced it. One replacement,
   *  applied wherever host text becomes something a surface displays. */
  const sanitize = (text) => String(text).split(dataDir).join('[environment-storage]');

  async function assertNoPublishedSites(id) {
    if (store.publications(Number(id)).length) throw error('published_sites_exist', 'Transfer or delete this Project\'s published Sites before deleting the Project');
  }

  function assertNetworkPortsAvailable(id, requested) {
    const wanted = new Set(requested.inboundPorts.map((port) => `${port.protocol}:${port.hostPort}`));
    if (!wanted.size) return;
    for (const row of store.all().filter((entry) => entry.kind === 'project' && Number(entry.resource_id) !== Number(id) && entry.state !== 'deleted')) {
      for (const port of effectiveNetwork(row.spec).inboundPorts) {
        if (wanted.has(`${port.protocol}:${port.hostPort}`)) throw error('network_port_conflict', `${port.protocol.toUpperCase()} host port ${port.hostPort} is already assigned to Project ${row.resource_id}`);
      }
    }
    for (const pending of store.operations().filter((entry) => entry.kind === 'project' && Number(entry.resource_id) !== Number(id) && entry.action.kind === 'network')) {
      for (const port of pending.action.network.inboundPorts) {
        if (wanted.has(`${port.protocol}:${port.hostPort}`)) throw error('network_port_conflict', `${port.protocol.toUpperCase()} host port ${port.hostPort} is already reserved by another pending Project change`);
      }
    }
  }

  async function request(id, input) {
    assertLive();
    account(input.accountUserId, true);
    if (releasingAdoptions.has(Number(id))) throw error('environment_busy', 'An adopted workspace is being released');
    const requested = action(input.action);
    await rowFor(id, input.accountUserId, true);
    if (requested.kind === 'delete') await assertNoPublishedSites(id);
    if (input.requestId !== undefined && !isRequestId(input.requestId)) throw error('invalid_request_id', 'Invalid idempotency key', 400);
    return store.transaction(() => {
      account(input.accountUserId, true);
      if (!stores().userProjects.canManage(input.accountUserId, Number(id))) throw error('project_forbidden', 'Project access was revoked', 403);
      const row = store.get('project', id);
      if (!row) throw error('environment_missing', 'Environment metadata changed');
      let active = store.active('project', id);
      const prior = input.requestId ? store.prior('project', id, input.accountUserId, input.requestId) : null;
      if (prior && !same(prior.action, requested)) throw error('request_conflict', 'Idempotency key belongs to another action');
      if (prior && prior.status !== 'failed') return operationView(prior);
      assertGeneration(row, input.expectedGeneration);
      if (requested.kind === 'limits' && !stores().usersRead.isAdmin(input.accountUserId)) throw error('admin_required', 'Only administrators may change resource limits', 403);
      if (requested.kind === 'network' && !stores().usersRead.isAdmin(input.accountUserId)) throw error('admin_required', 'Only administrators may change environment networking', 403);
      if (requested.kind === 'network') assertNetworkPortsAvailable(id, requested.network);
      if (row.state === 'deleted') throw error('environment_deleted', 'The environment has been deleted');
      if (row.desired_state === 'deleted' && requested.kind !== 'delete') throw error('environment_deleting', 'The environment is deleting');
      if (prior) {
        if (!active) { prior.status = 'pending'; prior.error = null; store.saveOperation(prior); }
        return operationView(prior);
      }
      if (active?.status === 'pending' && active.checkpoint.autoRecovery && ['stop', 'delete'].includes(requested.kind)) {
        active.status = 'failed'; active.error = `Superseded by explicit ${requested.kind}`; store.saveOperation(active); active = null;
      }
      if (active) {
        if (!input.requestId && active.user_id === input.accountUserId && same(active.action, requested)) return operationView(active);
        throw error('environment_busy', 'An environment lifecycle operation is already pending');
      }
      const op = store.enqueue(row, input.accountUserId, requested, input.requestId);
      if (requested.kind === 'delete') {
        if (!stores().projects.beginDeletion(Number(id))) throw error('project_deletion_changed', 'Core Project deletion intent could not be recorded');
        row.desired_state = 'deleted'; row.state = 'deleting';
      }
      else if (['start', 'restart', 'recreate'].includes(requested.kind)) row.desired_state = 'running';
      else if (requested.kind === 'stop') row.desired_state = 'stopped';
      store.save(row);
      declareSteps(op);
      store.saveOperation(op);
      return operationView(op);
    });
  }

  async function getOperation(input) {
    account(input.accountUserId);
    const op = store.getOperation(input.operationId);
    if (!op || op.kind !== 'project') return null;
    if (!(op.action.kind === 'delete' && op.status === 'succeeded' && op.user_id === input.accountUserId)) await authorize(op.resource_id, input.accountUserId, true);
    return { ...operationView(op), logTail: store.logTail(op.kind, op.resource_id, 40) };
  }

  /** `verifyRuntime` false is for a caller whose very next step is a prepared or direct guest execution:
   *  that execution opens with the full ownership and running-state check, so the probe here observed
   *  nothing it would not observe a moment later and cost two runtime invocations to say it. The durable
   *  record checks above still run either way, so a stopped or pending environment is still refused here,
   *  cheaply and without ever reaching the container. */
  async function ready(id, userId, verifyRuntime = true, startIfNeeded = true) {
    let row = await rowFor(id, userId);
    if (row.state === 'unprovisioned' && startIfNeeded) {
      await request(id, { accountUserId: userId, action: { kind: 'start' } });
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        assertLive();
        if (daemon) await reconcile();
        row = await rowFor(id, userId);
        if (!store.active('project', id)) break;
        await wait(100);
      }
    }
    if (store.active('project', id)) throw error('environment_pending', 'Environment lifecycle work is pending; retry after the operation completes', 503);
    if (row.state !== 'running') throw error('environment_stopped', `Environment is ${row.state}; request an explicit start`);
    const current = specFor(row.spec);
    if (verifyRuntime && (await runtimeFor(current).inspect(current))?.state !== 'running') throw error('runtime_unavailable', 'The validated container is not running', 503);
    return row;
  }

  /** The container-level answer to "the record says running but the runtime disagrees", in the wording
   *  and with the 503 that `ready` used to produce from a preflight inspection of its own. The
   *  authoritative ownership check inside the execution reports the same fact one step later and without
   *  a second round trip, so this is where that fact is now named. */
  function runtimeUnavailable(cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!/Container is (missing|not running)/.test(message)) return cause;
    return error('runtime_unavailable', 'The validated container is not running', 503);
  }

  async function mint(row, userId, kind) {
    await authorize(row.resource_id, userId);
    return store.transaction(() => {
      const current = store.get(row.kind, row.resource_id);
      if ((row.kind === 'project' && releasingAdoptions.has(Number(row.resource_id))) || !current || current.generation !== row.generation || current.state !== 'running' || store.active(row.kind, row.resource_id)) throw error('environment_busy', 'Environment changed before execution could be leased');
      const other = store.leases(row.kind, row.resource_id).filter((lease) => lease.kind !== 'preview');
      if (other.some((lease) => lease.kind === 'worktrees') || (kind === 'worktrees' && other.length)) throw error('environment_busy', 'Managed worktree mutation requires an idle execution boundary');
      return store.mintLease(current, userId, kind);
    });
  }
  /** `settle` is the closure the runtime client's `prepareExecution` bound to the execution this lease fences.
   *  Where it is available, the cleanup below reuses the ownership verification that preparation already
   *  performed instead of inspecting the container and every volume again. It is only ever supplied by
   *  the code that prepared the execution; recovery, revocation and cancellation of somebody else's lease
   *  have no such closure and take the fully verified path, which is also the fallback whenever settling
   *  this way does not succeed — a container stopped mid-command is handled there rather than here. */
  function leaseHandle(row, lease, settle = null) {
    const spec = specFor(row.spec);
    let released = false;
    // Settling through the bound closure is an OPTIMIZATION, never the only attempt: a failure here
    // falls through to the fully verified path, which re-inspects and reports properly. It cannot mask a
    // live guest, because that path runs the same termination proof it always did.
    const settled = async (mode) => {
      try { await settle(mode); return true; }
      catch { return false; }
    };
    // Cancelling and releasing the same execution must not interleave, and a release that follows a
    // cancellation must not undo it. A cancellation ends in a runtime MASK — a tombstone that blocks a
    // StartTransientUnit arriving late — while a normal release ends in an unmask, so running one after
    // the other reopened exactly the race the cancellation had just closed and then retired the lease as
    // though everything were in order. The terminal does precisely this: it cancels, then releases the
    // lease in its `finally`.
    let chain = Promise.resolve();
    const serial = (work) => {
      const next = chain.then(work, work);
      chain = next.then(() => {}, () => {});
      return next;
    };
    // The memory of a VERIFIED cancellation has to be durable, not a flag on this object: revocation and
    // recovery cancel through a handle of their own, and the release that follows comes from the handle
    // the caller is holding. `cancel_requested` is that record — 1 once a cancellation is requested, 2
    // once its termination has been proven — and every existing reader tests it for truth, so the second
    // value narrows the meaning without changing any of them.
    const REQUESTED = 1;
    const VERIFIED = 2;
    const mark = (value) => db.prepare('UPDATE p_sandbox_execution_leases SET cancel_requested=? WHERE id=?').run(value, lease.id);
    const cancellation = () => db.prepare('SELECT cancel_requested FROM p_sandbox_execution_leases WHERE id=?').get(lease.id)?.cancel_requested ?? 0;
    const retire = () => {
      db.prepare('DELETE FROM p_sandbox_execution_leases WHERE id=? AND execution_id=?').run(lease.id, lease.execution_id);
      released = true;
    };
    return {
      id: lease.id, accountUserId: lease.user_id, homeGeneration: null,
      projectId: row.project_id, runtimeGeneration: row.generation,
      async heartbeat() {
        if (released) return;
        try { await authorize(row.resource_id, lease.user_id); }
        catch (cause) { await this.cancel(); throw cause; }
        const current = db.prepare('SELECT cancel_requested FROM p_sandbox_execution_leases WHERE id=?').get(lease.id);
        if (!current || current.cancel_requested) throw error('execution_revoked', 'Managed execution was revoked', 403);
        db.prepare('UPDATE p_sandbox_execution_leases SET heartbeat_at=?,expires_at=? WHERE id=?').run(Date.now(), Date.now() + 20000, lease.id);
      },
      cancel: () => serial(async () => {
        if (released) return;
        // Already proven terminated, by this handle or another. Cancelling again would re-run the whole
        // termination probe against a guest that is already gone.
        if (cancellation() === VERIFIED) return;
        mark(REQUESTED);
        if (settle && await settled({ cancel: true })) { mark(VERIFIED); return; }
        const current = await runtimeFor(spec).inspect(spec);
        if (current?.state === 'running') { await runtimeFor(spec).cancelExecution(spec, lease.execution_id, { persistent: true }); mark(VERIFIED); return; }
        if (current && !['stopped', 'exited', 'created'].includes(current.state)) throw error('cancellation_unverified', 'Guest termination cannot be verified');
        // A container that is gone, stopped or never started cannot be running this execution, so its
        // termination is established just as firmly as by the tombstone above.
        mark(VERIFIED);
      }),
      release: () => serial(async () => {
        if (released) return;
        const requested = cancellation();
        if (requested === VERIFIED) {
          // The cancellation left a runtime mask deliberately, and it stays until the runtime generation
          // ends. Unmasking it here would reopen the late-launch race, and re-running the cancellation
          // would probe a guest already proven gone. Retiring the durable lease is all that is left.
          retire();
          return;
        }
        // A cancellation that could NOT be verified leaves this execution in a state the bound closure
        // must not be trusted to summarize, so the fully verified path below takes over and reports
        // properly — which is also what recovery relies on.
        if (!requested && settle && await settled({ cancel: false })) { retire(); return; }
        const current = await runtimeFor(spec).inspect(spec);
        if (current?.state === 'running') await runtimeFor(spec).releaseExecution(spec, lease.execution_id, { persistent: true });
        else if (current && !['stopped', 'exited', 'created'].includes(current.state)) throw error('cancellation_unverified', 'Guest termination cannot be verified');
        retire();
      }),
      /** Retire the DURABLE lease for a guest execution the client has already settled. Only a caller
       *  that ran the execution through the client's `exec` may use this: that method releases or
       *  terminates the guest unit itself before returning, so repeating the release here inspected the
       *  container and every volume a second time and re-ran the whole termination probe — half the
       *  runtime invocations of a trivial file operation, spent proving again what had just been proven.
       *  What still has to happen is the part the client does not own: deleting the row that fences
       *  lifecycle changes. Anything that cannot establish the guest is settled must use `release`. */
      finalize() {
        if (released) return;
        retire();
      },
    };
  }

  async function runGuest(row, userId, argv, options = {}) {
    const leased = await mint(row, userId, options.kind ?? 'files');
    const handle = leaseHandle(row, leased);
    let failure;
    try { const spec = specFor(row.spec); return await runtimeFor(spec).exec(spec, leased.execution_id, argv, { ...options, persistent: true }); }
    catch (cause) { failure = cause; throw runtimeUnavailable(cause); }
    finally {
      // `exec` has already released or terminated the guest unit on every exit except a cleanup failure,
      // which is the one case it marks. So the ordinary path only has to retire the durable lease, while
      // an unsettled guest still gets the full release — and a lease that cannot be retired safely is
      // deliberately left in place for lifecycle recovery rather than deleted to make the call look clean.
      try {
        if (failure?.guestSettled === false) await handle.release();
        else handle.finalize();
      } catch (cause) { throw new AggregateError([...(failure ? [failure] : []), cause], `Managed execution cleanup failed: ${cause.message}`); }
    }
  }

  async function prepareExecution(input, userId) {
    const id = projectId(input.projectRef);
    account(userId, true);
    const row = await ready(id, userId, false);
    const program = command(input.command);
    const cwd = guestPath(input.cwd ?? rootOf(row));
    const leased = await mint(row, userId, input.leaseKind);
    let handle = leaseHandle(row, leased);
    try {
      const spec = specFor(row.spec);
      const prepared = await runtimeFor(spec).prepareExecution(spec, leased.execution_id, program.argv, { input: program.input, workdir: cwd, timeoutMs: 900000 });
      // Preparation has just verified ownership for this execution, so the cleanup after the command
      // settles reuses that verification rather than inspecting the container and every volume again.
      handle = leaseHandle(row, leased, prepared.settle);
      return { mode: 'managed', projectRef: input.projectRef, cwd: dataDir, displayCwd: cwd, home: '/root', roots: ['/'],
        // The client owns what goes on that pipe, not this function: it hands back the caller's own
        // bytes unchanged, while a transport whose privileged request travels ahead of them in the same
        // pipe hands back both. Returning `program.input` here would silently drop the request half.
        launch: prepared.launch, stdin: prepared.stdin, cancel: () => handle.cancel(), lease: handle,
        sanitizeOutput: sanitize };
    } catch (cause) { await handle.release(); throw cause; }
  }

  async function projectFileRoot(input) {
    const id = projectId(input.project);
    account(input.accountUserId);
    const project = await authorize(id, input.accountUserId);
    const row = store.get('project', id);
    const workspaceId = input.workspaceId ?? null;
    if (workspaceId !== null && (typeof workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(workspaceId))) throw error('invalid_workspace', 'Invalid managed workspace identity', 400);
    if (workspaceId !== null) {
      const workspace = db.prepare("SELECT path FROM p_sandbox_managed_worktrees WHERE id=? AND project_id=? AND state='active'").get(workspaceId, id);
      if (!workspace) throw error('workspace_not_found', 'Managed workspace is not active', 404);
      return { root: workspace.path, generation: row?.generation ?? 1, state: row?.state ?? 'unprovisioned', workspaceId };
    }
    return { root: row ? rootOf(row) : managedGuestRoot(project.slug, id), generation: row?.generation ?? 1, state: row?.state ?? 'unprovisioned', workspaceId: null };
  }

  async function projectFiles(input) {
    const id = projectId(input.project);
    const op = fileOperation(input.operation);
    account(input.accountUserId, MUTATING_FILE_KINDS.has(op.kind));
    // An upload keeps the readiness probe: its transport does its own staging before any guest command,
    // so the execution's ownership check is not the very next thing to run.
    const row = await ready(id, input.accountUserId, UPLOAD_KINDS.includes(op.kind), input.startIfNeeded !== false);
    assertGeneration(row, input.expectedGeneration);
    const authoritativeRoot = input.workspaceId
      ? db.prepare("SELECT path FROM p_sandbox_managed_worktrees WHERE id=? AND project_id=? AND state='active'").get(input.workspaceId, id)?.path
      : rootOf(row);
    if (typeof authoritativeRoot !== 'string') throw error('workspace_not_found', 'Managed workspace is not active', 404);
    if (input.root !== undefined && input.root !== authoritativeRoot) throw error('path_outside_project', 'Path is outside the selected Project root', 403);
    const scopedOp = { ...op, root: authoritativeRoot };
    const perform = async () => {
      if (UPLOAD_KINDS.includes(scopedOp.kind)) return await transfers.perform({ row, accountUserId: input.accountUserId, operation: scopedOp });
      const result = await runGuest(row, input.accountUserId, ['/usr/bin/python3', '-c', FILE_HELPER], { input: JSON.stringify(scopedOp), timeoutMs: 120000 });
      if (result.truncated) throw error('output_limit', 'Guest file output exceeded its bound');
      let reply;
      try { reply = JSON.parse(result.stdout); } catch { throw protocolError('Invalid guest file response'); }
      if (!reply?.ok || result.code !== 0) throw error(reply?.error?.code ?? 'guest_file_error', reply?.error?.message ?? 'Guest file operation failed');
      if (reply.result?.kind !== scopedOp.kind) throw protocolError('Guest response kind differs from the requested operation');
      return reply.result;
    };
    // Only the operations that CHANGE the tree serialize against each other. Holding one exclusive
    // repository lease across every file operation meant a batch of independent reads ran strictly one at
    // a time and, worse, queued behind whatever mutation happened to be in front of them — five parallel
    // tool calls became five sequential container executions.
    //
    // Nothing that made a read safe came from that lease. Every operation still mints a durable execution
    // lease, and minting is what checks the caller's authorization, the environment's generation and
    // running state, that no lifecycle operation is under way, and that no worktree mutation holds the
    // boundary. A read still verifies the content version inside the guest across its own transfer, and a
    // write is still a compare-and-swap against the version the caller read. A guest write lands by
    // writing a temporary file and renaming it over the target, so a concurrent reader observes the old
    // file or the new one — never a half-written one — and a version that moved under it is reported as a
    // conflict rather than returned as content.
    return MUTATING_FILE_KINDS.has(op.kind)
      ? await withRepoLease(db, `environment-files:project:${id}`, perform)
      : await perform();
  }

  async function cancelLeases(row, userId) {
    const leases = store.leases(row.kind, row.resource_id, userId);
    for (const leased of leases) {
      db.prepare('UPDATE p_sandbox_execution_leases SET cancel_requested=1 WHERE id=?').run(leased.id);
      await leaseHandle(row, leased).cancel();
    }
  }
  async function revokeProjectAccess({ projectId: id, accountUserId }) {
    positive(id, 'project'); positive(accountUserId, 'account');
    const ambient = ctx.currentAccountUserId();
    if (ambient !== null && ambient !== undefined && !stores().usersRead.isAdmin(ambient) && !stores().userProjects.canManage(ambient, id)) throw error('project_forbidden', 'Project management access is required', 403);
    const row = store.get('project', id);
    if (!row) return;
    await cancelLeases(row, accountUserId);
    await transfers.quiesce({ row, accountUserId });
  }
  async function stopRow(row) {
    if (neverMaterialized(row)) return;
    const spec = specFor(row.spec);
    const current = await runtimeFor(spec).inspect(spec);
    if (!current) return;
    // Thawing here is the first half of taking the machine DOWN, so it is not gated on host readiness: an
    // environment that is up must stay stoppable on a host whose rows are gone. The gate belongs to the
    // starts, which is where the machine would be brought back up and left up.
    if (current.state === 'paused') await runtimeFor(spec).unpause(spec);
    if (['running', 'paused', 'stopping'].includes(current.state)) {
      await cancelLeases(row);
      await runtimeFor(spec).stop(spec);
    }
    const stopped = await runtimeFor(spec).inspect(spec);
    if (stopped && !['created', 'configured', 'stopped', 'exited'].includes(stopped.state)) throw error('stop_unverified', 'Container stop could not be verified');
  }
  async function ensureInitialContainer(row, op) {
    let spec = specFor(row.spec);
    let current = await runtimeFor(spec).inspect(spec);
    if (row.spec.containerId) {
      if (current) return current;
      if (!row.spec.input.disk && !op.checkpoint.autoRecovery) throw error('persistent_container_missing', 'The persistent root filesystem is missing; restore a snapshot explicitly');
      delete row.spec.containerId;
      // The missing container ended the old creation identity. A replacement is created with the limits
      // currently effective for the environment, then future live updates preserve those as its baseline.
      row.spec.creationLimits = { ...row.spec.input.limits };
      store.save(row);
      spec = specFor(row.spec);
      current = await runtimeFor(spec).inspect(spec);
    }
    if (current && !op.checkpoint.creating) throw error('container_unclaimed', 'A container exists without this creation checkpoint');
    if (!op.checkpoint.creating) checkpoint(op, { creating: true });
    if (!current) current = await runtimeFor(spec).create(spec);
    row.spec.containerId = current.id;
    store.save(row);
    return current;
  }

  /** The one moment a HOST project's directory becomes the project's own workspace volume. Core's
   *  `adoptAsManaged` records where that directory came from and leaves it where it is; the first start
   *  of the environment is where it moves, once, before any container exists — and `adopted_path` stays
   *  on the project row as the way back. */
  async function adoptHostWorkspace(row) {
    if (row.kind !== 'project') return;
    const adopted = stores().projects.get(Number(row.resource_id))?.adoptedPath;
    if (!adopted) return;
    await storage.adoptWorkspace(specFor(row.spec), adopted);
  }

  async function startRow(row, op) {
    step(op, 'image');
    if (!row.spec.containerId) {
      await decideRuntime(row);
      // Fetching the published root filesystem is the one part of a start that can take minutes, and it
      // happens inside `prepare` because that is the only place that knows whether this disk still needs
      // it: a disk already materialized returns before any fetch, so restarting an existing environment
      // never re-downloads an artifact that collection has since reclaimed.
      await storage.prepare(specFor(row.spec), {
        onProgress: (received, total) => step(op, 'image', total > 0 ? received / total : null, true),
      });
      step(op, 'storage');
      await adoptHostWorkspace(row);
    } else {
      const spec = specFor(row.spec);
      const runtime = runtimeFor(spec);
      if (typeof runtime.normalizeRootfs === 'function') await runtime.normalizeRootfs(spec);
      step(op, 'storage');
    }
    step(op, 'container');
    const current = await ensureInitialContainer(row, op);
    const spec = specFor(row.spec);
    step(op, 'boot');
    if (current.state === 'paused') {
      // A thawed machine IS a running machine, and it is the machine that already holds the virtual
      // ethernet, so the resume goes through the gate a boot goes through rather than beside it: an unready
      // host must not carry that link in either shape. Asked BEFORE the thaw, so a refusal leaves the
      // machine frozen instead of running unisolated.
      await assertNetworkedStartAllowed(row);
      await runtimeFor(spec).unpause(spec);
    } else if (current.state !== 'running') {
      // Before the link is turned on, never after: the envelope this start activates is what gives the
      // machine its virtual ethernet, and a host that cannot isolate that link must not carry one.
      await assertNetworkedStartAllowed(row);
      await runtimeFor(spec).start(spec);
    }
    if ((await runtimeFor(spec).inspect(spec))?.state !== 'running') throw error('start_unverified', 'Container start could not be verified');
    const root = rootOf(row);
    // A running container is not yet a usable guest: initialization below, and every execution after it,
    // runs through `systemd-run` and therefore needs the guest system bus. Waiting for it here is its own
    // step because it is the part of a start that can take a while, and because a guest whose boot never
    // finishes is then reported as exactly that instead of a dbus error from the initialize command.
    step(op, 'ready', null);
    await runtimeFor(spec).waitForSystemBus(spec);
    if (effectiveNetwork(row.spec).mode !== 'isolated') {
      const runtime = runtimeFor(spec);
      if (typeof runtime.waitForNetwork === 'function') await runtime.waitForNetwork(spec);
      else if (typeof runtime.networkReadiness === 'function') {
        const network = await runtime.networkReadiness(spec);
        if (!network.ready) throw error('guest_network_not_ready', `The guest shared network is not ready — ${network.detail ?? 'host0 has no carrier or address'}`);
      }
    }
    step(op, 'initialize');
    if (!op.checkpoint.initialized) {
      const result = await runtimeFor(spec).exec(spec, randomUUID().replaceAll('-', ''), ['/bin/bash', '-s'], { input: `set -eu\nif [ ! -e ${root}/.git ]; then\n git init -b main ${root}\n git -C ${root} -c user.name=Elowen -c user.email=environment@localhost -c core.hooksPath=/dev/null commit --allow-empty -m "Initialize managed project"\nfi\nmkdir -p /worktrees\n`, timeoutMs: 30000, persistent: true });
      if (result.code !== 0) throw error('initialization_failed', result.stderr || 'Project initialization failed');
      checkpoint(op, { initialized: true });
    }
    // The container is up and its system bus answers, so the forwarders it lost with the previous one
    // can be established again. The socket files outlive the container, hence `establishPublication`
    // removing them rather than trusting what is there.
    await establishPublications(row);
    row.state = 'running'; row.error = null; store.save(row);
  }

  async function snapshot(row, op, snapshotId, note) {
    const spec = specFor(row.spec);
    const existing = store.snapshot(row.kind, row.resource_id, snapshotId);
    if (existing) return JSON.parse(existing.manifest_json);
    const capture = async () => {
      if (!op.checkpoint.worktrees) checkpoint(op, { worktrees: db.prepare('SELECT * FROM p_sandbox_managed_worktrees WHERE project_id=?').all(row.project_id) });
      let manifest;
      try { manifest = await storage.readSnapshot(spec, snapshotId); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      if (!manifest) manifest = await storage.snapshot(spec, snapshotId);
      manifest = { ...manifest, worktrees: op.checkpoint.worktrees };
      store.saveSnapshot(row, snapshotId, manifest, note);
      return manifest;
    };
    return await withRepoLease(db, `managed-worktrees:${row.project_id}`, capture);
  }

  async function perform(row, op) {
    const kind = op.action.kind;
    if (['stop', 'restart', 'snapshot', 'restore', 'network'].includes(kind)) {
      step(op, 'quiesce');
      await cancelLeases(row);
      await transfers.quiesce({ row });
    }
    if (kind === 'start' || kind === 'restart') {
      row.state = 'starting'; store.save(row);
      if (kind === 'restart' && !op.checkpoint.stopped) { step(op, 'stop'); await stopRow(row); checkpoint(op, { stopped: true }); }
      await startRow(row, op);
    } else if (kind === 'recreate') {
      // The container this runtime cannot verify is removed and rebuilt from the current specification.
      // Only the container: the storage volumes are left alone and remount under the new name, so the
      // project's files survive the repair.
      row.state = 'starting'; store.save(row);
      if (!op.checkpoint.removed) {
        step(op, 'remove');
        const previous = specFor(row.spec);
        await cancelLeases(row);
        if (await runtimeFor(previous).containerExists(previous)) {
          await stopRow(row);
          await runtimeFor(previous).remove(previous);
        }
        delete row.spec.containerId;
        // Removing the container ends its creation identity: the replacement is created with the limits
        // currently effective, and ownership checks must compare against those, not the old baseline.
        row.spec.creationLimits = { ...row.spec.input.limits };
        store.save(row);
        checkpoint(op, { removed: true });
      }
      await startRow(row, op);
    } else if (kind === 'stop') {
      step(op, 'stop');
      await stopRow(row); row.state = 'stopped'; row.error = null; store.save(row);
    } else if (kind === 'snapshot') {
      if (!op.snapshot_id) { op.snapshot_id = `snapshot-${op.id.slice(4)}`; store.saveOperation(op); }
      await cancelLeases(row);
      step(op, 'capture');
      await snapshot(row, op, op.snapshot_id, op.action.note);
      step(op, 'record');
    } else if (kind === 'restore') {
      const saved = store.snapshot(row.kind, row.resource_id, op.action.snapshotId);
      if (!saved) throw error('snapshot_missing', 'Snapshot is not retained for this environment');
      const source = JSON.parse(saved.spec_json);
      const storageId = JSON.parse(saved.manifest_json).snapshotId;
      const manifest = await storage.readSnapshot(specFor(source), storageId);
      if (!op.checkpoint.oldSpec) checkpoint(op, { oldSpec: row.spec, oldGeneration: row.generation, wasRunning: row.desired_state === 'running' });
      const old = { ...row, spec: op.checkpoint.oldSpec, generation: op.checkpoint.oldGeneration };
      step(op, 'stop');
      await stopRow(old);
      if (!op.checkpoint.newSpec) {
        const next = JSON.parse(JSON.stringify(old.spec));
        const reserved = db.prepare("SELECT MAX(json_extract(checkpoint_json,'$.newSpec.input.generation')) AS generation FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=?").get(row.kind, row.resource_id);
        next.input.generation = Math.max(old.generation, Number(reserved?.generation ?? 0)) + 1;
        if (manifest.version === 2) {
          if (!old.spec.input.disk) throw error('snapshot_driver_mismatch', 'A disk snapshot requires a rootfs-backed environment');
          // A retained snapshot can still name a removed container image tag. A restore fills a new disk
          // from trees it copies, so a currently published reference stays authoritative rather than moving
          // the row back onto a runtime this release cannot drive. A row already on a legacy reference stays
          // legacy and is refused consistently. The disk record follows this field.
          next.input.image = isLegacyImageReference(manifest.sourceImage.reference) && !isLegacyImageReference(old.spec.input.image)
            ? old.spec.input.image : manifest.sourceImage.reference;
          // A restore replaces the disk, never the runtime that reads it: the snapshot is a copy of THIS
          // environment's tree, already owned by whichever uid range its runtime uses.
          next.input.disk = createEnvironmentDiskSpec({ resource: next.input.resource, image: next.input.image, runtime: old.spec.input.disk.runtime },
            next.paths, randomUUID().replaceAll('-', ''));
        } else {
          if (old.spec.input.disk) throw error('snapshot_driver_mismatch', 'A legacy snapshot requires a legacy environment');
          next.input.image = manifest.image.reference;
        }
        next.creationLimits = next.input.limits;
        delete next.containerId;
        checkpoint(op, { newSpec: next });
      }
      let target = specFor(op.checkpoint.newSpec);
      step(op, 'import');
      if (!op.checkpoint.imported) {
        await storage.restoreVolumes(specFor(source), storageId, target);
        checkpoint(op, { imported: true });
      }
      step(op, 'container');
      let restored = await runtimeFor(target).inspect(target);
      if (op.checkpoint.newSpec.containerId && !restored) throw error('restore_target_missing', 'The bound restore target is missing; start a new restore intent');
      if (restored && !op.checkpoint.newSpec.containerId && !op.checkpoint.targetCreating) throw error('restore_target_unclaimed', 'The restore target has no creation checkpoint');
      if (!restored) {
        checkpoint(op, { targetCreating: true });
        restored = await runtimeFor(target).create(target);
      }
      if (!op.checkpoint.newSpec.containerId) {
        op.checkpoint.newSpec.containerId = restored.id;
        checkpoint(op, { newSpec: op.checkpoint.newSpec });
        target = specFor(op.checkpoint.newSpec);
      }
      step(op, 'boot');
      if (op.checkpoint.wasRunning) {
        if ((await runtimeFor(target).inspect(target))?.state !== 'running') await runtimeFor(target).start(target);
        if ((await runtimeFor(target).inspect(target))?.state !== 'running') throw error('restore_start_failed', 'Restored container did not start');
      }
      step(op, 'switch');
      if (!op.checkpoint.switched) store.transaction(() => {
        const worktrees = JSON.parse(saved.manifest_json).worktrees ?? [];
        db.prepare('DELETE FROM p_sandbox_managed_worktrees WHERE project_id=?').run(row.project_id);
        for (const item of worktrees) db.prepare('INSERT INTO p_sandbox_managed_worktrees(id,project_id,created_by,label,path,branch,base_ref,base_commit,state) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(item.id, row.project_id, item.created_by, item.label, item.path, item.branch, item.base_ref, item.base_commit, item.state);
        row.spec = op.checkpoint.newSpec; row.generation = row.spec.input.generation;
        row.state = op.checkpoint.wasRunning ? 'running' : 'stopped'; row.error = null; store.save(row);
        checkpoint(op, { switched: true });
      });
      step(op, 'cleanup');
      const previousSpec = specFor(old.spec);
      if (await runtimeFor(previousSpec).inspect(previousSpec)) await runtimeFor(previousSpec).remove(previousSpec);
      // Old volumes are retained until explicit Project deletion, providing a non-destructive rollback checkpoint.
    } else if (kind === 'limits') {
      step(op, 'apply');
      if (!stores().usersRead.isAdmin(op.user_id)) throw error('admin_required', 'Resource-limit authority was revoked', 403);
      const prior = specFor(row.spec);
      await runtimeFor(prior).update(prior, op.action.limits);
      row.spec.creationLimits ??= row.spec.input.limits;
      row.spec.input.limits = { cpus: op.action.limits.cpus, memoryMb: op.action.limits.memoryMb, pidsLimit: op.action.limits.pidsLimit };
      row.limits = op.action.limits; store.save(row);
    } else if (kind === 'network') {
      if (!stores().usersRead.isAdmin(op.user_id)) throw error('admin_required', 'Environment-network authority was revoked', 403);
      if (op.checkpoint.switched) return;
      if (neverMaterialized(row)) {
        step(op, 'stop'); step(op, 'apply');
        row.spec.input.network = op.action.network; row.error = null; store.save(row);
        return;
      }
      if (!op.checkpoint.oldSpec) checkpoint(op, { oldSpec: row.spec, wasRunning: row.state === 'running' });
      const old = { ...row, spec: op.checkpoint.oldSpec };
      if (!op.checkpoint.stopped) {
        step(op, 'stop'); await stopRow(old); checkpoint(op, { stopped: true });
      }
      if (!op.checkpoint.newSpec) {
        const next = JSON.parse(JSON.stringify(op.checkpoint.oldSpec));
        next.input.network = op.action.network;
        delete next.containerId;
        checkpoint(op, { newSpec: next });
      }
      step(op, 'apply');
      const previous = specFor(op.checkpoint.oldSpec);
      if (await runtimeFor(previous).containerExists(previous)) await runtimeFor(previous).remove(previous);
      let target = specFor(op.checkpoint.newSpec);
      let current = await runtimeFor(target).inspect(target);
      if (!current) current = await runtimeFor(target).create(target);
      if (!op.checkpoint.newSpec.containerId) {
        op.checkpoint.newSpec.containerId = current.id;
        checkpoint(op, { newSpec: op.checkpoint.newSpec });
        target = specFor(op.checkpoint.newSpec);
      }
      step(op, 'boot');
      if (op.checkpoint.wasRunning && (await runtimeFor(target).inspect(target))?.state !== 'running') {
        await runtimeFor(target).start(target);
        await runtimeFor(target).waitForSystemBus(target);
        await establishPublications({ ...row, spec: op.checkpoint.newSpec });
      }
      store.transaction(() => {
        row.spec = op.checkpoint.newSpec; row.state = op.checkpoint.wasRunning ? 'running' : 'stopped'; row.error = null; store.save(row);
        op.checkpoint.switched = true; store.saveOperation(op);
      });
    } else if (kind === 'delete') {
      await assertNoPublishedSites(row.resource_id);
      step(op, 'stop');
      await stopRow(row);
      // An environment that never picked a runtime never built anything: no envelope, no disk, no storage
      // root, and no snapshot could have been taken of it. The records below are the whole of it.
      if (neverMaterialized(row)) {
        step(op, 'containers'); checkpoint(op, { containerRemoved: true });
        step(op, 'storage'); checkpoint(op, { storageRemoved: true });
      } else {
      const spec = specFor(row.spec);
      const snapshots = store.snapshots(row.kind, row.resource_id);
      const recipes = new Map([[spec.name, row.spec]]);
      // Completed migration history still carries the retired runtime's specifications as audit receipts.
      // They no longer own an envelope this release can drive; the final environment-storage removal below
      // clears their shared snapshot directories after every nspawn generation and disk has been released.
      const keepNspawnRecipe = (recipe) => {
        const owned = specFor(recipe);
        if (usesNspawnRuntime(owned)) recipes.set(owned.name, recipe);
      };
      for (const saved of snapshots) keepNspawnRecipe(JSON.parse(saved.spec_json));
      for (const entry of db.prepare('SELECT checkpoint_json FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=?').all(row.kind, row.resource_id)) {
        const previous = JSON.parse(entry.checkpoint_json);
        for (const key of ['oldSpec', 'newSpec']) if (previous[key]) keepNspawnRecipe(previous[key]);
      }
      recipes.set(spec.name, row.spec);
      step(op, 'containers');
      for (const recipe of recipes.values()) {
        const owned = specFor(recipe);
        if (await runtimeFor(owned).inspect(owned)) {
          await stopRow({ ...row, spec: recipe, generation: recipe.input.generation });
          await runtimeFor(owned).remove(owned);
        }
      }
      checkpoint(op, { containerRemoved: true });
      step(op, 'storage');
      for (const saved of snapshots) {
        const owned = specFor(JSON.parse(saved.spec_json));
        if (usesNspawnRuntime(owned)) await runtimeFor(owned).removeSnapshotStorage(owned, JSON.parse(saved.manifest_json).snapshotId);
      }
      const ownedSpecs = [...recipes.values()].map((recipe) => specFor(recipe));
      const disks = new Map(ownedSpecs.filter((owned) => owned.disk).map((owned) => [owned.disk.id, owned]));
      for (const disk of disks.values()) await storage.removeDisk(disk, ownedSpecs);
      await runtimeFor(spec).removeStorage(spec);
      checkpoint(op, { storageRemoved: true });
      }
      step(op, 'records');
      store.transaction(() => {
        // The deletion itself stays: the surface that asked for it still reads its outcome. Everything
        // that happened to an environment that no longer exists goes with it.
        db.prepare('DELETE FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=? AND id<>?').run(row.kind, row.resource_id, op.id);
        db.prepare('DELETE FROM p_sandbox_runtime_snapshots WHERE kind=? AND resource_id=?').run(row.kind, row.resource_id);
        db.prepare('DELETE FROM p_sandbox_execution_leases WHERE resource_kind=? AND resource_id=?').run(row.kind, row.resource_id);
        db.prepare('DELETE FROM p_sandbox_file_uploads WHERE resource_kind=? AND resource_id=?').run(row.kind, row.resource_id);
        db.prepare('DELETE FROM p_sandbox_managed_worktrees WHERE project_id=?').run(row.project_id);
        if (!stores().projects.finishDeletion(Number(row.resource_id))) throw error('project_finalize_failed', 'Core Project deletion could not be finalized');
        store.removeProjectPublications(row.project_id);
        db.prepare('DELETE FROM p_sandbox_runtimes WHERE kind=? AND resource_id=?').run(row.kind, row.resource_id);
        op.status = 'succeeded'; op.error = null; store.saveOperation(op);
      });
    }
  }

  async function recoveryActor(row) {
    const candidates = [...new Set([
      ...store.recentOperations(row.kind, row.resource_id, OPERATION_HISTORY).map((op) => op.user_id),
      ...stores().usersRead.list().map((user) => user.id),
    ].filter((id) => id !== null && id !== undefined))];
    for (const userId of candidates) {
      try { await authorize(row.resource_id, userId, true, true); return userId; }
      catch { /* Try another currently authorized account. */ }
    }
    return null;
  }

  async function queueAutomaticRecovery(row, observed) {
    if (row.desired_state !== 'running' || row.state === 'deleted' || !rootOf(row)) return;
    const history = store.recentOperations(row.kind, row.resource_id, OPERATION_HISTORY);
    const previousIndex = history.findIndex((op) => op.checkpoint.autoRecovery);
    // A successful explicit start is the operator taking ownership of recovery again. Automatic attempts
    // before it no longer count against the next failure; without this, a manual repair after exhaustion
    // returned straight to the terminal failed state on the next container death.
    const manuallyRestarted = previousIndex > 0 && history.slice(0, previousIndex)
      .some((op) => op.action.kind === 'start' && op.status === 'succeeded' && !op.checkpoint.autoRecovery);
    const previous = manuallyRestarted || previousIndex < 0 ? undefined : history[previousIndex].checkpoint.autoRecovery;
    const now = Date.now();
    const stable = previous?.completedAt && now - previous.completedAt >= AUTO_RECOVERY_STABILITY_MS;
    const attempt = stable ? 1 : Number(previous?.attempt ?? 0) + 1;
    if (attempt > AUTO_RECOVERY_DELAYS_MS.length) {
      if (row.state === 'failed' && row.error?.startsWith(`Automatic recovery failed after ${AUTO_RECOVERY_DELAYS_MS.length} attempts`)) return;
      const message = `Automatic recovery failed after ${AUTO_RECOVERY_DELAYS_MS.length} attempts; the container is still not running`;
      if (row.state !== 'failed' || row.error !== message) {
        row.state = 'failed'; row.error = message; store.save(row); store.log(row.kind, row.resource_id, message);
      }
      return;
    }
    const previousAt = Number(previous?.failedAt ?? previous?.completedAt ?? previous?.queuedAt ?? 0);
    if (!stable && previousAt && now < previousAt + AUTO_RECOVERY_DELAYS_MS[attempt - 1]) return;
    const userId = await recoveryActor(row);
    if (userId === null) {
      store.log(row.kind, row.resource_id, 'Automatic recovery could not find an account that still manages this environment');
      return;
    }
    // What the sweep SAW, never why. This runs on a timer, and an envelope is down after a host reboot,
    // after a start that failed, and after anything outside Elowen stopped it; the reason is written into
    // the lifecycle log an operator reads, and naming a reboot that never happened sent readers looking
    // for one that was not there.
    const reason = observed ? `container not running (${observed.state})` : 'container missing';
    store.transaction(() => {
      const current = store.get(row.kind, row.resource_id);
      if (!current || current.desired_state !== 'running' || current.state === 'deleted' || store.active(row.kind, row.resource_id)) return;
      const op = store.enqueue(current, userId, { kind: 'start' }, `autostart:${current.generation}:${attempt}:${now}`);
      op.checkpoint.autoRecovery = { attempt, queuedAt: now, reason };
      declareSteps(op); store.saveOperation(op);
      store.log(current.kind, current.resource_id, `start queued automatically: ${reason} (attempt ${attempt}/${AUTO_RECOVERY_DELAYS_MS.length})`);
    });
  }

  async function performHostProvision(op) {
    const user = stores().usersRead.list().find((entry) => entry.id === op.user_id);
    if (!user || !stores().usersRead.mayUsePlugin(op.user_id, 'sandbox') || !stores().usersRead.isAdmin(op.user_id)) {
      throw error('admin_required', 'Administrator authority for host provisioning was revoked', 403);
    }
    if (!nspawn || typeof nspawn.provisionHost !== 'function') throw error('runtime_unavailable', 'This runtime has no machine client to prepare', 503);
    if (!op.checkpoint.hostPrepared) {
      step(op, 'host', null);
      invalidateReadiness();
      // The preparation answer is the newest observation of the host there is, so it is recorded at a
      // position taken AFTER the invalidation: a probe that was already in flight when the helper changed
      // the host cannot overwrite it.
      const probe = nextReadinessProbe();
      const value = await nspawn.provisionHost();
      recordReadiness(probe, value);
      if (!value.ready) throw error('provision_incomplete', readinessRefusal(value));
      checkpoint(op, { hostPrepared: true });
    }
    const completed = new Set(op.checkpoint.artifacts ?? []);
    for (const reference of knownReferences()) {
      if (completed.has(reference)) continue;
      step(op, `rootfs:${reference}`, 0);
      await artifacts.ensure(reference, { onProgress: (received, total) => step(op, `rootfs:${reference}`, total > 0 ? received / total : null, true) });
      completed.add(reference); checkpoint(op, { artifacts: [...completed] });
    }
    step(op, 'verify');
    invalidateReadiness();
    const report = await machineReadiness();
    if (!report.prepared) throw error('provision_incomplete', readinessRefusal(report));
    ctx.logger.info(`machine runtime provisioning completed for account ${op.user_id}`);
  }

  function publicationRecoveryState(row) {
    if (row.error?.startsWith(`Automatic recovery failed after ${AUTO_RECOVERY_DELAYS_MS.length} attempts`)) {
      return { key: 'terminal', detail: `automatic recovery failed after ${AUTO_RECOVERY_DELAYS_MS.length} attempts` };
    }
    const latest = store.recentOperations(row.kind, row.resource_id, OPERATION_HISTORY)
      .find((op) => op.checkpoint.autoRecovery);
    const recovery = latest?.checkpoint.autoRecovery;
    if (!latest || !recovery) return null;
    const attempt = Number(recovery.attempt ?? 0);
    if (latest.status === 'pending' || latest.status === 'running') {
      return { key: `attempt:${attempt}:${latest.status}`, detail: `automatic recovery attempt ${attempt}/${AUTO_RECOVERY_DELAYS_MS.length} is ${latest.status}` };
    }
    if (attempt >= AUTO_RECOVERY_DELAYS_MS.length) {
      return { key: 'terminal', detail: `automatic recovery failed after ${AUTO_RECOVERY_DELAYS_MS.length} attempts` };
    }
    const previousAt = Number(recovery.failedAt ?? recovery.completedAt ?? recovery.queuedAt ?? 0);
    const nextAttempt = attempt + 1;
    const retryAt = previousAt + AUTO_RECOVERY_DELAYS_MS[nextAttempt - 1];
    if (previousAt && Date.now() < retryAt) {
      return { key: `backoff:${nextAttempt}`, detail: `automatic recovery attempt ${nextAttempt}/${AUTO_RECOVERY_DELAYS_MS.length} is waiting for backoff` };
    }
    return null;
  }

  /** Retire only machine-backed Site rows left by an older release. The persisted machine binding is the
   * authority passed to the privileged ownership check; no Site lifecycle or execution path is restored.
   * The external action and the row update cannot be one transaction, so the helper is idempotent and a
   * crash between them repeats only the proof before converging the retained audit row to stopped. */
  async function retireLegacySiteMachines() {
    const candidates = store.all().filter((row) => row.kind === 'site' && row.state !== 'deleted'
      && (row.state === 'running' || row.desired_state === 'running')
      && row.spec?.input?.disk?.runtime === 'nspawn' && typeof row.spec?.containerId === 'string');
    for (const row of candidates) {
      // One Site machine is one unit of work, and a detach ends the sweep at the next of them exactly as it
      // does in every loop of the sweep. Without this, a batch of historical Site rows would be retired
      // after the generation that owns them is already going away.
      if (disposed) break;
      const key = `${row.resource_id}:${row.generation}:${row.spec.containerId}`;
      try {
        await nspawn.retireLegacySiteMachine(row.spec);
        store.transaction(() => {
          const current = store.get('site', row.resource_id);
          if (!current || current.state === 'deleted' || current.generation !== row.generation
            || current.spec?.containerId !== row.spec.containerId) return;
          current.state = 'stopped'; current.desired_state = 'stopped';
          store.save(current);
          store.log('site', current.resource_id, 'Legacy Site machine retired; retained audit data was left in place');
        });
        legacySiteRetirementErrors.delete(key);
      } catch (cause) {
        const message = `Legacy Site machine retirement failed: ${sanitize(cause.message ?? cause).slice(0, 1900)}`;
        const current = store.get('site', row.resource_id);
        if (!current || current.state === 'deleted' || current.generation !== row.generation
          || current.spec?.containerId !== row.spec.containerId || legacySiteRetirementErrors.get(key) === message) continue;
        legacySiteRetirementErrors.set(key, message);
        store.log('site', current.resource_id, message);
      }
    }
  }

  async function reconcile() {
    if (!daemon || disposed) return;
    // One sweep at a time, and a caller arriving during one waits for it rather than starting a second:
    // the interval that ticks every ten seconds joins the sweep in progress, and `dispose` needs the same
    // promise to know the host has stopped being written to.
    if (reconcileInFlight) return await reconcileInFlight;
    let settle;
    reconcileInFlight = new Promise((resolve) => { settle = resolve; });
    try {
      // Host provisioning runs before machine inventory: its purpose may be to install the very tools that
      // inventory needs, so making inventory its prerequisite would leave a fresh host impossible to repair.
      for (const op of store.operations().filter((entry) => entry.kind === HOST_KIND)) {
        // A detach stops this generation at the next unit of work rather than in the middle of one: the
        // operation under way is performed to its own end, and nothing after it starts.
        if (disposed) break;
        if (op.status === 'running' && !ownerProvablyDead({ outer_pid: op.owner_pid, runner_identity: op.owner_identity })) continue;
        let claimed = false;
        try {
          claimed = store.transaction(() => {
            const current = store.getOperation(op.id);
            if (!current || (current.status !== 'pending' && !(current.status === 'running' && ownerProvablyDead({ outer_pid: current.owner_pid, runner_identity: current.owner_identity })))) return false;
            Object.assign(op, current, { status: 'running', owner_pid: process.pid, owner_identity: processIdentity(), error: null });
            store.saveOperation(op); return true;
          });
          if (!claimed) continue;
          beginSteps(op);
          await performHostProvision(op);
          delete op.checkpoint.errorCode;
          op.status = 'succeeded'; op.error = null; op.step_index = Math.max(0, (op.steps ?? []).length - 1); op.percent = 100;
          store.saveOperation(op); publishOperation(op);
        } catch (cause) {
          if (!claimed) throw cause;
          op.checkpoint.errorCode = cause.code ?? 'provision_failed';
          op.status = 'failed'; op.error = sanitize(cause.message ?? cause).slice(0, 2000); store.saveOperation(op); publishOperation(op);
        }
      }
      await retireLegacySiteMachines();
      // One map of every envelope that is up, found the way the runtime finds them: by machine-name prefix
      // over this namespace.
      const inventory = await nspawn.containerInventory(namespace);
      const runningContainers = new Set([...inventory.entries()].filter(([, state]) => state === 'running').map(([name]) => name));
      // The report below only ever describes a STANDING condition, and it is keyed by project: an entry for
      // a project this pass did not find the condition on — one that was stopped, deleted or released —
      // goes with the condition, exactly as a publication recovery state does, instead of being held for
      // the life of the process and hiding the first report the next time the project runs. This set is
      // what a COMPLETE pass actually observed, and the map is trimmed to it afterwards.
      const unownedNameStanding = new Set();
      for (const row of store.all().filter((entry) => entry.kind === 'project')) {
        if (disposed) break;
        if (row.desired_state !== 'running' || store.active('project', row.resource_id)) continue;
        if (!rootOf(row) || releasingAdoptions.has(Number(row.resource_id))) continue;
        const spec = specFor(row.spec);
        // An inventory name is LIVENESS, never ownership: `machinectl list` reports what the host has
        // registered, and a machine left over from another specification can hold this name. A name that is
        // up and OURS is skipped without paying for a full ownership proof — that is what keeps a steady
        // sweep cheap — but the proof is taken from the files this runtime owns, and a name that fails it is
        // neither adopted nor replaced: it is reported, and nothing is started under it.
        if (inventory.get(spec.name) === 'running') {
          try {
            await runtimeFor(spec).proveOwnership(spec);
            runningContainers.add(spec.name);
            continue;
          } catch (cause) {
            // Reported once per standing condition rather than once per sweep: a foreign machine keeps
            // holding the name, and a line every ten seconds would bury everything else in the log.
            const message = `Machine ${spec.name} is not provably this environment's: ${cause.message}`;
            unownedNameStanding.add(Number(row.resource_id));
            if (unownedNameReports.get(Number(row.resource_id)) !== message) {
              unownedNameReports.set(Number(row.resource_id), message);
              store.log(row.kind, row.resource_id, message);
            }
            continue;
          }
        }
        // A machine this runtime cannot verify (a mismatched specification, a helper error) is not a
        // recovery candidate, and it must not stop the sweep for every other environment either.
        try {
          const observed = await runtimeFor(spec).inspect(spec);
          if (observed?.state === 'running') { runningContainers.add(spec.name); continue; }
          await queueAutomaticRecovery(row, observed);
        } catch (cause) {
          store.log(row.kind, row.resource_id, `Automatic recovery skipped: ${cause.message}`);
        }
      }
      // A pass cut short by a detach has not looked at every project, so it trims nothing: the map is only
      // ever reduced to what a complete pass saw.
      if (!disposed) {
        for (const key of unownedNameReports.keys()) {
          if (!unownedNameStanding.has(key)) unownedNameReports.delete(key);
        }
      }
      for (const op of store.operations()) {
        if (disposed) break;
        if (op.kind !== 'project') continue;
        if (releasingAdoptions.has(Number(op.resource_id))) continue;
        if (op.status === 'running' && !ownerProvablyDead({ outer_pid: op.owner_pid, runner_identity: op.owner_identity })) continue;
        let claimed = false;
        try {
          claimed = store.transaction(() => {
            const current = store.getOperation(op.id);
            if (!current || (current.status !== 'pending' && !(current.status === 'running' && ownerProvablyDead({ outer_pid: current.owner_pid, runner_identity: current.owner_identity })))) return false;
            Object.assign(op, current, { status: 'running', owner_pid: process.pid, owner_identity: processIdentity(), error: null });
            store.saveOperation(op); return true;
          });
          if (!claimed) continue;
          beginSteps(op);
          const row = await rowFor(op.resource_id, op.user_id, true, true);
          const expected = op.checkpoint.switched ? op.checkpoint.newSpec.input.generation : op.generation;
          if (row.generation !== expected) throw error('generation_changed', 'Queued environment generation changed');
          store.log(row.kind, row.resource_id, `${op.action.kind} started (${op.id})`);
          await perform(row, op);
          if (op.checkpoint.autoRecovery) op.checkpoint.autoRecovery.completedAt = Date.now();
          op.status = 'succeeded'; op.error = null; op.step_index = Math.max(0, (op.steps ?? []).length - 1); op.percent = 100; store.saveOperation(op);
          store.log(row.kind, row.resource_id, `${op.action.kind} completed (${op.id})`);
          publishOperation(op);
        } catch (cause) {
          if (!claimed) throw cause;
          if (op.checkpoint.autoRecovery) op.checkpoint.autoRecovery.failedAt = Date.now();
          op.status = 'failed'; op.error = sanitize(cause.message ?? cause).slice(0, 2000); store.saveOperation(op);
          const row = store.get(op.kind, op.resource_id);
          if (row) {
            const exhausted = op.checkpoint.autoRecovery?.attempt >= AUTO_RECOVERY_DELAYS_MS.length;
            row.error = exhausted ? `Automatic recovery failed after ${AUTO_RECOVERY_DELAYS_MS.length} attempts: ${op.error}` : op.error;
            if (row.desired_state === 'deleted') row.state = 'deleting'; else if (row.state !== 'running' && row.state !== 'stopped') row.state = 'failed';
            store.save(row); store.log(row.kind, row.resource_id, row.error);
          }
          publishOperation(op);
        }
      }
      for (const row of store.all().filter((entry) => entry.kind === 'project')) {
        if (releasingAdoptions.has(Number(row.resource_id))) continue;
        if (store.active('project', row.resource_id)) continue;
        for (const leased of store.leases(row.kind, row.resource_id)) {
          let allowed = true;
          try { await authorize(row.resource_id, leased.user_id, false, true); } catch { allowed = false; }
          const dead = ownerProvablyDead(leased);
          if (!allowed || leased.cancel_requested || dead) {
            try { const handle = leaseHandle(row, leased); await handle.cancel(); if (dead) await handle.release(); }
            catch (cause) { store.log(row.kind, row.resource_id, `Guest cancellation remains unresolved: ${cause.message}`); }
          }
        }
      }
      // Publication records are scoped through their project row. A socket path alone is not liveness:
      // the file survives an unclean forwarder exit, so the guest unit must still report active.
      // A row from before the named project mount has no mount target until `rowFor` backfills it, and
      // no publication could have been bound to it either, so it has nothing to restore.
      const publicationRows = store.all().filter((entry) => entry.kind === 'project' && entry.state === 'running' && rootOf(entry));
      // The map below only ever reports a STANDING condition, and it is keyed by project. A project that
      // was stopped, deleted or released has no publication left to reconcile, so its entry goes with the
      // condition instead of being held for the life of the process and reported as a resumption the next
      // time the project happens to run.
      const reconcilableProjects = new Set(publicationRows.map((entry) => entry.resource_id));
      for (const key of publicationRecoveryStates.keys()) {
        if (!reconcilableProjects.has(key)) publicationRecoveryStates.delete(key);
      }
      for (const row of publicationRows) {
        if (disposed) break;
        if (releasingAdoptions.has(Number(row.resource_id)) || store.active('project', row.resource_id)) continue;
        const publications = store.publications(Number(row.resource_id));
        if (!publications.length) continue;
        const spec = specFor(row.spec);
        const recoveryState = runningContainers.has(spec.name) ? null : publicationRecoveryState(row);
        const previousRecoveryState = publicationRecoveryStates.get(row.resource_id);
        if (recoveryState) {
          if (previousRecoveryState !== recoveryState.key) {
            store.log('project', row.resource_id, `Publication reconciliation skipped: ${recoveryState.detail}`);
            publicationRecoveryStates.set(row.resource_id, recoveryState.key);
          }
          continue;
        }
        if (previousRecoveryState) {
          store.log('project', row.resource_id, 'Publication reconciliation resumed after automatic recovery');
          publicationRecoveryStates.delete(row.resource_id);
        }
        for (const publication of publications) {
          const key = `${row.resource_id}:${publication.publicationId}`;
          try {
            await withPublicationMutation(key, async () => {
              const current = store.publications(Number(row.resource_id))
                .find((entry) => entry.publicationId === publication.publicationId);
              if (!current || await publicationForwarderActive(row, publication.publicationId)) return;
              await establishPublication(row, publication.publicationId, current.port);
            });
          } catch (cause) {
            store.log('project', publication.projectId, `publication ${publication.publicationId} forwarder could not be established: ${cause.message}`);
          }
        }
      }
    } finally {
      // Cleared before the marker settles, so the next sweep of this generation is never queued behind a
      // promise nothing will resolve.
      const ended = settle;
      reconcileInFlight = null;
      ended();
    }
  }

  async function snapshots(id, userId) {
    await authorize(id, userId, true);
    return store.snapshots('project', id).map((entry) => ({ id: entry.id, generation: entry.generation, createdAt: entry.created_at, consistency: 'crash-consistent', completeProject: JSON.parse(entry.manifest_json).completeProject, note: entry.note }));
  }
  async function logs(id, userId, lines = 200) {
    const row = await rowFor(id, userId, true);
    if (!Number.isSafeInteger(lines) || lines < 1 || lines > 1000) throw error('invalid_limit', 'Log line limit must be between 1 and 1000', 400);
    const lifecycle = store.logs('project', id);
    if (row.state !== 'running' || store.active('project', id)) return { lifecycle, journal: '' };
    const result = await runGuest(row, userId, ['/usr/bin/journalctl', '--no-pager', '-n', String(lines)], { kind: 'files', timeoutMs: 30000 });
    if (result.code !== 0) throw error('journal_failed', result.stderr || 'Guest journal read failed');
    return { lifecycle, journal: result.stdout };
  }

  async function managedWorktrees(input) {
    const id = projectId(input.project);
    account(input.accountUserId, input.action?.kind !== 'list');
    if (input.action?.kind === 'list' && input.startIfNeeded === false) {
      await authorize(id, input.accountUserId);
      return db.prepare("SELECT id,project_id AS projectId,created_by AS createdBy,path,branch,base_ref AS baseRef,label,state FROM p_sandbox_managed_worktrees WHERE project_id=? AND state='active' ORDER BY id").all(id);
    }
    const row = await ready(id, input.accountUserId);
    return await manageWorktrees({ db, runGuest, row, userId: input.accountUserId, action: input.action, root: rootOf(row) });
  }

  /** Remove a socket this runtime put there: only ever inside the project's own broker directory, which
   *  the daemon owns (0700), and only a socket — anything else at that path is not ours to delete. */
  function removeForwarderSocket(path, kind) {
    let stat;
    try { stat = lstatSync(path); }
    catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
    if (!stat.isSocket()) throw error(`${kind}_socket_changed`, `${kind === 'preview' ? 'Preview' : 'Publication'} socket ownership changed`);
    unlinkSync(path);
  }

  /** Preview and publication use one socket-forwarder transport. Their lifecycle remains with each caller:
   *  previews retain a lease and release handle, while publications retain a durable database record. */
  async function startForwarder(row, name, port, kind, start) {
    const spec = specFor(row.spec);
    const socketPath = join(spec.storageRoot, 'broker', name);
    if (Buffer.byteLength(socketPath) > 107) throw error(`${kind}_path_limit`, `${kind === 'preview' ? 'Preview' : 'Publication'} socket path exceeds the operating-system limit`);
    removeForwarderSocket(socketPath, kind);
    await start(spec, ['/usr/bin/python3', '-c', PREVIEW_HELPER, String(port), `/run/elowen/${name}`]);
    const deadline = Date.now() + 10000;
    for (;;) {
      try { if (lstatSync(socketPath).isSocket()) break; throw error(`${kind}_socket_changed`, `${kind === 'preview' ? 'Preview' : 'Publication'} transport is not a socket`); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      if (Date.now() >= deadline) throw error(`${kind}_timeout`, `${kind === 'preview' ? 'Preview' : 'Publication'} transport did not become ready`);
      await wait(50);
    }
    return socketPath;
  }

  async function withPublicationMutation(key, mutate) {
    const previous = publicationMutations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(mutate);
    publicationMutations.set(key, current);
    try { return await current; }
    finally { if (publicationMutations.get(key) === current) publicationMutations.delete(key); }
  }

  function establishPublication(row, publicationId, port) {
    return startForwarder(row, publicationSocketName(publicationId), port, 'publication',
      (spec, argv) => runtimeFor(spec).startPublication(spec, publicationId, argv));
  }

  function publicationSocketReady(row, publicationId) {
    const path = join(specFor(row.spec).storageRoot, 'broker', publicationSocketName(publicationId));
    try { return lstatSync(path).isSocket(); }
    catch (cause) { if (cause.code === 'ENOENT') return false; throw cause; }
  }

  async function publicationForwarderActive(row, publicationId) {
    if (!publicationSocketReady(row, publicationId)) return false;
    const spec = specFor(row.spec);
    const active = await runtimeFor(spec).activePublications(spec, [publicationId]);
    return active.includes(publicationId);
  }

  /** Every publication of one project, established again after the container that carried them ended.
   *  A transport that cannot be established must not fail the environment start — the container is up and
   *  everything else about the project is usable — so it is named and reconciliation retries it. */
  async function establishPublications(row) {
    for (const publication of store.publications(Number(row.resource_id))) {
      const key = `${row.resource_id}:${publication.publicationId}`;
      try {
        await withPublicationMutation(key, async () => {
          if (await publicationForwarderActive(row, publication.publicationId)) return;
          await establishPublication(row, publication.publicationId, publication.port);
        });
      } catch (cause) {
        store.log(row.kind, row.resource_id, `publication ${publication.publicationId} forwarder could not be established: ${cause.message}`);
      }
    }
  }

  /** A published transport is DURABLE and account-independent: its record is keyed by the project and the
   *  publication, and no execution lease is taken, because the visitor it answers is nobody's account. */
  async function projectPublicationBinding(input) {
    assertLive();
    const id = projectId(input.project);
    const publicationId = resourceToken(String(input.publicationId ?? ''));
    if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535) throw error('invalid_port', 'Invalid guest publication port', 400);
    return await withPublicationMutation(`${id}:${publicationId}`, async () => {
      const existing = store.publications(id).find((publication) => publication.publicationId === publicationId);
      let row;
      if (input.accountUserId === undefined) {
        if (!existing || existing.port !== input.port) throw error('publication_identity_required', 'An account is required to create or change a publication binding', 403);
        row = store.get('project', id);
        if (!row || row.state !== 'running' || store.active('project', id)) throw error('environment_stopped', 'The publication project environment is not running');
        const running = specFor(row.spec);
        if ((await runtimeFor(running).inspect(running))?.state !== 'running') throw error('runtime_unavailable', 'The validated container is not running', 503);
      } else {
        account(input.accountUserId, true);
        row = await ready(id, input.accountUserId);
        // `ready` awaited a runtime inspection, so the environment it validated can have been stopped,
        // restarted, deleted or taken over by a lifecycle operation since. The record is written inside the
        // transaction that re-reads the row — the same fence an execution lease is minted behind — so a
        // publication can never be recorded against a generation the environment has left, and the forwarder
        // below is always established for the specification that is current. The record still comes FIRST:
        // it is the whole of the durability claim, and a transport that cannot be established on this
        // attempt is then reconciliation's to establish rather than the caller's to ask for again.
        row = store.transaction(() => {
          const current = store.get('project', id);
          if (!current || current.generation !== row.generation || current.state !== 'running'
            || store.active('project', id) || releasingAdoptions.has(Number(id))) {
            throw error('environment_busy', 'Environment changed before the publication could be bound');
          }
          store.savePublication(current, publicationId, input.port);
          return current;
        });
      }
      const socketPath = await establishPublication(row, publicationId, input.port);
      return { generation: row.generation, socketPath };
    });
  }

  /** The only thing that takes a publication away again: stop its forwarder when the container is running,
   *  remove the socket it left, then retire the durable record. */
  async function projectPublicationRelease(input) {
    assertLive();
    const id = projectId(input.project);
    const publicationId = resourceToken(String(input.publicationId ?? ''));
    await withPublicationMutation(`${id}:${publicationId}`, async () => {
      const row = store.get('project', id);
      if (row) {
        const spec = specFor(row.spec);
        if ((await runtimeFor(spec).inspect(spec))?.state === 'running') await runtimeFor(spec).stopPublication(spec, publicationId);
        removeForwarderSocket(join(spec.storageRoot, 'broker', publicationSocketName(publicationId)), 'publication');
      }
      store.removePublication(id, publicationId);
    });
  }

  async function releaseAdoptedWorkspace(input) {
    account(input.accountUserId, true);
    const id = projectId(input.project);
    if (reconcileInFlight || releasingAdoptions.has(id)) throw error('environment_busy', 'Environment reconciliation is already running');
    releasingAdoptions.add(id);
    try {
      const project = await authorize(id, input.accountUserId, true);
      if (!project.adoptedPath) throw error('project_not_adopted', 'Project was not adopted', 409);
      await assertNoPublishedSites(id);
      const row = store.get('project', id);
      if (!row) return;
      if (neverMaterialized(row)) {
        // The workspace was never moved into an environment, so there is nothing to move back and nothing
        // the runtime holds. Only the row this project accumulated goes.
        store.transaction(() => {
          for (const table of ['p_sandbox_runtime_operations', 'p_sandbox_runtime_snapshots', 'p_sandbox_runtime_logs', 'p_sandbox_runtimes']) {
            db.prepare(`DELETE FROM ${table} WHERE kind=? AND resource_id=?`).run('project', String(id));
          }
        });
        return;
      }
      if (store.active('project', id)) throw error('environment_busy', 'An environment lifecycle operation is already pending');
      if (store.publications(id).length) throw error('published_sites_exist', 'Transfer or delete this Project\'s published Sites before releasing the Project');
      const snapshots = store.snapshots('project', id);
      const recipes = new Map([[specFor(row.spec).name, row.spec]]);
      for (const saved of snapshots) { const recipe = JSON.parse(saved.spec_json); recipes.set(specFor(recipe).name, recipe); }
      for (const entry of db.prepare('SELECT checkpoint_json FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=?').all('project', String(id))) {
        const checkpoint = JSON.parse(entry.checkpoint_json);
        for (const key of ['oldSpec', 'newSpec']) if (checkpoint[key]) recipes.set(specFor(checkpoint[key]).name, checkpoint[key]);
      }
      for (const recipe of recipes.values()) {
        const owned = specFor(recipe);
        if (await runtimeFor(owned).inspect(owned)) {
          await stopRow({ ...row, spec: recipe, generation: recipe.input.generation });
          await runtimeFor(owned).remove(owned);
        }
      }
      const spec = specFor(row.spec);
      await storage.releaseWorkspace(spec, project.adoptedPath);
      await runtimeFor(spec).removeStorage(spec);
      store.transaction(() => {
        db.prepare('DELETE FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=?').run('project', String(id));
        db.prepare('DELETE FROM p_sandbox_runtime_snapshots WHERE kind=? AND resource_id=?').run('project', String(id));
        db.prepare('DELETE FROM p_sandbox_execution_leases WHERE resource_kind=? AND resource_id=?').run('project', String(id));
        db.prepare('DELETE FROM p_sandbox_file_uploads WHERE resource_kind=? AND resource_id=?').run('project', String(id));
        db.prepare('DELETE FROM p_sandbox_managed_worktrees WHERE project_id=?').run(id);
        db.prepare('DELETE FROM p_sandbox_runtime_logs WHERE kind=? AND resource_id=?').run('project', String(id));
        db.prepare('DELETE FROM p_sandbox_runtimes WHERE kind=? AND resource_id=?').run('project', String(id));
      });
    } finally { releasingAdoptions.delete(id); }
  }

  async function projectPreviewBinding(input) {
    account(input.accountUserId, true);
    const id = projectId(input.project);
    if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535) throw error('invalid_port', 'Invalid guest preview port', 400);
    const row = await ready(id, input.accountUserId);
    const spec = specFor(row.spec);
    const leased = await mint(row, input.accountUserId, 'preview');
    const handle = leaseHandle(row, leased);
    const name = `p-${leased.execution_id.slice(0, 16)}.sock`;
    const socketPath = join(spec.storageRoot, 'broker', name);
    let timer;
    let releasing;
    const release = () => {
      if (releasing) return releasing;
      releasing = (async () => {
        clearInterval(timer);
        await handle.release();
        removeForwarderSocket(socketPath, 'preview');
        previews.delete(release);
      })().catch((cause) => { releasing = null; throw cause; });
      return releasing;
    };
    previews.add(release);
    try {
      await startForwarder(row, name, input.port, 'preview', (owned, argv) => runtimeFor(owned).startPreview(owned, leased.execution_id, argv));
      await handle.heartbeat();
      timer = setInterval(() => { handle.heartbeat().catch(() => release().catch((cause) => store.log(row.kind, row.resource_id, `Preview cleanup failed: ${cause.message}`))); }, 5000);
      timer.unref?.();
      return { projectId: id, generation: row.generation, port: input.port, socketPath, release };
    } catch (cause) { await release(); throw cause; }
  }

  const metricStates = new Set(['ready', 'sampling', 'stopped', 'unavailable']);
  const finiteOrNull = (value) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
  function validResourceMetric(metric, kind) {
    if (!metric || typeof metric !== 'object' || !metricStates.has(metric.state)) return false;
    if (kind === 'cpu') return finiteOrNull(metric.usedCpus) && finiteOrNull(metric.percent)
      && (metric.state !== 'ready' || (typeof metric.usedCpus === 'number' && typeof metric.percent === 'number'))
      && (metric.model === undefined || metric.model === null || typeof metric.model === 'string');
    return finiteOrNull(metric.usedBytes) && finiteOrNull(metric.limitBytes)
      && (metric.state !== 'ready' || typeof metric.usedBytes === 'number');
  }
  function validResources(resources) {
    return resources && typeof resources === 'object'
      && validResourceMetric(resources.cpu, 'cpu')
      && validResourceMetric(resources.memory, 'memory')
      && validResourceMetric(resources.disk, 'disk');
  }
  function storedResources(row) {
    if (typeof row.resource_snapshot_json !== 'string' || !Number.isSafeInteger(row.resource_sampled_at) || row.resource_sampled_at < 0) return null;
    try {
      const snapshot = JSON.parse(row.resource_snapshot_json);
      if (!snapshot || snapshot.generation !== row.generation || !Number.isSafeInteger(snapshot.epoch) || snapshot.epoch < 0
        || !validResources(snapshot.resources)) return null;
      return { resources: snapshot.resources, epoch: snapshot.epoch, sampledAt: row.resource_sampled_at, stale: snapshot.stale === true };
    } catch { return null; }
  }
  function unavailableResources(environment) {
    const active = ['running', 'starting'].includes(environment.state);
    return {
      cpu: { state: active ? 'unavailable' : 'stopped', usedCpus: null, percent: null, model: hostCpuModel },
      memory: { state: active ? 'unavailable' : 'stopped', usedBytes: null, limitBytes: environment.limits.memoryMb * 1024 * 1024 },
      disk: { state: 'unavailable', usedBytes: null, limitBytes: null },
    };
  }
  const measuredState = (metric) => metric.state === 'ready' || metric.state === 'stopped';
  /** A per-resource probe may fail inside an otherwise successful batch. Keep a prior measured figure for
   * only that resource, and persist that retention as stale metadata so a restart remains equally honest. */
  function retainMeasuredResources(previous, measured) {
    let stale = false;
    const resources = {};
    for (const kind of ['cpu', 'memory', 'disk']) {
      if (measuredState(measured[kind]) || !previous || previous[kind]?.state !== 'ready') resources[kind] = measured[kind];
      else { resources[kind] = previous[kind]; stale = true; }
    }
    return { resources, stale };
  }
  function clearResourceFailures(row) {
    const prefix = `${row.kind}:${row.resource_id}:`;
    for (const key of resourceRefreshFailures.keys()) if (key.startsWith(prefix)) resourceRefreshFailures.delete(key);
  }
  /** Begin one shared nspawn measurement for the rows this read found stale. It is deliberately detached
   * from the response: Project cards render the durable snapshot first, then ordinary polling observes the
   * completed write. Generation, invalidation epoch and refresh start time fence every write. */
  function refreshResources(entries) {
    const pending = entries.filter((entry) => !resourceRefreshes.has(entry.key));
    if (!pending.length || typeof nspawn?.resourceUsageBatch !== 'function') return;
    const startedAt = Date.now();
    let refresh;
    refresh = (async () => {
      try {
        const measured = await nspawn.resourceUsageBatch(pending.map(({ spec, state }) => ({ spec, state })));
        if (!Array.isArray(measured) || measured.length !== pending.length) throw new Error('Invalid resource usage batch');
        const resources = measured.map((value) => ({ ...value, cpu: { ...value?.cpu, model: hostCpuModel } }));
        if (resources.some((value) => !validResources(value))) throw new Error('Invalid resource usage values');
        const updates = resources.map((value, index) => retainMeasuredResources(storedResources(pending[index].row)?.resources, value));
        const sampledAt = Date.now();
        store.transaction(() => pending.forEach((entry, index) => {
          if (store.saveResourceSnapshot(entry.row, updates[index].resources, updates[index].stale, sampledAt, startedAt)) clearResourceFailures(entry.row);
        }));
      } catch (cause) {
        const message = String(cause?.message ?? cause).slice(0, 500);
        for (const entry of pending) resourceRefreshFailures.set(entry.key, message);
        ctx.logger.warn(`Project resource usage refresh failed: ${message}`);
      } finally {
        for (const entry of pending) if (resourceRefreshes.get(entry.key) === refresh) resourceRefreshes.delete(entry.key);
      }
    })();
    for (const entry of pending) resourceRefreshes.set(entry.key, refresh);
  }

  /** One authorized read for every managed row currently visible in the Project register. Authorization for
   * the WHOLE batch finishes before any runtime row is read. The response contains only persisted values and
   * starts one deduplicated background refresh for rows whose snapshot is missing, invalidated or old. */
  async function environmentUsageBatch(input) {
    account(input?.accountUserId, false);
    if (!Array.isArray(input?.projectIds) || input.projectIds.length < 1 || input.projectIds.length > 1000
      || new Set(input.projectIds).size !== input.projectIds.length
      || input.projectIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw error('invalid_project_ids', 'A bounded list of Project ids is required', 400);
    for (const id of input.projectIds) await authorize(id, input.accountUserId, false);

    const now = Date.now();
    const projects = [];
    const refreshable = [];
    for (const id of input.projectIds) {
      const row = store.get('project', id);
      const environment = row ? view(row) : { projectId: id, generation: 1, state: 'unprovisioned', desiredState: 'running', lastError: null,
        limits: configuredDefaults(ctx.config), network: configuredNetwork(ctx.config) };
      const snapshot = row ? storedResources(row) : null;
      const key = row ? resourceKey(row) : null;
      const stale = snapshot === null ? key !== null && resourceRefreshFailures.has(key)
        : snapshot.stale || snapshot.epoch !== row.resource_refresh_epoch
          || now - snapshot.sampledAt >= RESOURCE_USAGE_TTL_MS || resourceRefreshFailures.has(key);
      const project = { projectId: id, environment, sampledAt: snapshot ? new Date(snapshot.sampledAt).toISOString() : null,
        stale, refreshing: false, resources: snapshot?.resources ?? unavailableResources(environment) };
      projects.push(project);
      if (!row || neverMaterialized(row) || row.state === 'deleted') continue;
      try {
        const entry = { key, row, spec: specFor(row.spec), state: row.state };
        if (!snapshot || stale) refreshable.push(entry);
      } catch { /* The current environment remains visible; an unreadable legacy spec has no safe probe. */ }
    }
    refreshResources(refreshable);
    for (const project of projects) {
      const row = store.get('project', project.projectId);
      if (row) project.refreshing = resourceRefreshes.has(resourceKey(row));
    }
    const sampled = projects.map((project) => project.sampledAt).filter(Boolean).map((value) => Date.parse(value));
    return { sampledAt: sampled.length ? new Date(Math.min(...sampled)).toISOString() : null, projects };
  }

  const control = {
    projectPreviewBinding, projectPublicationBinding, projectPublicationRelease, releaseAdoptedWorkspace,
    async environmentFor(input) {
      const id = projectId(input.project);
      await authorize(id, input.accountUserId, true);
      const row = store.get('project', id);
      // An unprovisioned project has no stored limits yet, so it reports the defaults it WOULD be
      // created with rather than the built-in figures the administrator may have moved away from.
      return row ? await environmentView(row) : { projectId: id, generation: 1, state: 'unprovisioned', desiredState: 'running', lastError: null,
        limits: configuredDefaults(ctx.config), network: configuredNetwork(ctx.config) };
    },
    async projectOverview(input) {
      const environment = await control.environmentFor(input);
      const id = projectId(input.project);
      const operations = store.recentOperations('project', id, OPERATION_HISTORY).map(operationView);
      return { environment, runtime: await runtimeView(store.get('project', id)),
        snapshots: await snapshots(id, input.accountUserId), operations };
    },
    requestEnvironment: (input) => request(projectId(input.project), input),
    machineRuntimeReadiness: async (input) => {
      account(input.accountUserId, false);
      if (!stores().usersRead.isAdmin(input.accountUserId)) throw error('admin_required', 'Only administrators may read host runtime readiness', 403);
      return await machineReadiness();
    },
    provisionMachineRuntime,
    environmentOperation: getOperation, projectFileRoot, projectFiles, revokeProjectAccess,
    environmentSnapshots: (input) => snapshots(projectId(input.project), input.accountUserId),
    environmentLogs: (input) => logs(projectId(input.project), input.accountUserId, input.lines), managedWorktrees,
  };
  return { ...control, control, environmentUsageBatch, prepareExecution, reconcile,
    async revokeAccount(userId) { for (const row of store.all().filter((entry) => entry.kind === 'project')) await cancelLeases(row, userId); },
    async dispose() {
      disposed = true;
      // A sweep already under way is WAITED FOR, not abandoned: it may be part-way through a machine start
      // or stop, and the generation that replaces this one would otherwise run a sweep of its own over the
      // same rows and the same host at the same time. Every loop of the sweep — the host operations, the
      // legacy Site retirements, the environments, the operations, the leases and the publications — breaks
      // on this flag, so this waits for one unit of work at most. A failure of the sweep is its own caller's
      // to report, and it never reaches here: the marker only says the sweep has ended.
      const sweep = reconcileInFlight;
      if (sweep) await sweep;
      // A resource refresh admitted by the detached runtime may still hold an nspawn sample and a database
      // write. Wait for it so plugin reload cannot leave an unowned writer behind; its durable CAS still
      // fences a newer lifecycle generation or a refresh that began later.
      await Promise.allSettled([...new Set(resourceRefreshes.values())]);
      // A publication binding or release that was already admitted keeps going after the detach: it holds
      // the publication lock, and the forwarder it is spawning would otherwise be created by a generation
      // that is going away and outlive it. `assertLive()` precedes registration in both entry points, so
      // every promise held here is work this generation admitted while it was still live.
      await Promise.allSettled([...publicationMutations.values()]);
      for (const release of [...previews]) await release();
    } };
}
