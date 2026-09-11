import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join, posix } from 'node:path';
import { exportProjectTree, removeOwnedArtifact } from './environmentExport.mjs';
import { manageWorktrees } from './managedWorktrees.mjs';
import { createSiteImageService } from './environmentSiteImages.mjs';
import { createSiteCleanupService } from './environmentSiteCleanup.mjs';
import { createGuestFileTransport, validateUploadOperation, UPLOAD_KINDS } from './guestFileTransport.mjs';
import { managedShellFrame, synchronousShellFrame } from './managedBootstrap.mjs';
import { createEnvironmentStore, isRequestId, operationView, OPERATION_HISTORY } from './environmentDb.mjs';
import { ownerProvablyDead, processIdentity, withRepoLease } from './db.mjs';
import { createContainerSpec, createEnvironmentDiskSpec, createLegacyProjectSpec, createBoundSiteSpec, withContainerLimits, hostPath, resourceToken, bindContainerIdentity, publicationRuntimeToken } from './containerSpec.mjs';
import { managedGuestRoot } from './containerPaths.mjs';
import { PodmanClient } from './podman.mjs';
import { NspawnClient } from './nspawn.mjs';
import { selectRuntimeClient } from './runtimeClient.mjs';
import { ContainerStorage } from './containerStorage.mjs';
import { PROJECT_BASE_IMAGE_TAG } from './containerBaseImage.mjs';

const FILE_HELPER = readFileSync(new URL('./guestFiles.py', import.meta.url), 'utf8');
const PREVIEW_HELPER = readFileSync(new URL('./previewProxy.py', import.meta.url), 'utf8');
const DEFAULT_LIMITS = { cpus: 1, memoryMb: 1024, pidsLimit: 512 };
const LIMIT_KEYS = Object.keys(DEFAULT_LIMITS);
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
  'migrate-disk': [['quiesce', 1], ['stop', 2], ['export', 8], ['materialize', 8], ['storage', 1], ['container', 2], ['boot', 2], ['verify', 2], ['switch', 1], ['cleanup', 1]],
  // A runtime change copies nothing. Its one long step is the ownership pass over the existing tree; the
  // envelope that replaces the container is a handful of configuration files.
  'migrate-runtime': [['quiesce', 1], ['stop', 2], ['shift', 8], ['container', 1], ['boot', 2], ['verify', 2], ['switch', 1], ['cleanup', 1]],
  delete: [['stop', 2], ['containers', 2], ['images', 2], ['volumes', 2], ['storage', 2], ['records', 1]],
};
/** Every Sites-only action and the image jobs: one step, honestly unlabelled, rather than a fabricated
 *  breakdown of work whose shape nobody has described. */
const DEFAULT_STEPS = [['work', 1]];
/** Two of the steps above are a PROJECT's: waiting for the guest system bus, and the quiesce that
 *  cancels leases and guest transfers. A Site takes neither, so declaring them to a Site's watcher
 *  would name work that is never going to happen. */
const PROJECT_STEPS = ['ready', 'quiesce'];
/** Podman prints `STEP 4/17: RUN …` while it builds and `Copying blob … 12MB / 40MB` while it pulls. The
 *  first is a real fraction of a known whole; the second is a byte count of one layer among several, so
 *  it is reported as indeterminate rather than turned into a percentage of nothing. */
export function buildFraction(line) {
  const step = /^STEP\s+(\d+)\/(\d+)\b/.exec(String(line).trim());
  if (!step || Number(step[2]) <= 0) return null;
  return Math.min(1, Number(step[1]) / Number(step[2]));
}
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
function action(value, kind) {
  if (!value || typeof value !== 'object') throw error('invalid_action', 'An environment action is required', 400);
  // `recreate` is a project-only repair: it removes the container this runtime can no longer verify and
  // builds a new one from the current specification. The storage volumes are untouched, so the project's
  // files come back with it — which is exactly why it is an explicit action and never an automatic one.
  // `migrate-disk` turns a legacy image-backed environment into a rootfs-backed one. It is the same
  // shape for a project and for a Site because the disk, not the resource kind, is what it changes.
  // `migrate-runtime` moves an environment that is ALREADY on a persistent disk from Podman to
  // systemd-nspawn. It copies nothing: the same disk keeps running under a different envelope.
  const fields = { start: [], stop: [], restart: [], delete: [], snapshot: ['note', 'includeData'], restore: ['snapshotId', 'restoreData'], limits: ['limits'], 'migrate-disk': [], 'migrate-runtime': [],
    ...(kind === 'project' ? { recreate: [] } : {}),
    ...(kind === 'site' ? { prepare: [], 'cleanup-stage': [], 'provision-image': ['imageKind'], 'import-data': ['artifactId'], 'export-data': ['artifactId'], 'import-snapshot': ['artifactId'], 'remove-artifact': ['artifactId'], 'export-project': ['artifactId'] } : {}) };
  if (value.imageKind !== undefined && !['base', 'static', 'node'].includes(value.imageKind)) throw error('invalid_action', 'Unknown fixed Sites image recipe', 400);
  for (const key of ['artifactId', 'snapshotId']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value[key]))) throw error('invalid_action', 'Invalid retained artifact identity', 400);
  if (!Object.hasOwn(fields, value.kind) || Object.keys(value).some((key) => key !== 'kind' && !fields[value.kind].includes(key))) throw error('invalid_action', 'Invalid environment action', 400);
  if (value.kind === 'snapshot' && value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 2000)) throw error('invalid_action', 'Snapshot note exceeds its bound', 400);
  for (const key of ['includeData', 'restoreData']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw error('invalid_action', 'Invalid data policy', 400);
  if (kind === 'project' && (value.includeData === false || value.restoreData === false)) throw error('invalid_action', 'Project snapshots and restores require every component', 400);
  for (const key of ['artifactId', 'snapshotId', 'imageKind']) if (fields[value.kind].includes(key) && typeof value[key] !== 'string') throw error('invalid_action', `Missing ${key}`, 400);
  return value.kind === 'limits' ? { kind: 'limits', limits: limits(value.limits) } : { ...value };
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
function fileOperation(op) {
  if (UPLOAD_KINDS.includes(op?.kind)) return validateUploadOperation(op);
  const keys = { stat: ['followSymlinks'], list: ['limit', 'cursor', 'metadata'], read: ['maxBytes', 'offset', 'length'], write: ['base64', 'expectedVersion'], remove: ['expectedVersion'], mkdir: [], rename: ['destination', 'expectedVersion'], walk: ['limit', 'skip', 'maxDepth'], search: ['pattern', 'glob', 'caseSensitive', 'limit'] };
  if (op?.followSymlinks !== undefined && typeof op.followSymlinks !== 'boolean') throw error('invalid_operation', 'followSymlinks must be boolean', 400);
  if (!op || !Object.hasOwn(keys, op.kind) || Object.keys(op).some((key) => !['kind', 'path', ...keys[op.kind]].includes(key))) throw error('invalid_operation', 'Invalid guest file operation', 400);
  guestPath(op.path);
  if (op.kind === 'rename') guestPath(op.destination);
  if (['write', 'remove', 'rename'].includes(op.kind) && !Object.hasOwn(op, 'expectedVersion')) throw error('version_required', 'A content version is required', 400);
  if (Buffer.byteLength(JSON.stringify(op)) > 1024 * 1024) throw error('input_limit', 'Guest input exceeds its bound', 400);
  return op;
}

/** One underlying coordinator for projects and Sites. Forks only write durable intents and execute
 * already-running validated targets. Only daemon reconciliation performs container lifecycle changes. */
export function createEnvironmentRuntime({ ctx, db, dataDir, namespace = 'elowen', podman = new PodmanClient({ outputLimitBytes: 16 * 1024 * 1024 }),
  nspawn = new NspawnClient({ images: podman, namespace, outputLimitBytes: 16 * 1024 * 1024 }),
  storage = new ContainerStorage(podman, { nspawn }), daemon = typeof process.send !== 'function' }) {
  const store = createEnvironmentStore(db, processIdentity);
  /** Which runtime drives THIS specification. The disk record is the only discriminator, so an
   *  environment that has not been migrated keeps running on Podman and a migration can hold both
   *  envelopes of the same environment at once without either client learning about the other. */
  const runtimeFor = (spec) => selectRuntimeClient(spec, { podman, nspawn });
  const transfers = createGuestFileTransport({ db, helperSource: FILE_HELPER, runGuest,
    runCleanup: async (row, _userId, argv, options) => {
      const current = store.get(row.kind, row.resource_id);
      if (!current || current.generation !== row.generation) throw error('generation_changed', 'Upload cleanup generation changed');
      const spec = specFor(row.spec);
      if ((await runtimeFor(spec).inspect(spec))?.state !== 'running') throw error('upload_cleanup_pending', 'Start the environment to clean up its unfinished uploads');
      return await runtimeFor(spec).exec(spec, randomUUID().replaceAll('-', ''), argv, { ...options, persistent: true });
    },
  });
  let sites;
  let disposed = false;
  const AUTO_RECOVERY_DELAYS_MS = [0, 30_000, 120_000, 600_000];
  // Longer than every retry delay, so a container that dies when attempt four becomes eligible cannot be
  // mistaken for one that completed a genuinely stable run.
  const AUTO_RECOVERY_STABILITY_MS = 15 * 60_000;
  let reconciling = false;
  const releasingAdoptions = new Set();
  const previews = new Set();
  const publicationEstablishments = new Map();
  const publicationRecoveryStates = new Map();
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
  async function authorize(kind, id, userId, manage = false, internal = false) {
    if (!internal) account(userId);
    else if (!stores().usersRead.list().some((user) => user.id === userId) || !stores().usersRead.mayUsePlugin(userId, 'sandbox')) throw error('account_forbidden', 'Account access is unavailable', 403);
    if (kind === 'project') {
      const scope = ctx.currentAccess();
      // The narrowing below is a TURN's: a selected Project, an exact workspace, the policy's project list.
      // An authenticated API request has none of those — it is an identity, so `projectIds` is empty and
      // `admin` false even for an administrator, and reading them as a turn scope refused every member and
      // every admin on their own Project. `apiRequest` is the host's positive marker for that scope and is
      // the only thing that skips the narrowing; absence still denies, so no policy is never a way in. What
      // authorizes the request is what authorized it before it reached here (`auth.accessibleProjects` on
      // the API surface) plus the freshly resolved membership below, which revocation still refuses.
      if (!internal && !scope.apiRequest && ctx.currentAccountUserId() != null && (scope.workspaceRef || (scope.projectRef && scope.projectRef.projectId !== Number(id)) || (!scope.admin && scope.projectIds && !scope.projectIds.includes(Number(id))))) throw error('project_scope', 'Project is outside the current turn scope', 403);
      const project = stores().projects.get(Number(id));
      if (!project || project.executionKind !== 'managed' || !(manage ? stores().userProjects.canManage(userId, project.id) : stores().userProjects.canAccess(userId, project.id))) throw error('project_forbidden', 'Project access is denied', 403);
      return project;
    }
    resourceToken(String(id));
    if (!sites) throw error('sites_unavailable', 'The Sites runtime authority is unavailable', 503);
    const registration = await sites.resolve({ siteId: String(id), accountUserId: userId, access: manage ? 'manage' : 'read' });
    if (!registration || registration.siteId !== String(id)) throw error('site_forbidden', 'Site access is denied', 403);
    return registration;
  }
  function siteRecord(registration, generation) {
    const effective = limits(registration.limits);
    const resource = { kind: 'site', id: registration.siteId };
    const disk = registration.persistentRootfs
      ? createEnvironmentDiskSpec({ resource, image: registration.image }, { sitesDataDir: registration.sitesDataDir, namespace }, randomUUID().replaceAll('-', ''))
      : undefined;
    return { registration, input: { resource, generation, image: registration.image, ...(disk ? { disk } : {}), network: registration.network,
      workspaceReadOnly: registration.workspaceReadOnly, limits: { cpus: effective.cpus, memoryMb: effective.memoryMb, pidsLimit: effective.pidsLimit } },
      binding: { namespace, sitesDataDir: registration.sitesDataDir, sourcePath: registration.sourcePath, brokerDir: registration.brokerDir } };
  }
  /** Where this project is mounted inside its own container — persisted with the row, so renaming the
   *  project later cannot silently change a running container's identity. */
  const rootOf = (row) => row.spec.input.workspaceTarget;
  function specFor(record, cleanup = false) {
    const input = { ...record.input, limits: record.creationLimits ?? record.input.limits };
    const base = input.resource.kind === 'site'
      ? createBoundSiteSpec(input, record.binding)
      : cleanup && input.workspaceTarget === undefined
        ? createLegacyProjectSpec(input, record.paths)
        : createContainerSpec(input, record.paths);
    const spec = same(input.limits, record.input.limits) ? base : withContainerLimits(base, record.input.limits);
    return record.containerId ? bindContainerIdentity(spec, record.containerId) : spec;
  }
  const siteBinding = (value, relative = true) => Object.fromEntries(Object.entries(value).filter(([key]) => !['limits', 'initialIntent', 'snapshotRetention', 'staging'].includes(key)
    && !(relative && key === 'sourcePath' && typeof value.sourceRel === 'string')).sort(([a], [b]) => a.localeCompare(b)));
  const upgradesLegacySiteBinding = (stored, authority) => {
    if (typeof stored?.sourceRel === 'string' || typeof authority?.sourceRel !== 'string') return false;
    const candidate = { ...authority };
    delete candidate.sourceRel;
    return same(siteBinding(stored, false), siteBinding(candidate, false));
  };
  async function rowFor(kind, id, userId, manage = false, internal = false, allowBindingHandover = false) {
    const authority = await authorize(kind, id, userId, manage, internal);
    let row = store.get(kind, id);
    if (kind === 'site') {
      if (!row) throw error('site_not_registered', 'Register the trusted Site binding before requesting lifecycle work');
      if (!allowBindingHandover && !same(siteBinding(authority), siteBinding(row.spec.registration))) throw error('site_binding_changed', 'The trusted Site binding changed; an explicit handover is required');
    }
    if (row && kind === 'project' && !row.spec.input.workspaceTarget) {
      // A row created before project mounts carried a name was built against `/workspace`. Fill in the
      // mount point it will use from now on and remember that its existing container predates it: the
      // spec identity changed, so that container must never be adopted.
      row.spec.input.workspaceTarget = managedGuestRoot(authority.slug, Number(id));
      row.spec.legacyWorkspaceLayout = true;
      store.save(row);
      ctx.logger.warn(`project ${id} environment predates the named project mount; its container must be recreated at ${row.spec.input.workspaceTarget}`);
    }
    if (!row) {
      const effective = configuredDefaults(ctx.config);
      const paths = { sandboxDataDir: dataDir, namespace };
      const resource = { kind: 'project', id: Number(id) };
      const disk = createEnvironmentDiskSpec({ resource, image: PROJECT_BASE_IMAGE_TAG }, paths, randomUUID().replaceAll('-', ''));
      const spec = { input: { resource, generation: 1, image: PROJECT_BASE_IMAGE_TAG, disk, previewBroker: true, workspaceTarget: managedGuestRoot(authority.slug, Number(id)), limits: { cpus: effective.cpus, memoryMb: effective.memoryMb, pidsLimit: effective.pidsLimit } }, paths };
      row = store.insert(kind, id, Number(id), spec, effective);
    }
    return row;
  }
  const view = (row) => ({ [row.kind === 'project' ? 'projectId' : 'siteId']: row.kind === 'project' ? Number(row.resource_id) : row.resource_id,
    generation: row.generation, state: row.state, desiredState: row.desired_state, lastError: row.error ?? null, limits: effectiveLimits(row.limits) });
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
        data: { operation: operationView(op), logTail: store.logTail(op.kind, op.resource_id, 40) } });
    } catch (cause) { ctx.logger.warn(`environment operation progress was not published: ${cause.message}`); }
  }
  const checkpoint = (op, values) => { Object.assign(op.checkpoint, values); store.saveOperation(op); publishOperation(op, false); };
  const stepPlan = (op) => (STEP_PLANS[op.action?.kind] ?? DEFAULT_STEPS).filter(([id]) => op.kind === 'project' || !PROJECT_STEPS.includes(id));
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
    if (sites && !sites.projectDependents) throw error('sites_preflight_unavailable', 'Sites must provide publication-dependency preflight before Project deletion');
    const published = sites ? await sites.projectDependents(Number(id)) : [];
    if (published.length || store.all().some((site) => site.kind === 'site' && site.project_id === Number(id) && site.state !== 'deleted')) throw error('published_sites_exist', 'Transfer or delete this Project\'s published Sites before deleting the Project');
  }

  async function request(kind, id, input) {
    assertLive();
    account(input.accountUserId, true);
    if (kind === 'project' && releasingAdoptions.has(Number(id))) throw error('environment_busy', 'An adopted workspace is being released');
    const requested = action(input.action, kind);
    const bindingHandover = kind === 'site' && requested.kind === 'delete' && input.handover === true;
    await rowFor(kind, id, input.accountUserId, true, false, bindingHandover);
    if (requested.kind === 'delete' && kind === 'project') await assertNoPublishedSites(id);
    if (input.requestId !== undefined && !isRequestId(input.requestId)) throw error('invalid_request_id', 'Invalid idempotency key', 400);
    return store.transaction(() => {
      account(input.accountUserId, true);
      if (kind === 'project' && !stores().userProjects.canManage(input.accountUserId, Number(id))) throw error('project_forbidden', 'Project access was revoked', 403);
      const row = store.get(kind, id);
      if (!row) throw error('environment_missing', 'Environment metadata changed');
      let active = store.active(kind, id);
      const prior = input.requestId ? store.prior(kind, id, input.accountUserId, input.requestId) : null;
      if (prior && !same(prior.action, requested)) throw error('request_conflict', 'Idempotency key belongs to another action');
      if (prior && prior.status !== 'failed') {
        if (bindingHandover && prior.checkpoint.bindingHandover !== true) {
          prior.checkpoint.bindingHandover = true;
          store.saveOperation(prior);
        }
        return operationView(prior);
      }
      assertGeneration(row, input.expectedGeneration);
      if (requested.kind === 'limits' && !stores().usersRead.isAdmin(input.accountUserId)) throw error('admin_required', 'Only administrators may change resource limits', 403);
      if (requested.kind === 'migrate-disk') {
        if (!stores().usersRead.isAdmin(input.accountUserId)) throw error('admin_required', 'Only administrators may migrate an environment to a persistent disk', 403);
        // A migration that has already switched the row still has its legacy envelope to remove, so the
        // request that carries its own idempotency key stays resumable; anything else is refused.
        if (row.spec.input.disk && !prior) throw error('already_rootfs_backed', 'This environment already runs on a persistent disk');
        // One migration on the host at a time. Each one exports a whole root filesystem and extracts it
        // again, so two of them share the free space this operation refuses to start without.
        const elsewhere = db.prepare(`SELECT id FROM p_sandbox_runtime_operations WHERE status IN ('pending','running')
          AND json_extract(action_json,'$.kind')='migrate-disk' AND NOT (kind=? AND resource_id=?)`).get(kind, String(id));
        if (elsewhere) throw error('migration_active', 'Another environment disk migration is already under way');
      }
      if (requested.kind === 'migrate-runtime') {
        if (!stores().usersRead.isAdmin(input.accountUserId)) throw error('admin_required', 'Only administrators may change an environment runtime', 403);
        if (!row.spec.input.disk && !prior) throw error('not_rootfs_backed', 'Migrate this environment to a persistent disk before changing its runtime');
        // A change that has already switched the row still has its Podman envelope to remove, so the
        // request that carries its own idempotency key stays resumable; anything else is refused.
        if (row.spec.input.disk?.runtime === 'nspawn' && !prior) throw error('already_nspawn', 'This environment already runs on systemd-nspawn');
      }
      if (row.state === 'deleted') throw error('environment_deleted', 'The environment has been deleted');
      if (row.desired_state === 'deleted' && requested.kind !== 'delete') throw error('environment_deleting', 'The environment is deleting');
      if (prior) {
        if (bindingHandover) prior.checkpoint.bindingHandover = true;
        if (!active) { prior.status = 'pending'; prior.error = null; store.saveOperation(prior); }
        else if (bindingHandover) store.saveOperation(prior);
        return operationView(prior);
      }
      if (active?.status === 'pending' && active.checkpoint.autoRecovery && ['stop', 'delete'].includes(requested.kind)) {
        active.status = 'failed'; active.error = `Superseded by explicit ${requested.kind}`; store.saveOperation(active); active = null;
      }
      if (active) {
        if (!input.requestId && active.user_id === input.accountUserId && same(active.action, requested)) {
          if (bindingHandover) { active.checkpoint.bindingHandover = true; store.saveOperation(active); }
          return operationView(active);
        }
        throw error('environment_busy', 'An environment lifecycle operation is already pending');
      }
      const op = store.enqueue(row, input.accountUserId, requested, input.requestId);
      if (bindingHandover) op.checkpoint.bindingHandover = true;
      if (requested.kind === 'delete') {
        if (kind === 'project' && !stores().projects.beginDeletion(Number(id))) throw error('project_deletion_changed', 'Core Project deletion intent could not be recorded');
        row.desired_state = 'deleted'; row.state = 'deleting';
      }
      else if (['start', 'restart', 'recreate'].includes(requested.kind)) row.desired_state = 'running';
      else if (requested.kind === 'stop') row.desired_state = 'stopped';
      store.save(row);
      // The declared step list exists from the moment the intent is durable, so the caller's very first
      // frame can name what is about to happen rather than an empty bar labelled "pending".
      declareSteps(op);
      store.saveOperation(op);
      return operationView(op);
    });
  }

  async function getOperation(kind, input) {
    account(input.accountUserId);
    const op = store.getOperation(input.operationId);
    if (!op || op.kind !== kind) return null;
    if (!(op.action.kind === 'delete' && op.status === 'succeeded' && op.user_id === input.accountUserId)) await authorize(kind, op.resource_id, input.accountUserId, true);
    // The single read a watcher makes before it starts listening: the operation AND the log tail the live
    // event carries, so a dialog opened mid-flight shows the same thing a dialog opened at the start does.
    return { ...operationView(op), logTail: store.logTail(op.kind, op.resource_id, 40) };
  }

  /** `verifyRuntime` false is for a caller whose very next step is a prepared or direct guest execution:
   *  that execution opens with the full ownership and running-state check, so the probe here observed
   *  nothing it would not observe a moment later and cost two Podman invocations to say it. The durable
   *  record checks above still run either way, so a stopped or pending environment is still refused here,
   *  cheaply and without ever reaching the container. */
  async function ready(kind, id, userId, verifyRuntime = true) {
    let row = await rowFor(kind, id, userId);
    if (row.state === 'unprovisioned') {
      await request(kind, id, { accountUserId: userId, action: { kind: 'start' } });
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        assertLive();
        if (daemon) await reconcile();
        row = await rowFor(kind, id, userId);
        if (!store.active(kind, id)) break;
        await wait(100);
      }
    }
    if (store.active(kind, id)) throw error('environment_pending', 'Environment lifecycle work is pending; retry after the operation completes', 503);
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
    await authorize(row.kind, row.resource_id, userId);
    return store.transaction(() => {
      const current = store.get(row.kind, row.resource_id);
      if ((row.kind === 'project' && releasingAdoptions.has(Number(row.resource_id))) || !current || current.generation !== row.generation || current.state !== 'running' || store.active(row.kind, row.resource_id)) throw error('environment_busy', 'Environment changed before execution could be leased');
      const other = store.leases(row.kind, row.resource_id).filter((lease) => lease.kind !== 'preview');
      if (other.some((lease) => lease.kind === 'worktrees') || (kind === 'worktrees' && other.length)) throw error('environment_busy', 'Managed worktree mutation requires an idle execution boundary');
      return store.mintLease(current, userId, kind);
    });
  }
  /** `settle` is the closure `PodmanClient.prepareExecution` bound to the execution this lease fences.
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
      id: lease.id, accountUserId: lease.user_id, workspaceId: null, homeGeneration: null,
      projectId: row.project_id, runtimeGeneration: row.generation,
      async heartbeat() {
        if (released) return;
        try { await authorize(row.kind, row.resource_id, lease.user_id); }
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
       *  that ran the execution through `PodmanClient.exec` may use this: that method releases or
       *  terminates the guest unit itself before returning, so repeating the release here inspected the
       *  container and every volume a second time and re-ran the whole termination probe — half the
       *  Podman invocations of a trivial file operation, spent proving again what had just been proven.
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
    if (input.workspace || ctx.currentAccess().workspaceRef) throw error('workspace_pinned', 'A legacy narrow workspace cannot widen into a managed Project', 403);
    const row = await ready('project', id, userId, false);
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
        // The client owns what goes on that pipe, not this function: Podman hands back the caller's own
        // bytes unchanged, while a transport whose privileged request travels ahead of them in the same
        // pipe hands back both. Returning `program.input` here would silently drop the request half.
        launch: prepared.launch, stdin: prepared.stdin, cancel: () => handle.cancel(), workspace: null, lease: handle,
        sanitizeOutput: sanitize };
    } catch (cause) { await handle.release(); throw cause; }
  }

  async function projectFiles(input) {
    const id = projectId(input.project);
    const op = fileOperation(input.operation);
    account(input.accountUserId, MUTATING_FILE_KINDS.has(op.kind));
    // An upload keeps the readiness probe: its transport does its own staging before any guest command,
    // so the execution's ownership check is not the very next thing to run.
    const row = await ready('project', id, input.accountUserId, UPLOAD_KINDS.includes(op.kind));
    assertGeneration(row, input.expectedGeneration);
    const perform = async () => {
      if (UPLOAD_KINDS.includes(op.kind)) return await transfers.perform({ row, accountUserId: input.accountUserId, operation: op });
      const result = await runGuest(row, input.accountUserId, ['/usr/bin/python3', '-c', FILE_HELPER], { input: JSON.stringify(op), timeoutMs: 120000 });
      if (result.truncated) throw error('output_limit', 'Guest file output exceeded its bound');
      let reply;
      try { reply = JSON.parse(result.stdout); } catch { throw error('guest_protocol', 'Invalid guest file response'); }
      if (!reply?.ok || result.code !== 0) throw error(reply?.error?.code ?? 'guest_file_error', reply?.error?.message ?? 'Guest file operation failed');
      if (reply.result?.kind !== op.kind) throw error('guest_protocol', 'Guest response kind differs from the requested operation');
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
    const spec = specFor(row.spec);
    const current = await runtimeFor(spec).inspect(spec);
    if (!current) return;
    if (current.state === 'paused') await runtimeFor(spec).unpause(spec);
    if (['running', 'paused', 'stopping'].includes(current.state)) {
      await cancelLeases(row);
      await runtimeFor(spec).stop(spec);
    }
    const stopped = await runtimeFor(spec).inspect(spec);
    if (stopped && !['created', 'configured', 'stopped', 'exited'].includes(stopped.state)) throw error('stop_unverified', 'Container stop could not be verified');
    if (row.kind === 'site') await sites.afterStop(row.resource_id);
  }
  /** End the pre-mount layout by removing the container that carries it. Such a container can be neither
   *  inspected, stopped nor removed the verified way — the specification that would prove ownership is
   *  the one that changed — so removing it by name is the only way out, and `recreate` and `delete` are
   *  the two explicit operations that exist to take it. The storage volumes are untouched. */
  async function removeLegacyContainer(row) {
    if (!row.spec.legacyWorkspaceLayout) return;
    const legacy = specFor(row.spec);
    await runtimeFor(legacy).removeByName(legacy);
    delete row.spec.legacyWorkspaceLayout;
    delete row.spec.containerId;
    store.save(row);
  }
  async function refreshSiteSourceBinding(row, userId) {
    if (row.kind !== 'site' || typeof row.spec.registration?.sourceRel !== 'string') return null;
    const previousSourcePath = row.spec.binding.sourcePath;
    const registration = await authorize('site', row.resource_id, userId, true);
    if (registration.sourceRel !== row.spec.registration.sourceRel) throw error('site_binding_changed', 'The trusted Site source reference changed', 409);
    row.spec.registration = registration;
    row.spec.binding.sourcePath = registration.sourcePath;
    return { previousSourcePath, sourcePath: registration.sourcePath };
  }
  async function rebuildMovedSiteContainer(row, op) {
    if (row.kind !== 'site' || !row.spec.containerId || typeof row.spec.registration?.sourceRel !== 'string') return;
    const previousRow = { ...row, spec: JSON.parse(JSON.stringify(row.spec)) };
    const moved = await refreshSiteSourceBinding(row, op.user_id);
    if (!moved || moved.previousSourcePath === moved.sourcePath) { store.save(row); return; }
    ctx.logger.info(`site ${row.resource_id}: source path moved from ${moved.previousSourcePath} to ${moved.sourcePath}, rebuilding container`);
    const previous = specFor(previousRow.spec);
    await cancelLeases(previousRow);
    const current = await runtimeFor(previous).inspect(previous);
    if (current) {
      if (current.state === 'paused') await runtimeFor(previous).unpause(previous);
      if (['running', 'paused', 'stopping'].includes(current.state)) {
        await runtimeFor(previous).stop(previous);
        const stopped = await runtimeFor(previous).inspect(previous);
        if (stopped && !['created', 'configured', 'stopped', 'exited'].includes(stopped.state)) throw error('stop_unverified', 'Container stop could not be verified');
        await sites.afterStop(row.resource_id);
      }
      await runtimeFor(previous).remove(previous);
    }
    delete row.spec.containerId;
    store.save(row);
  }
  async function ensureInitialContainer(row, op) {
    let spec = specFor(row.spec);
    // A container created before the project mount carried the project's name was built from a different
    // specification, so it fails ownership by construction and must never be adopted. Its storage volumes
    // are untouched and remount under the new name, so recreating it preserves the project's files — but
    // removing a container this runtime can no longer verify is an operator decision, not an automatic one.
    if (row.spec.legacyWorkspaceLayout) {
      if (await runtimeFor(spec).containerExists(spec)) {
        ctx.logger.warn(`project ${row.resource_id} still has the pre-mount container ${spec.name}; remove it to recreate the environment at ${rootOf(row)}`);
        throw error('legacy_workspace_layout', `This environment predates the named project mount. Recreate it to build a new container (${spec.name}); its files are kept in the storage volumes.`, 409);
      }
      delete row.spec.legacyWorkspaceLayout;
      delete row.spec.containerId;
      store.save(row);
      spec = specFor(row.spec);
    }
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
    if (!current && row.kind === 'site') {
      await refreshSiteSourceBinding(row, op.user_id);
      store.save(row);
      spec = specFor(row.spec);
      current = await runtimeFor(spec).inspect(spec);
    }
    if (current && !op.checkpoint.creating) throw error('container_unclaimed', 'A container exists without this creation checkpoint');
    if (!op.checkpoint.creating) checkpoint(op, { creating: true });
    if (!current) {
      if (row.kind === 'site') {
        await sites.beforeCreate?.(row.resource_id);
        if (!spec.disk || row.spec.diskSeeded !== true) {
          const seed = await sites.containerSeed?.(row.resource_id);
          if (seed) {
            if (seed.kind !== 'data') throw error('invalid_site_seed', 'Sites returned an invalid container seed');
            // Legacy rows seed every replacement rootfs. Persistent disks consume the bootstrap once and
            // retain the installed application and system configuration across envelope replacement.
            await runtimeFor(spec).siteDataArchive(spec, 'import', seed.archivePath);
          }
          if (spec.disk) { row.spec.diskSeeded = true; store.save(row); }
        }
      }
      current = await runtimeFor(spec).create(spec);
    }
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
    if (row.kind === 'project' && row.spec.input.image === PROJECT_BASE_IMAGE_TAG && !op.checkpoint.imageReady) {
      // A build is the one part of a start that can take minutes, so its output goes into the same ring
      // buffer the log view reads and its own step counter drives the bar. A line that carries no
      // fraction leaves the step indeterminate rather than freezing the bar at a stale figure.
      row.spec.input.image = await podman.ensureProjectImage(dataDir, (line) => {
        store.log(row.kind, row.resource_id, sanitize(line));
        step(op, 'image', buildFraction(line), true);
      });
      if (row.spec.input.disk?.sourceImage === PROJECT_BASE_IMAGE_TAG) {
        row.spec.input.disk = createEnvironmentDiskSpec({ resource: row.spec.input.resource, image: row.spec.input.image }, row.spec.paths, row.spec.input.disk.id);
      }
      store.save(row); checkpoint(op, { imageReady: true });
    }
    await rebuildMovedSiteContainer(row, op);
    step(op, 'storage');
    if (!row.spec.containerId) {
      await storage.prepare(specFor(row.spec));
      await adoptHostWorkspace(row);
    }
    step(op, 'container');
    const current = await ensureInitialContainer(row, op);
    const spec = specFor(row.spec);
    step(op, 'boot');
    if (row.kind === 'site') await sites.beforeStart(row.resource_id);
    if (current.state === 'paused') await runtimeFor(spec).unpause(spec);
    else if (current.state !== 'running') await runtimeFor(spec).start(spec);
    if ((await runtimeFor(spec).inspect(spec))?.state !== 'running') throw error('start_unverified', 'Container start could not be verified');
    const root = rootOf(row);
    // A running container is not yet a usable guest: initialization below, and every execution after it,
    // runs through `systemd-run` and therefore needs the guest system bus. Waiting for it here is its own
    // step because it is the part of a start that can take a while, and because a guest whose boot never
    // finishes is then reported as exactly that instead of a dbus error from the initialize command.
    if (row.kind === 'project') {
      step(op, 'ready', null);
      await runtimeFor(spec).waitForSystemBus(spec);
    }
    step(op, 'initialize');
    if (row.kind === 'project' && !op.checkpoint.initialized) {
      const result = await runtimeFor(spec).exec(spec, randomUUID().replaceAll('-', ''), ['/bin/bash', '-s'], { input: `set -eu\nif [ ! -e ${root}/.git ]; then\n git init -b main ${root}\n git -C ${root} -c user.name=Elowen -c user.email=environment@localhost -c core.hooksPath=/dev/null commit --allow-empty -m "Initialize managed project"\nfi\nmkdir -p /worktrees\n`, timeoutMs: 30000, persistent: true });
      if (result.code !== 0) throw error('initialization_failed', result.stderr || 'Project initialization failed');
      checkpoint(op, { initialized: true });
    }
    // The container is up and its system bus answers, so the forwarders it lost with the previous one
    // can be established again. The socket files outlive the container, hence `establishPublication`
    // removing them rather than trusting what is there.
    if (row.kind === 'project') await establishPublications(row);
    row.state = 'running'; row.error = null; store.save(row);
  }

  async function snapshot(row, op, snapshotId, note, includeData = true) {
    const spec = specFor(row.spec);
    const existing = store.snapshot(row.kind, row.resource_id, snapshotId);
    if (existing) return JSON.parse(existing.manifest_json);
    const capture = async () => {
      if (row.kind === 'project' && !op.checkpoint.worktrees) checkpoint(op, { worktrees: db.prepare('SELECT * FROM p_sandbox_managed_worktrees WHERE project_id=?').all(row.project_id) });
      let manifest;
      try { manifest = await storage.readSnapshot(spec, snapshotId); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      if (!manifest) manifest = await storage.snapshot(spec, snapshotId, { includeData });
      if (row.kind === 'project') manifest = { ...manifest, worktrees: op.checkpoint.worktrees };
      store.saveSnapshot(row, snapshotId, manifest, note);
      return manifest;
    };
    return row.kind === 'project' ? await withRepoLease(db, `managed-worktrees:${row.project_id}`, capture) : await capture();
  }

  async function pruneSiteSnapshots(row, op) {
    const registration = await authorize('site', row.resource_id, op.user_id, true, true);
    const keep = registration.snapshotRetention;
    if (keep === undefined) return;
    if (!Number.isSafeInteger(keep) || keep < 1 || keep > 1000) throw error('invalid_retention', 'Invalid Sites snapshot retention');
    const retained = store.snapshots('site', row.resource_id);
    for (const saved of retained.slice(keep)) {
      const manifest = JSON.parse(saved.manifest_json);
      if (saved.id === op.snapshot_id || manifest.image.reference === row.spec.input.image) continue;
      const spec = specFor(JSON.parse(saved.spec_json));
      if (manifest.retained) {
        const artifact = await sites.resolveArtifact?.({ siteId: row.resource_id, accountUserId: op.user_id, artifactId: manifest.artifactId, action: 'remove-artifact' });
        if (!artifact || artifact.kind !== 'snapshot' || artifact.snapshotId !== saved.id || artifact.imageReference !== manifest.image.reference || artifact.imageId.replace(/^sha256:/, '') !== manifest.image.id.replace(/^sha256:/, '')) throw error('retention_authority_missing', 'Sites must authorize retained release cleanup');
        await runtimeFor(spec).removeRetainedSiteImage(spec, artifact.imageReference, artifact.imageId);
        if (artifact.archivePath) removeOwnedArtifact(artifact.archivePath);
      } else await runtimeFor(spec).removeSnapshotImage(spec, manifest.snapshotId);
      await runtimeFor(spec).removeSnapshotStorage(spec, manifest.snapshotId);
      db.prepare('DELETE FROM p_sandbox_runtime_snapshots WHERE kind=? AND resource_id=? AND id=?').run('site', row.resource_id, saved.id);
    }
  }

  const siteImages = createSiteImageService({ podman, store, db, dataDir, account,
    recipe: (kind) => sites?.imageRecipe?.(kind),
    userExists: (id) => stores().usersRead.list().some((user) => user.id === id),
    isAdmin: (id) => stores().usersRead.isAdmin(id) && stores().usersRead.mayUsePlugin(id, 'sandbox'),
    authorizeSite: (id, userId) => authorize('site', id, userId, true),
    siteSpec: (registration) => specFor(siteRecord(registration, 1)),
    resolveSnapshotImage: (input) => sites?.resolveSnapshotImage?.(input),
  });
  const siteCleanup = createSiteCleanupService({ store, siteRecord, normalizeLimits: limits,
    userExists: (id) => stores().usersRead.list().some((user) => user.id === id),
    resolveCleanup: (input) => sites?.resolveCleanup?.(input),
  });

  async function performSiteAction(row, op) {
    const registration = await authorize('site', row.resource_id, op.user_id, true, true);
    const spec = specFor(row.spec);
    const kind = op.action.kind;
    if (kind === 'provision-image') {
      if (spec.disk) throw error('legacy_only', 'Persistent rootfs Sites materialize directly from their registered image');
      const image = await siteImages.provision(op.action.imageKind);
      if (image !== row.spec.input.image) throw error('site_image_mismatch', 'The fixed recipe does not match the registered Site image');
      return;
    }
    if (kind === 'prepare') {
      if (!row.spec.containerId) await storage.prepare(spec);
      const current = await ensureInitialContainer(row, op);
      row.state = current?.state === 'running' ? 'running' : 'stopped';
      row.desired_state = row.state; store.save(row); return;
    }
    if (kind === 'cleanup-stage') {
      if (!registration.staging) throw error('site_not_staging', 'Only an unpublished conversion binding may be cleaned up as staging');
      await stopRow(row);
      if (await runtimeFor(spec).inspect(spec)) await runtimeFor(spec).remove(spec);
      for (const volume of spec.volumes) await runtimeFor(spec).removeVolume(spec, volume.component);
      await runtimeFor(spec).removeGenerationStorage(spec);
      row.state = 'deleted'; row.desired_state = 'deleted'; store.save(row); return;
    }
    if (!sites.resolveArtifact) throw error('site_artifact_missing', 'Sites did not provide retained artifact resolution');
    const artifact = await sites.resolveArtifact({ siteId: row.resource_id, accountUserId: op.user_id, artifactId: op.action.artifactId, action: kind });
    if (!artifact) throw error('site_artifact_forbidden', 'The retained Sites artifact is unavailable', 403);
    if (op.checkpoint.artifact && !same(op.checkpoint.artifact, artifact)) throw error('site_artifact_changed', 'The retained artifact binding changed');
    if (!op.checkpoint.artifact) checkpoint(op, { artifact });
    if (kind === 'import-snapshot') {
      if (artifact.kind !== 'snapshot' || typeof artifact.snapshotId !== 'string' || !artifact.snapshotId || artifact.snapshotId.length > 160 || !Number.isFinite(Date.parse(artifact.createdAt))) throw error('invalid_site_snapshot', 'Invalid retained Sites snapshot');
      const internalId = `retained-${createHash('sha256').update(artifact.snapshotId).digest('hex').slice(0, 40)}`;
      const manifest = await storage.importRetainedSiteSnapshot(spec, internalId, artifact);
      store.saveSnapshot(row, artifact.snapshotId, { ...manifest, artifactId: op.action.artifactId }, artifact.note);
      db.prepare('UPDATE p_sandbox_runtime_snapshots SET created_at=? WHERE kind=? AND resource_id=? AND id=?').run(artifact.createdAt, row.kind, row.resource_id, artifact.snapshotId);
      op.snapshot_id = artifact.snapshotId; store.saveOperation(op); return;
    }
    if (kind === 'import-data' || kind === 'export-data') {
      if (artifact.kind !== 'data') throw error('invalid_site_artifact', 'A retained data archive is required');
      if (kind === 'import-data' && !registration.staging) throw error('site_not_staging', 'Data import requires an unpublished conversion binding');
      if (op.checkpoint.archiveCompleted) return;
      await cancelLeases(row);
      const current = await runtimeFor(spec).inspect(spec);
      if (kind === 'import-data' && current?.state === 'running') throw error('site_running', 'Stop the conversion target before seeding its data');
      let paused = false;
      try {
        if (kind === 'export-data' && current?.state === 'running') { await runtimeFor(spec).pause(spec); paused = true; }
        await runtimeFor(spec).siteDataArchive(spec, kind === 'import-data' ? 'import' : 'export', artifact.archivePath);
        checkpoint(op, { archiveCompleted: true });
      } finally { if (paused || (current?.state === 'running' && (await runtimeFor(spec).inspect(spec))?.state === 'paused')) await runtimeFor(spec).unpause(spec); }
      return;
    }
    if (kind === 'remove-artifact') {
      if (artifact.kind === 'snapshot') {
        await runtimeFor(spec).removeRetainedSiteImage(spec, artifact.imageReference, artifact.imageId);
        if (artifact.archivePath && !op.checkpoint.archiveRemoved) { removeOwnedArtifact(artifact.archivePath); checkpoint(op, { archiveRemoved: true }); }
        db.prepare('DELETE FROM p_sandbox_runtime_snapshots WHERE kind=? AND resource_id=? AND id=?').run('site', row.resource_id, artifact.snapshotId);
      } else if (artifact.kind === 'data') {
        if (!op.checkpoint.archiveRemoved) { removeOwnedArtifact(artifact.archivePath); checkpoint(op, { archiveRemoved: true }); }
      } else throw error('invalid_site_artifact', 'Source publication is not an artifact deletion capability');
      return;
    }
    if (kind === 'export-project') {
      if (artifact.kind !== 'project-source' || artifact.destinationPath !== registration.sourcePath) throw error('invalid_site_source', 'Publication destination must match the trusted Sites source binding');
      if (op.checkpoint.sourceExported) return;
      const source = await ready('project', projectId(artifact.project), op.user_id);
      const invoke = async (operation) => {
        const result = await runGuest(source, op.user_id, ['/usr/bin/python3', '-c', FILE_HELPER], { input: JSON.stringify(operation), timeoutMs: 120000 });
        if (result.truncated) throw error('export_limit', 'Guest publication output exceeded its bound');
        const reply = JSON.parse(result.stdout);
        if (result.code !== 0 || !reply.ok) throw error(reply.error?.code ?? 'guest_export_error', reply.error?.message ?? 'Guest publication failed');
        return reply.result;
      };
      const manifest = await invoke({ kind: 'export-manifest', path: guestPath(artifact.guestPath) });
      await exportProjectTree({ destination: artifact.destinationPath, operationId: op.id, manifest,
        readChunk: (path, offset, length) => invoke({ kind: 'read', path: posix.join(manifest.root, path), maxBytes: 262144, offset, length }),
        verify: async () => { if (!same(manifest, await invoke({ kind: 'export-manifest', path: artifact.guestPath }))) throw error('source_changed', 'Publication source changed during export'); },
      });
      checkpoint(op, { sourceExported: true }); return;
    }
    throw error('invalid_site_action', 'Unknown Sites lifecycle action');
  }

  /** Where a specification RECORD's disk directories are derived from. A Site's roots come from its
   *  trusted binding and a project's from its stored paths; both are host-derived, never carried in the
   *  record's disk field, which is why the disk spec is rebuilt from them rather than copied. */
  const diskPathsFor = (record) => record.input.resource.kind === 'site'
    ? { sitesDataDir: record.binding.sitesDataDir, namespace: record.binding.namespace }
    : record.paths;

  /** A migrated Site is not proven by a running container. Its ingress socket has to be back on the host
   *  side of the broker mount, which is the path a visitor's request actually travels, and Sites itself
   *  has to agree the application answers through it. */
  async function verifySiteReadiness(row, spec) {
    await runtimeFor(spec).systemRunning(spec);
    const socket = join(row.spec.binding.brokerDir, 'app.sock');
    const deadline = Date.now() + 120_000;
    while (!forwarderSocketPresent(socket)) {
      if (Date.now() >= deadline) throw error('site_ingress_missing', 'The migrated Site did not re-establish its ingress socket');
      await wait(250);
    }
    if (sites.verifyReady) await sites.verifyReady(row.resource_id);
  }

  /** Turn a legacy image-backed environment into a rootfs-backed persistent disk without ever leaving
   *  the only copy of it at risk.
   *
   *  Each name below is a durable receipt on the operation row, in this order:
   *
   *    claimed → quiesced → exported → materialized → candidate-created → candidate-booted → switched
   *      → legacy-removed → complete
   *
   *  A retry resumes at the first one that is missing and repeats nothing that already has a receipt.
   *  Only two steps here are destructive, and both come last: the runtime row is switched only after the
   *  candidate has booted and answered, and the legacy envelope is removed only after that switch is
   *  durable. Until then the environment is still the old container's, so a candidate that will not boot
   *  is removed on its own — the materialized disk and the export archive stay for diagnosis and the old
   *  container comes back up. */
  async function migrateDisk(row, op) {
    if (!stores().usersRead.isAdmin(op.user_id)) throw error('admin_required', 'Disk migration authority was revoked', 403);
    const state = op.checkpoint.migration ?? {};
    // Read the row's driver only for a migration that has not claimed it yet. Past the switch the row IS
    // rootfs-backed, and this operation is the reason: refusing it there would strand the legacy envelope
    // it still has to remove.
    if (!state.done?.length) {
      if (row.spec.input.disk) throw error('already_rootfs_backed', 'This environment already runs on a persistent disk');
      if (row.spec.legacyWorkspaceLayout) throw error('legacy_workspace_layout', 'Recreate this environment at its named project mount before migrating its disk');
    }
    const done = new Set(state.done ?? []);
    const reached = (name) => done.has(name);
    const mark = (name, values = {}) => {
      done.add(name);
      Object.assign(state, values, { done: [...done] });
      checkpoint(op, { migration: state });
      store.log(row.kind, row.resource_id, `migrate-disk reached ${name}`);
    };
    if (!reached('claimed')) {
      if (!row.spec.containerId) throw error('migration_source_missing', 'Start this environment once before migrating its root filesystem');
      const source = specFor(row.spec);
      const observed = await runtimeFor(source).inspect(source);
      if (!observed) throw error('migration_source_missing', 'The legacy container is missing; its root filesystem cannot be exported');
      // A candidate needs a name of its own, and the name carries the generation — so the migration
      // reserves the next one the same way a restore does, and the old envelope keeps its own.
      const reserved = db.prepare("SELECT MAX(json_extract(checkpoint_json,'$.newSpec.input.generation')) AS generation FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=?").get(row.kind, row.resource_id);
      const candidateGeneration = Math.max(row.generation, Number(reserved?.generation ?? 0)) + 1;
      const candidate = JSON.parse(JSON.stringify(row.spec));
      candidate.input.generation = candidateGeneration;
      candidate.input.disk = createEnvironmentDiskSpec({ resource: candidate.input.resource, image: candidate.input.image },
        diskPathsFor(candidate), randomUUID().replaceAll('-', ''), row.generation);
      candidate.creationLimits = candidate.input.limits;
      // The exported root filesystem and the existing data directory already carry the Site bootstrap.
      // Replaying the seed over them would overwrite the data this migration exists to preserve.
      if (row.kind === 'site') candidate.diskSeeded = true;
      delete candidate.containerId;
      checkpoint(op, { oldSpec: JSON.parse(JSON.stringify(row.spec)), oldGeneration: row.generation });
      mark('claimed', { migrationId: `migration-${op.id.slice(4)}`, oldContainerId: observed.id, oldContainerName: specFor(row.spec).name,
        sourceImage: row.spec.input.image, diskId: candidate.input.disk.id, candidateGeneration,
        wasRunning: row.desired_state === 'running', candidateSpec: candidate });
    }
    const old = { ...row, spec: op.checkpoint.oldSpec, generation: op.checkpoint.oldGeneration };
    const oldSpec = specFor(old.spec);
    const candidate = () => specFor(state.candidateSpec);
    if (!reached('quiesced')) {
      // Before anything stops: a host that cannot hold the archive and the extracted tree must refuse
      // the migration while the environment is still running rather than halfway through it.
      await runtimeFor(oldSpec).preflightRootfsMigration(oldSpec, join(oldSpec.storageRoot, 'disks'));
      step(op, 'stop');
      await stopRow(old);
      mark('quiesced');
    }
    if (!reached('exported')) {
      step(op, 'export', null);
      const stopped = await runtimeFor(oldSpec).inspect(oldSpec);
      if (!stopped || stopped.id !== state.oldContainerId) throw error('migration_source_changed', 'The legacy container identity changed before its root filesystem was exported');
      if (!['created', 'configured', 'stopped', 'exited'].includes(stopped.state)) throw error('migration_source_running', 'The legacy container is not stopped');
      const capture = await storage.captureRootfsExport(oldSpec, state.migrationId);
      if (capture.containerId !== state.oldContainerId) throw error('migration_source_changed', 'The export archive belongs to another container');
      mark('exported', { export: capture });
    }
    if (!reached('materialized')) {
      step(op, 'materialize', null);
      await storage.materializeMigratedDisk(candidate(), state.export);
      mark('materialized');
    }
    /** The candidate is the ONLY thing this undoes. The disk and the archive are kept for diagnosis, the
     *  runtime row is still bound to the old container, and an environment that was running goes back up
     *  on it. Dropping the candidate receipts is what lets a later retry build a fresh envelope over the
     *  disk that is already materialized. */
    const rollback = async (cause) => {
      try {
        if (await runtimeFor(candidate()).containerExists(candidate())) {
          const observed = await runtimeFor(candidate()).inspect(candidate());
          if (observed?.state === 'paused') await runtimeFor(candidate()).unpause(candidate());
          if (observed && ['running', 'paused', 'stopping'].includes(observed.state)) await runtimeFor(candidate()).stop(candidate());
          await runtimeFor(candidate()).remove(candidate());
        }
        for (const name of ['candidate-created', 'candidate-booted']) done.delete(name);
        delete state.candidateSpec.containerId;
        delete state.candidateClaimed;
        delete state.candidateContainerId;
        state.done = [...done];
        checkpoint(op, { migration: state });
        store.log(row.kind, row.resource_id, `migrate-disk candidate removed and rolled back: ${cause.message}`);
        if (state.wasRunning) {
          if (row.kind === 'site') await sites.beforeStart(row.resource_id);
          if ((await runtimeFor(oldSpec).inspect(oldSpec))?.state !== 'running') await runtimeFor(oldSpec).start(oldSpec);
          if ((await runtimeFor(oldSpec).inspect(oldSpec))?.state !== 'running') throw new Error('the legacy container did not restart');
          if (row.kind === 'project') {
            await runtimeFor(oldSpec).waitForSystemBus(oldSpec);
            await establishPublications(old);
          }
        }
      } catch (failure) { throw new AggregateError([cause, failure], `${cause.message}; rollback to the legacy container failed: ${failure.message}`); }
      throw cause;
    };
    if (!reached('candidate-created')) {
      try {
        step(op, 'storage');
        await storage.prepare(candidate());
        step(op, 'container');
        const existing = await runtimeFor(candidate()).containerExists(candidate()) ? await runtimeFor(candidate()).inspect(candidate()) : null;
        if (existing && !state.candidateClaimed) throw error('migration_candidate_unclaimed', 'A candidate container exists without this migration checkpoint');
        if (!state.candidateClaimed) { state.candidateClaimed = true; checkpoint(op, { migration: state }); }
        if (row.kind === 'site' && !existing) await sites.beforeCreate?.(row.resource_id);
        const created = existing ?? await runtimeFor(candidate()).create(candidate());
        state.candidateSpec.containerId = created.id;
        mark('candidate-created', { candidateContainerId: created.id });
      } catch (cause) { await rollback(cause); }
    }
    if (!reached('candidate-booted')) {
      try {
        step(op, 'boot');
        if (state.wasRunning) {
          if (row.kind === 'site') await sites.beforeStart(row.resource_id);
          if ((await runtimeFor(candidate()).inspect(candidate()))?.state !== 'running') await runtimeFor(candidate()).start(candidate());
          if ((await runtimeFor(candidate()).inspect(candidate()))?.state !== 'running') throw error('migration_start_failed', 'The migrated candidate container did not start');
          step(op, 'verify', null);
          if (row.kind === 'project') {
            await runtimeFor(candidate()).waitForSystemBus(candidate());
            await runtimeFor(candidate()).systemRunning(candidate());
          } else await verifySiteReadiness(row, candidate());
        }
        mark('candidate-booted');
      } catch (cause) { await rollback(cause); }
    }
    if (!reached('switched')) {
      step(op, 'switch');
      store.transaction(() => {
        row.spec = state.candidateSpec;
        row.generation = row.spec.input.generation;
        row.state = state.wasRunning ? 'running' : 'stopped';
        row.error = null;
        store.save(row);
        // `switched` is also what recovery reads to know which generation a resumed operation belongs to.
        checkpoint(op, { switched: true, newSpec: state.candidateSpec });
        mark('switched');
      });
      if (row.kind === 'project' && state.wasRunning) await establishPublications(row);
    }
    if (!reached('legacy-removed')) {
      step(op, 'cleanup');
      const observed = await runtimeFor(oldSpec).containerExists(oldSpec) ? await runtimeFor(oldSpec).inspect(oldSpec) : null;
      if (observed) {
        if (observed.state === 'paused') await runtimeFor(oldSpec).unpause(oldSpec);
        if (['running', 'paused', 'stopping'].includes(observed.state)) await runtimeFor(oldSpec).stop(oldSpec);
        await runtimeFor(oldSpec).remove(oldSpec);
      }
      mark('legacy-removed');
    }
    if (!reached('complete')) {
      // Nothing can read the archive any more: the disk is active, the candidate answered and the legacy
      // envelope is gone. A failed migration never reaches here and keeps its archive.
      await storage.discardRootfsExport(oldSpec, state.migrationId);
      mark('complete');
    }
  }

  /** Move an environment that is ALREADY on a persistent disk from Podman to systemd-nspawn, without
   *  copying its root filesystem.
   *
   *  The disk does not move and is not duplicated: the same tree keeps its place, its identity and its
   *  workspace, HOME and data directories. What changes is who boots it. Each name below is a durable
   *  receipt on the operation row, in this order:
   *
   *    claimed → quiesced → shifted → envelope-written → candidate-booted → switched → legacy-removed
   *      → complete
   *
   *  Only `shifted` touches the disk, and it is the one step that has to be UNDONE rather than merely
   *  dropped: a tree owned by the machine's range is a tree the Podman envelope can no longer read. The
   *  range it replaced comes back on the shift receipt, so a rollback reverses it exactly and the
   *  environment goes back up on Podman. An interrupted shift is resumed, not reversed — it holds no
   *  receipt, so the retry simply runs it again over a tree whose range is already recorded. */
  async function migrateRuntime(row, op) {
    if (!stores().usersRead.isAdmin(op.user_id)) throw error('admin_required', 'Runtime migration authority was revoked', 403);
    const state = op.checkpoint.migration ?? {};
    // Read the row's driver only for a migration that has not claimed it yet. Past the switch the row IS
    // the nspawn one, and this operation is the reason: refusing it there would strand the Podman
    // envelope it still has to remove.
    if (!state.done?.length) {
      if (!row.spec.input.disk) throw error('not_rootfs_backed', 'Migrate this environment to a persistent disk before changing its runtime');
      if (row.spec.input.disk.runtime === 'nspawn') throw error('already_nspawn', 'This environment already runs on systemd-nspawn');
      if (row.spec.legacyWorkspaceLayout) throw error('legacy_workspace_layout', 'Recreate this environment at its named project mount before changing its runtime');
    }
    const done = new Set(state.done ?? []);
    const reached = (name) => done.has(name);
    const mark = (name, values = {}) => {
      done.add(name);
      Object.assign(state, values, { done: [...done] });
      checkpoint(op, { migration: state });
      store.log(row.kind, row.resource_id, `migrate-runtime reached ${name}`);
    };
    if (!reached('claimed')) {
      if (!row.spec.containerId) throw error('migration_source_missing', 'Start this environment once before changing its runtime');
      const source = specFor(row.spec);
      const observed = await runtimeFor(source).inspect(source);
      if (!observed) throw error('migration_source_missing', 'The Podman envelope is missing; recreate the environment before changing its runtime');
      // The candidate envelope needs a name of its own, and the name carries the generation, so the
      // migration reserves the next one exactly as a restore and a disk migration do.
      const reserved = db.prepare("SELECT MAX(json_extract(checkpoint_json,'$.newSpec.input.generation')) AS generation FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=?").get(row.kind, row.resource_id);
      const candidateGeneration = Math.max(row.generation, Number(reserved?.generation ?? 0)) + 1;
      const candidate = JSON.parse(JSON.stringify(row.spec));
      candidate.input.generation = candidateGeneration;
      // The SAME disk id, the same rootfs path and the same component paths: this rebuild only adds the
      // runtime discriminator, which is what makes the change an envelope change and not a data move.
      candidate.input.disk = createEnvironmentDiskSpec({ resource: candidate.input.resource, image: row.spec.input.disk.sourceImage, runtime: 'nspawn' },
        diskPathsFor(candidate), row.spec.input.disk.id, row.spec.input.disk.componentGeneration);
      candidate.creationLimits = candidate.input.limits;
      delete candidate.containerId;
      checkpoint(op, { oldSpec: JSON.parse(JSON.stringify(row.spec)), oldGeneration: row.generation });
      mark('claimed', { oldContainerId: observed.id, oldContainerName: source.name, diskId: row.spec.input.disk.id,
        candidateGeneration, wasRunning: row.desired_state === 'running', candidateSpec: candidate });
    }
    const old = { ...row, spec: op.checkpoint.oldSpec, generation: op.checkpoint.oldGeneration };
    const oldSpec = specFor(old.spec);
    const candidate = () => specFor(state.candidateSpec);
    const target = () => runtimeFor(candidate());
    if (!reached('quiesced')) {
      step(op, 'stop');
      await stopRow(old);
      mark('quiesced');
    }
    if (!reached('shifted')) {
      step(op, 'shift', null);
      const stopped = await runtimeFor(oldSpec).inspect(oldSpec);
      if (!stopped || stopped.id !== state.oldContainerId) throw error('migration_source_changed', 'The Podman envelope identity changed before the disk was handed over');
      if (!['created', 'configured', 'stopped', 'exited'].includes(stopped.state)) throw error('migration_source_running', 'The Podman envelope is not stopped');
      const receipt = await target().shiftOwnership(candidate(), { target: 'nspawn' });
      mark('shifted', { uidBase: receipt.uidBase, previousUidBase: receipt.previousUidBase });
    }
    /** The candidate envelope is what this undoes, and the ownership pass with it. The disk keeps every
     *  byte it had, the runtime row is still the Podman envelope's, and an environment that was running
     *  goes back up on it. Dropping the candidate receipts is what lets a later retry try again. */
    const rollback = async (cause) => {
      try {
        if (await target().containerExists(candidate())) {
          const observed = await target().inspect(candidate());
          if (observed?.state === 'paused') await target().unpause(candidate());
          if (observed && ['running', 'paused', 'stopping'].includes(observed.state)) await target().stop(candidate());
          await target().remove(candidate());
        }
        // The receipts go BEFORE the ownership pass they describe, and this order is the whole safety of
        // the rollback. A reverse pass that dies part way leaves a tree split between the two schemes,
        // which neither rootless Podman nor the machine can read; a `shifted` receipt that survived that
        // failure would make the retry skip the forward pass at the step above and boot against it. The
        // forward pass is idempotent, so dropping the receipt early can only cost a redundant pass over
        // ids that already carry the destination scheme, where keeping it costs the disk.
        // `quiesced` goes with them: the environment is about to be running again on Podman, so the
        // retry has to stop it before it may touch the disk's ownership a second time.
        const reversing = reached('shifted');
        for (const name of ['quiesced', 'shifted', 'envelope-written', 'candidate-booted']) done.delete(name);
        delete state.candidateSpec.containerId;
        delete state.candidateClaimed;
        delete state.candidateEnvelopeId;
        state.done = [...done];
        checkpoint(op, { migration: state });
        if (reversing) await target().shiftOwnership(candidate(), { target: 'podman', uidBase: state.previousUidBase });
        store.log(row.kind, row.resource_id, `migrate-runtime candidate removed and rolled back: ${cause.message}`);
        if (state.wasRunning) {
          if (row.kind === 'site') await sites.beforeStart(row.resource_id);
          if ((await runtimeFor(oldSpec).inspect(oldSpec))?.state !== 'running') await runtimeFor(oldSpec).start(oldSpec);
          if ((await runtimeFor(oldSpec).inspect(oldSpec))?.state !== 'running') throw new Error('the Podman envelope did not restart');
          if (row.kind === 'project') {
            await runtimeFor(oldSpec).waitForSystemBus(oldSpec);
            await establishPublications(old);
          }
        }
      } catch (failure) { throw new AggregateError([cause, failure], `${cause.message}; rollback to the Podman envelope failed: ${failure.message}`); }
      throw cause;
    };
    if (!reached('envelope-written')) {
      try {
        step(op, 'container');
        const existing = await target().containerExists(candidate()) ? await target().inspect(candidate()) : null;
        if (existing && !state.candidateClaimed) throw error('migration_candidate_unclaimed', 'A candidate envelope exists without this migration checkpoint');
        if (!state.candidateClaimed) { state.candidateClaimed = true; checkpoint(op, { migration: state }); }
        const created = existing ?? await target().create(candidate());
        state.candidateSpec.containerId = created.id;
        mark('envelope-written', { candidateEnvelopeId: created.id });
      } catch (cause) { await rollback(cause); }
    }
    if (!reached('candidate-booted')) {
      try {
        step(op, 'boot');
        if (state.wasRunning) {
          if (row.kind === 'site') await sites.beforeStart(row.resource_id);
          if ((await target().inspect(candidate()))?.state !== 'running') await target().start(candidate());
          if ((await target().inspect(candidate()))?.state !== 'running') throw error('migration_start_failed', 'The migrated candidate machine did not start');
          step(op, 'verify', null);
          if (row.kind === 'project') {
            await target().waitForSystemBus(candidate());
            await target().systemRunning(candidate());
          } else await verifySiteReadiness(row, candidate());
        }
        mark('candidate-booted');
      } catch (cause) { await rollback(cause); }
    }
    if (!reached('switched')) {
      step(op, 'switch');
      store.transaction(() => {
        row.spec = state.candidateSpec;
        row.generation = row.spec.input.generation;
        row.state = state.wasRunning ? 'running' : 'stopped';
        row.error = null;
        store.save(row);
        checkpoint(op, { switched: true, newSpec: state.candidateSpec });
        mark('switched');
      });
      if (row.kind === 'project' && state.wasRunning) await establishPublications(row);
    }
    if (!reached('legacy-removed')) {
      step(op, 'cleanup');
      const observed = await runtimeFor(oldSpec).containerExists(oldSpec) ? await runtimeFor(oldSpec).inspect(oldSpec) : null;
      if (observed) {
        if (observed.state === 'paused') await runtimeFor(oldSpec).unpause(oldSpec);
        if (['running', 'paused', 'stopping'].includes(observed.state)) await runtimeFor(oldSpec).stop(oldSpec);
        await runtimeFor(oldSpec).remove(oldSpec);
      }
      mark('legacy-removed');
    }
    if (!reached('complete')) {
      // A runtime change leaves no archive to release, so the last receipt is the proof itself: the
      // Podman envelope is gone and the machine the row now names still proves its own ownership.
      if (await runtimeFor(oldSpec).containerExists(oldSpec)) throw error('migration_cleanup_incomplete', 'The Podman envelope is still present after the switch');
      if (!await target().inspect(candidate())) throw error('migration_target_missing', 'The migrated machine envelope is missing after the switch');
      mark('complete');
    }
  }

  async function perform(row, op) {
    const kind = op.action.kind;
    if (row.kind === 'project' && ['stop', 'restart', 'snapshot', 'restore', 'migrate-disk', 'migrate-runtime'].includes(kind)) {
      step(op, 'quiesce');
      await cancelLeases(row);
      await transfers.quiesce({ row });
    }
    if (row.kind === 'site' && ['prepare', 'cleanup-stage', 'provision-image', 'import-data', 'export-data', 'import-snapshot', 'remove-artifact', 'export-project'].includes(kind)) return await performSiteAction(row, op);
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
        // The pre-mount container goes first, before anything inspects it: every verified path below
        // would refuse it, which is what left this repair unable to perform the repair.
        await removeLegacyContainer(row);
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
      await snapshot(row, op, op.snapshot_id, op.action.note, op.action.includeData !== false);
      step(op, 'record');
      if (row.kind === 'site') await pruneSiteSnapshots(row, op);
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
          next.input.image = manifest.sourceImage.reference;
          next.input.disk = createEnvironmentDiskSpec({ resource: next.input.resource, image: next.input.image }, diskPathsFor(next), randomUUID().replaceAll('-', ''));
        } else {
          if (old.spec.input.disk) throw error('snapshot_driver_mismatch', 'A legacy snapshot requires a legacy environment');
          next.input.image = manifest.image.reference;
        }
        next.creationLimits = next.input.limits;
        delete next.containerId;
        checkpoint(op, { newSpec: next });
      }
      if (row.kind === 'site' && typeof op.checkpoint.newSpec.registration?.sourceRel === 'string') {
        const targetRow = { ...row, spec: op.checkpoint.newSpec };
        await refreshSiteSourceBinding(targetRow, op.user_id);
        op.checkpoint.newSpec = targetRow.spec;
        checkpoint(op, { newSpec: op.checkpoint.newSpec });
      }
      let target = specFor(op.checkpoint.newSpec);
      step(op, 'import');
      if (!op.checkpoint.imported) {
        if (row.kind === 'site' && op.action.restoreData === false && !target.disk) {
          const backupId = `preserve-${op.id.slice(4)}`;
          await snapshot(old, op, backupId, 'Restore data checkpoint');
          await storage.readSnapshot(specFor(old.spec), backupId);
          const preserved = specFor(old.spec);
          await runtimeFor(preserved).importSnapshotVolume(preserved, backupId, target, 'data', { resume: true });
        } else await storage.restoreVolumes(specFor(source), storageId, target);
        checkpoint(op, { imported: true });
      }
      step(op, 'container');
      let restored = await runtimeFor(target).inspect(target);
      if (op.checkpoint.newSpec.containerId && !restored) throw error('restore_target_missing', 'The bound restore target is missing; start a new restore intent');
      if (restored && !op.checkpoint.newSpec.containerId && !op.checkpoint.targetCreating) throw error('restore_target_unclaimed', 'The restore target has no creation checkpoint');
      if (!restored) {
        checkpoint(op, { targetCreating: true });
        if (row.kind === 'site') await sites.beforeCreate?.(row.resource_id);
        restored = await runtimeFor(target).create(target);
      }
      if (!op.checkpoint.newSpec.containerId) {
        op.checkpoint.newSpec.containerId = restored.id;
        checkpoint(op, { newSpec: op.checkpoint.newSpec });
        target = specFor(op.checkpoint.newSpec);
      }
      step(op, 'boot');
      if (op.checkpoint.wasRunning) {
        if (row.kind === 'site') await sites.beforeStart(row.resource_id);
        if ((await runtimeFor(target).inspect(target))?.state !== 'running') await runtimeFor(target).start(target);
        if ((await runtimeFor(target).inspect(target))?.state !== 'running') throw error('restore_start_failed', 'Restored container did not start');
      }
      step(op, 'switch');
      if (!op.checkpoint.switched) store.transaction(() => {
        if (row.kind === 'project') {
          const worktrees = JSON.parse(saved.manifest_json).worktrees ?? [];
          db.prepare('DELETE FROM p_sandbox_managed_worktrees WHERE project_id=?').run(row.project_id);
          for (const item of worktrees) db.prepare('INSERT INTO p_sandbox_managed_worktrees(id,project_id,created_by,label,path,branch,base_ref,base_commit,state) VALUES(?,?,?,?,?,?,?,?,?)')
            .run(item.id, row.project_id, item.created_by, item.label, item.path, item.branch, item.base_ref, item.base_commit, item.state);
        }
        row.spec = op.checkpoint.newSpec; row.generation = row.spec.input.generation;
        row.state = op.checkpoint.wasRunning ? 'running' : 'stopped'; row.error = null; store.save(row);
        checkpoint(op, { switched: true });
      });
      step(op, 'cleanup');
      const previousSpec = specFor(old.spec);
      if (await runtimeFor(previousSpec).inspect(previousSpec)) await runtimeFor(previousSpec).remove(previousSpec);
      // Old volumes are retained until explicit Project deletion, providing a non-destructive rollback checkpoint.
    } else if (kind === 'migrate-disk') {
      await migrateDisk(row, op);
    } else if (kind === 'migrate-runtime') {
      await migrateRuntime(row, op);
    } else if (kind === 'limits') {
      step(op, 'apply');
      if (!stores().usersRead.isAdmin(op.user_id)) throw error('admin_required', 'Resource-limit authority was revoked', 403);
      const prior = specFor(row.spec);
      await runtimeFor(prior).update(prior, op.action.limits);
      row.spec.creationLimits ??= row.spec.input.limits;
      row.spec.input.limits = { cpus: op.action.limits.cpus, memoryMb: op.action.limits.memoryMb, pidsLimit: op.action.limits.pidsLimit };
      row.limits = op.action.limits; store.save(row);
    } else if (kind === 'delete') {
      if (row.kind === 'project') await assertNoPublishedSites(row.resource_id);
      step(op, 'stop');
      await removeLegacyContainer(row);
      await stopRow(row);
      const spec = specFor(row.spec);
      const snapshots = store.snapshots(row.kind, row.resource_id);
      const recipes = new Map([[spec.name, row.spec]]);
      for (const saved of snapshots) { const recipe = JSON.parse(saved.spec_json); recipes.set(specFor(recipe, true).name, recipe); }
      for (const entry of db.prepare('SELECT checkpoint_json FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=?').all(row.kind, row.resource_id)) {
        const previous = JSON.parse(entry.checkpoint_json);
        for (const key of ['oldSpec', 'newSpec']) if (previous[key]) recipes.set(specFor(previous[key], true).name, previous[key]);
      }
      recipes.set(spec.name, row.spec);
      step(op, 'containers');
      for (const recipe of recipes.values()) {
        const owned = specFor(recipe, true);
        if (await runtimeFor(owned).inspect(owned)) {
          await stopRow({ ...row, spec: recipe, generation: recipe.input.generation });
          await runtimeFor(owned).remove(owned);
        }
      }
      checkpoint(op, { containerRemoved: true });
      step(op, 'images');
      for (const saved of snapshots) {
        const owned = specFor(JSON.parse(saved.spec_json), true);
        const manifest = JSON.parse(saved.manifest_json);
        if (manifest.retained) await runtimeFor(owned).removeRetainedSiteImage(owned, manifest.image.reference, manifest.image.id);
        else if (manifest.version !== 2) await runtimeFor(owned).removeSnapshotImage(owned, manifest.snapshotId);
      }
      step(op, 'volumes');
      for (const recipe of recipes.values()) {
        const owned = specFor(recipe, true);
        for (const volume of owned.volumes) await runtimeFor(owned).removeVolume(owned, volume.component);
      }
      step(op, 'storage');
      for (const saved of snapshots) {
        const owned = specFor(JSON.parse(saved.spec_json), true);
        await runtimeFor(owned).removeSnapshotStorage(owned, JSON.parse(saved.manifest_json).snapshotId);
      }
      const ownedSpecs = [...recipes.values()].map((recipe) => specFor(recipe, true));
      const disks = new Map(ownedSpecs.filter((owned) => owned.disk).map((owned) => [owned.disk.id, owned]));
      for (const disk of disks.values()) await storage.removeDisk(disk, ownedSpecs);
      await runtimeFor(spec).removeStorage(spec);
      checkpoint(op, { storageRemoved: true });
      step(op, 'records');
      store.transaction(() => {
        // The deletion itself stays: the surface that asked for it still reads its outcome. Everything
        // that happened to an environment that no longer exists goes with it.
        db.prepare('DELETE FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=? AND id<>?').run(row.kind, row.resource_id, op.id);
        db.prepare('DELETE FROM p_sandbox_runtime_snapshots WHERE kind=? AND resource_id=?').run(row.kind, row.resource_id);
        db.prepare('DELETE FROM p_sandbox_execution_leases WHERE resource_kind=? AND resource_id=?').run(row.kind, row.resource_id);
        db.prepare('DELETE FROM p_sandbox_file_uploads WHERE resource_kind=? AND resource_id=?').run(row.kind, row.resource_id);
        if (row.kind === 'project') db.prepare('DELETE FROM p_sandbox_managed_worktrees WHERE project_id=?').run(row.project_id);
        if (row.kind === 'project' && !stores().projects.finishDeletion(Number(row.resource_id))) throw error('project_finalize_failed', 'Core Project deletion could not be finalized');
        // A project's runtime row goes with the project: core has just removed the rows that made the
        // environment reachable, so a tombstone would only be one dead row per deleted project. A Site
        // keeps its own: a re-published Site resumes from the generation that row records.
        if (row.kind === 'project') {
          store.removeProjectPublications(row.project_id);
          db.prepare('DELETE FROM p_sandbox_runtimes WHERE kind=? AND resource_id=?').run(row.kind, row.resource_id);
        }
        else { row.state = 'deleted'; row.error = null; store.save(row); }
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
      try { await authorize(row.kind, row.resource_id, userId, true, true); return userId; }
      catch { /* Try another currently authorized account. */ }
    }
    return null;
  }

  async function queueAutomaticRecovery(row, observed) {
    if (row.desired_state !== 'running' || row.state === 'deleted' || row.spec.legacyWorkspaceLayout || (row.kind === 'project' && !rootOf(row))) return;
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
    const reason = observed ? `container not running after host reboot (${observed.state})` : 'container missing after host reboot';
    store.transaction(() => {
      const current = store.get(row.kind, row.resource_id);
      if (!current || current.desired_state !== 'running' || current.state === 'deleted' || store.active(row.kind, row.resource_id)) return;
      const op = store.enqueue(current, userId, { kind: 'start' }, `autostart:${current.generation}:${attempt}:${now}`);
      op.checkpoint.autoRecovery = { attempt, queuedAt: now, reason };
      declareSteps(op); store.saveOperation(op);
      store.log(current.kind, current.resource_id, `start queued automatically: ${reason} (attempt ${attempt}/${AUTO_RECOVERY_DELAYS_MS.length})`);
    });
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

  async function reconcile() {
    if (!daemon || disposed || reconciling) return;
    reconciling = true;
    try {
      // Both runtimes answer the same question about the same namespace, each by its own means: an
      // ownership label for Podman, a machine-name prefix for nspawn. The sweep below needs one map of
      // every envelope that is up, whichever runtime is holding it — and a host where nothing has been
      // migrated has no machines to ask about, so it is not asked.
      const migrated = store.all().some((row) => row.spec?.input?.disk?.runtime === 'nspawn');
      const inventory = new Map([...await podman.containerInventory(namespace),
        ...(migrated ? await nspawn.containerInventory(namespace) : [])]);
      const runningContainers = new Set([...inventory.entries()].filter(([, state]) => state === 'running').map(([name]) => name));
      for (const row of store.all()) {
        if (!['project', 'site'].includes(row.kind) || row.desired_state !== 'running' || store.active(row.kind, row.resource_id)) continue;
        // A pre-mount container is an operator decision (recreate or delete), never an automatic one.
        if (row.spec.legacyWorkspaceLayout) continue;
        if (row.kind === 'project' && (!rootOf(row) || releasingAdoptions.has(Number(row.resource_id)))) continue;
        const spec = specFor(row.spec);
        if (inventory.get(spec.name) === 'running') continue;
        // A container this runtime cannot verify (a mismatched specification, a Podman error) is not a
        // recovery candidate, and it must not stop the sweep for every other environment either.
        try {
          const observed = await runtimeFor(spec).inspect(spec);
          if (observed?.state === 'running') { runningContainers.add(spec.name); continue; }
          await queueAutomaticRecovery(row, observed);
        } catch (cause) {
          store.log(row.kind, row.resource_id, `Automatic recovery skipped: ${cause.message}`);
        }
      }
      for (const op of store.operations()) {
        if (disposed) break;
        if (op.kind === 'project' && releasingAdoptions.has(Number(op.resource_id))) continue;
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
          if (op.kind === 'image') {
            await siteImages.authorizeJob(op);
            const imageReference = await siteImages.provision(op.action.imageKind);
            checkpoint(op, { imageReference });
            op.status = 'succeeded'; op.error = null; op.percent = 100; store.saveOperation(op); publishOperation(op);
            continue;
          }
          const row = op.user_id === null ? await siteCleanup.rowForOperation(op) : await rowFor(op.kind, op.resource_id, op.user_id, true, true,
            op.kind === 'site' && op.action.kind === 'delete' && op.checkpoint.bindingHandover === true);
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
      for (const row of store.all()) {
        if (row.kind === 'project' && releasingAdoptions.has(Number(row.resource_id))) continue;
        if (store.active(row.kind, row.resource_id)) continue;
        for (const leased of store.leases(row.kind, row.resource_id)) {
          let allowed = true;
          try { await authorize(row.kind, row.resource_id, leased.user_id, false, true); } catch { allowed = false; }
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
      for (const row of store.all().filter((entry) => entry.kind === 'project' && entry.state === 'running' && rootOf(entry))) {
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
        const present = publications.filter((publication) => forwarderSocketPresent(join(spec.storageRoot, 'broker', publicationSocketName(publication.publicationId))));
        const active = new Set(present.length ? await runtimeFor(spec).activePublications(spec, present.map((publication) => publication.publicationId)) : []);
        for (const publication of publications) {
          if (active.has(publication.publicationId)) continue;
          try { await establishPublication(row, publication.publicationId, publication.port); }
          catch (cause) { store.log('project', publication.projectId, `publication ${publication.publicationId} forwarder could not be established: ${cause.message}`); }
        }
      }
    } finally { reconciling = false; }
  }

  async function snapshots(kind, id, userId) {
    if (kind === 'project') await authorize(kind, id, userId, true);
    else await rowFor(kind, id, userId, true);
    return store.snapshots(kind, id).map((entry) => ({ id: entry.id, generation: entry.generation, createdAt: entry.created_at, consistency: 'crash-consistent', completeProject: JSON.parse(entry.manifest_json).completeProject, note: entry.note }));
  }
  async function logs(kind, id, userId, lines = 200) {
    const row = await rowFor(kind, id, userId, true);
    if (!Number.isSafeInteger(lines) || lines < 1 || lines > 1000) throw error('invalid_limit', 'Log line limit must be between 1 and 1000', 400);
    const lifecycle = store.logs(kind, id);
    if (row.state !== 'running' || store.active(kind, id)) return { lifecycle, journal: '' };
    const result = await runGuest(row, userId, ['/usr/bin/journalctl', '--no-pager', '-n', String(lines)], { kind: 'sites', timeoutMs: 30000 });
    if (result.code !== 0) throw error('journal_failed', result.stderr || 'Guest journal read failed');
    return { lifecycle, journal: result.stdout };
  }

  async function managedWorktrees(input) {
    const id = projectId(input.project);
    account(input.accountUserId, input.action?.kind !== 'list');
    const row = await ready('project', id, input.accountUserId);
    return await manageWorktrees({ db, runGuest, row, userId: input.accountUserId, action: input.action, root: rootOf(row) });
  }

  function forwarderSocketPresent(path) {
    try { return lstatSync(path).isSocket(); }
    catch (cause) { if (cause.code === 'ENOENT') return false; throw cause; }
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

  async function establishPublication(row, publicationId, port) {
    const active = publicationEstablishments.get(publicationId);
    if (active) return await active;
    const establishing = startForwarder(row, publicationSocketName(publicationId), port, 'publication',
      (spec, argv) => runtimeFor(spec).startPublication(spec, publicationId, argv));
    publicationEstablishments.set(publicationId, establishing);
    try { return await establishing; }
    finally { if (publicationEstablishments.get(publicationId) === establishing) publicationEstablishments.delete(publicationId); }
  }

  /** Every publication of one project, established again after the container that carried them ended.
   *  A transport that cannot be established must not fail the environment start — the container is up and
   *  everything else about the project is usable — so it is named and reconciliation retries it. */
  async function establishPublications(row) {
    for (const publication of store.publications(Number(row.resource_id))) {
      try { await establishPublication(row, publication.publicationId, publication.port); }
      catch (cause) { store.log(row.kind, row.resource_id, `publication ${publication.publicationId} forwarder could not be established: ${cause.message}`); }
    }
  }

  /** A published transport is DURABLE and account-independent: its record is keyed by the project and the
   *  publication, and no execution lease is taken, because the visitor it answers is nobody's account. */
  async function projectPublicationBinding(input) {
    assertLive();
    const id = projectId(input.project);
    const publicationId = resourceToken(String(input.publicationId ?? ''));
    if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535) throw error('invalid_port', 'Invalid guest publication port', 400);
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
      row = await ready('project', id, input.accountUserId);
      // The record first: it is the whole of the durability claim, and a transport that cannot be
      // established on this attempt is then reconciliation's to establish rather than something the
      // caller has to remember to ask for again.
      store.savePublication(row, publicationId, input.port);
    }
    const socketPath = await establishPublication(row, publicationId, input.port);
    return { generation: row.generation, socketPath };
  }

  /** The only thing that takes a publication away again: stop its forwarder when the container is running,
   *  remove the socket it left, then retire the durable record. */
  async function projectPublicationRelease(input) {
    assertLive();
    const id = projectId(input.project);
    const publicationId = resourceToken(String(input.publicationId ?? ''));
    const row = store.get('project', id);
    if (row) {
      const spec = specFor(row.spec);
      if ((await runtimeFor(spec).inspect(spec))?.state === 'running') await runtimeFor(spec).stopPublication(spec, publicationId);
      removeForwarderSocket(join(spec.storageRoot, 'broker', publicationSocketName(publicationId)), 'publication');
    }
    store.removePublication(id, publicationId);
  }

  async function releaseAdoptedWorkspace(input) {
    account(input.accountUserId, true);
    const id = projectId(input.project);
    if (reconciling || releasingAdoptions.has(id)) throw error('environment_busy', 'Environment reconciliation is already running');
    releasingAdoptions.add(id);
    try {
      const project = await authorize('project', id, input.accountUserId, true);
      if (!project.adoptedPath) throw error('project_not_adopted', 'Project was not adopted', 409);
      await assertNoPublishedSites(id);
      const row = store.get('project', id);
      if (!row) return;
      if (store.active('project', id)) throw error('environment_busy', 'An environment lifecycle operation is already pending');
      if (store.publications(id).length) throw error('published_sites_exist', 'Transfer or delete this Project\'s published Sites before releasing the Project');
      const snapshots = store.snapshots('project', id);
      const recipes = new Map([[specFor(row.spec).name, row.spec]]);
      for (const saved of snapshots) { const recipe = JSON.parse(saved.spec_json); recipes.set(specFor(recipe, true).name, recipe); }
      for (const entry of db.prepare('SELECT checkpoint_json FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=?').all('project', String(id))) {
        const checkpoint = JSON.parse(entry.checkpoint_json);
        for (const key of ['oldSpec', 'newSpec']) if (checkpoint[key]) recipes.set(specFor(checkpoint[key], true).name, checkpoint[key]);
      }
      for (const recipe of recipes.values()) {
        const owned = specFor(recipe, true);
        if (await runtimeFor(owned).inspect(owned)) {
          await stopRow({ ...row, spec: recipe, generation: recipe.input.generation });
          await runtimeFor(owned).remove(owned);
        }
      }
      const spec = specFor(row.spec);
      await storage.releaseWorkspace(spec, project.adoptedPath);
      for (const saved of snapshots) {
        const owned = specFor(JSON.parse(saved.spec_json), true);
        await runtimeFor(owned).removeSnapshotImage(owned, JSON.parse(saved.manifest_json).snapshotId);
      }
      for (const recipe of recipes.values()) {
        const owned = specFor(recipe, true);
        for (const volume of owned.volumes) await runtimeFor(owned).removeVolume(owned, volume.component);
      }
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
    const row = await ready('project', id, input.accountUserId);
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

  const control = {
    async projectWorkspaceHostPath(input) {
      assertLive();
      const id = positive(input?.projectId, 'project');
      const project = stores().projects.get(id);
      if (!project || project.lifecycle !== 'active') throw error('project_missing', 'The source Project is unavailable', 404);
      if (project.executionKind === 'host') return hostPath(project.path);
      if (project.executionKind !== 'managed') throw error('project_unavailable', 'The source Project has no workspace', 409);
      const row = store.get('project', id);
      if (project.adoptedPath && !row?.spec.containerId) {
        try { lstatSync(project.adoptedPath); return hostPath(project.adoptedPath); }
        catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      }
      const record = row?.spec ?? {
        input: { resource: { kind: 'project', id }, generation: 1, image: PROJECT_BASE_IMAGE_TAG,
          previewBroker: true, workspaceTarget: managedGuestRoot(project.slug, id), limits: configuredDefaults(ctx.config) },
        paths: { sandboxDataDir: dataDir, namespace },
      };
      const workspace = specFor(record).volumes.find((volume) => volume.component === 'workspace');
      if (!workspace) throw error('workspace_missing', 'The source Project workspace is unavailable', 409);
      return workspace.path;
    },
    discoverSiteSnapshotImage(input) { assertLive(); return siteImages.discoverSnapshot(input); },
    siteImageStatus(input) { assertLive(); return siteImages.status(input); },
    provisionSiteImage(input) { assertLive(); return siteImages.request(input); },
    requestSiteCleanup(input) { assertLive(); return siteCleanup.request(input); },
    projectPreviewBinding, projectPublicationBinding, projectPublicationRelease, releaseAdoptedWorkspace,
    async environmentFor(input) {
      const id = projectId(input.project);
      await authorize('project', id, input.accountUserId, true);
      const row = store.get('project', id);
      // An unprovisioned project has no stored limits yet, so it reports the defaults it WOULD be
      // created with rather than the built-in figures the administrator may have moved away from.
      return row ? view(row) : { projectId: id, generation: 1, state: 'unprovisioned', desiredState: 'running', lastError: null, limits: configuredDefaults(ctx.config) };
    },
    async projectOverview(input) {
      const environment = await control.environmentFor(input);
      const id = projectId(input.project);
      const operations = store.recentOperations('project', id, OPERATION_HISTORY).map(operationView);
      return { environment, snapshots: await snapshots('project', id, input.accountUserId), operations };
    },
    requestEnvironment: (input) => request('project', projectId(input.project), input),
    environmentOperation: (input) => getOperation('project', input), projectFiles, revokeProjectAccess,
    environmentSnapshots: (input) => snapshots('project', projectId(input.project), input.accountUserId),
    environmentLogs: (input) => logs('project', projectId(input.project), input.accountUserId, input.lines), managedWorktrees,
    connectSitesRuntime(authority) {
      if (!authority || typeof authority.resolve !== 'function' || typeof authority.beforeStart !== 'function' || typeof authority.afterStop !== 'function') throw error('invalid_sites_authority', 'A complete trusted Sites authority is required');
      sites = authority;
    },
    async registerSiteEnvironment(input) {
      account(input.accountUserId, true);
      const registration = await authorize('site', input.siteId, input.accountUserId, true);
      positive(registration.projectId, 'source project');
      const effective = limits(registration.limits);
      const existing = store.get('site', input.siteId);
      if (existing && existing.state !== 'deleted') {
        if (upgradesLegacySiteBinding(existing.spec.registration, registration)) {
          return store.transaction(() => {
            const current = store.get('site', input.siteId);
            if (!current || current.state === 'deleted') throw error('environment_missing', 'Environment metadata changed');
            if (!upgradesLegacySiteBinding(current.spec.registration, registration)) {
              if (same(siteBinding(registration), siteBinding(current.spec.registration))) return view(current);
              throw error('site_binding_changed', 'The trusted Site binding changed; an explicit handover is required');
            }
            current.spec.registration = registration;
            current.spec.binding.sourcePath = registration.sourcePath;
            store.save(current);
            return view(current);
          });
        }
        return view(await rowFor('site', input.siteId, input.accountUserId, true));
      }
      if (stores().projects.get(registration.projectId)?.lifecycle === 'deleting') throw error('project_deleting', 'A deleting Project cannot acquire a new published Site');
      if (store.active('site', input.siteId)) throw error('site_busy', 'The previous Site lifecycle operation has not completed');
      const record = siteRecord(registration, existing ? existing.generation + 1 : 1);
      const intent = registration.initialIntent;
      if (intent && (!['running', 'stopped'].includes(intent.desiredState) || ![null, 'start', 'stop', 'restart'].includes(intent.pendingAction)
        || (intent.restartSequence !== undefined && (!Number.isSafeInteger(intent.restartSequence) || intent.restartSequence < 0)))) throw error('invalid_handover_intent', 'Invalid Site lifecycle checkpoint');
      return store.transaction(() => {
        const raced = store.get('site', input.siteId);
        if (raced && raced.state !== 'deleted') return view(raced);
        const row = raced ?? store.insert('site', input.siteId, registration.projectId, record, effective);
        row.spec = record; row.generation = record.input.generation; row.limits = effective; row.error = null;
        row.state = 'unprovisioned';
        row.desired_state = intent?.desiredState ?? 'running';
        const pending = intent?.pendingAction ?? (intent && row.desired_state === 'running' ? 'start' : null);
        if (pending) {
          store.enqueue(row, input.accountUserId, { kind: pending }, `handover:${row.generation}:${intent.restartSequence ?? 0}`);
          if (pending !== 'stop') row.state = 'starting';
        }
        db.prepare('UPDATE p_sandbox_runtimes SET project_id=? WHERE kind=? AND resource_id=?').run(registration.projectId, 'site', input.siteId);
        row.project_id = registration.projectId; store.save(row);
        return view(row);
      });
    },
    siteEnvironmentFor: async (input) => view(await rowFor('site', input.siteId, input.accountUserId, true)),
    requestSiteEnvironment: (input) => request('site', input.siteId, input),
    siteEnvironmentOperation: (input) => getOperation('site', input),
    async siteEnvironmentExec(input) {
      account(input.accountUserId, true);
      await authorize('site', input.siteId, input.accountUserId, true);
      const row = await ready('site', input.siteId, input.accountUserId);
      // SiteExec runs the script to completion and returns its output. Nothing reads the guest's stdin
      // after the script, so the byte-counting bootstrap that exists to protect a duplex protocol has
      // nothing to protect here.
      const program = command({ type: 'shell', command: input.command }, true);
      return await runGuest(row, input.accountUserId, program.argv, { input: program.input, workdir: guestPath(input.workdir ?? '/workspace'), timeoutMs: input.timeoutMs ?? 120000, signal: input.signal, kind: 'sites' });
    },
    siteEnvironmentLogs: (input) => logs('site', input.siteId, input.accountUserId, input.lines),
    siteEnvironmentSnapshots: (input) => snapshots('site', input.siteId, input.accountUserId),
  };
  return { ...control, control, prepareExecution, reconcile,
    async revokeAccount(userId) { for (const row of store.all()) await cancelLeases(row, userId); },
    async dispose() { disposed = true; for (const release of [...previews]) await release(); } };
}
