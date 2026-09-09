import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join, posix } from 'node:path';
import { exportProjectTree, removeOwnedArtifact } from './environmentExport.mjs';
import { manageWorktrees } from './managedWorktrees.mjs';
import { createSiteImageService } from './environmentSiteImages.mjs';
import { createSiteCleanupService } from './environmentSiteCleanup.mjs';
import { createGuestFileTransport, validateUploadOperation, UPLOAD_KINDS } from './guestFileTransport.mjs';
import { managedShellFrame } from './managedBootstrap.mjs';
import { createEnvironmentStore } from './environmentDb.mjs';
import { ownerProvablyDead, processIdentity, withRepoLease } from './db.mjs';
import { createContainerSpec, createBoundSiteSpec, withContainerLimits, resourceToken, bindContainerIdentity } from './containerSpec.mjs';
import { PodmanClient } from './podman.mjs';
import { ContainerStorage } from './containerStorage.mjs';
import { PROJECT_BASE_IMAGE_TAG } from './containerBaseImage.mjs';

const FILE_HELPER = readFileSync(new URL('./guestFiles.py', import.meta.url), 'utf8');
const PREVIEW_HELPER = readFileSync(new URL('./previewProxy.py', import.meta.url), 'utf8');
const DEFAULT_LIMITS = { cpus: 1, memoryMb: 1024, pidsLimit: 512, diskSoftMb: 10240 };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  for (const key of ['memoryMb', 'pidsLimit', 'diskSoftMb']) positive(result[key], key);
  return result;
}
function action(value, kind) {
  if (!value || typeof value !== 'object') throw error('invalid_action', 'An environment action is required', 400);
  const fields = { start: [], stop: [], restart: [], delete: [], snapshot: ['note', 'includeData'], restore: ['snapshotId', 'restoreData'], limits: ['limits'],
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
function command(input) {
  // `bash -s` would read the script off stdin with a buffered reader and take whatever followed it in
  // the same write — which for a duplex consumer (a language server, a CDP client) is its first protocol
  // frames. The bootstrap reads exactly the declared number of bytes, execs bash on them, and leaves the
  // rest of stdin untouched for the program.
  if (input?.type === 'shell' && typeof input.command === 'string' && Buffer.byteLength(input.command) <= 524288) {
    const frame = managedShellFrame(input.command);
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
  const keys = { stat: ['followSymlinks'], list: ['limit', 'cursor'], read: ['maxBytes', 'offset', 'length'], write: ['base64', 'expectedVersion'], remove: ['expectedVersion'], mkdir: [], rename: ['destination', 'expectedVersion'], search: ['pattern', 'glob', 'caseSensitive', 'limit'] };
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
export function createEnvironmentRuntime({ ctx, db, dataDir, namespace = 'elowen', podman = new PodmanClient({ outputLimitBytes: 16 * 1024 * 1024 }), storage = new ContainerStorage(podman), daemon = typeof process.send !== 'function' }) {
  const store = createEnvironmentStore(db, processIdentity);
  const transfers = createGuestFileTransport({ db, helperSource: FILE_HELPER, runGuest,
    runCleanup: async (row, _userId, argv, options) => {
      const current = store.get(row.kind, row.resource_id);
      if (!current || current.generation !== row.generation) throw error('generation_changed', 'Upload cleanup generation changed');
      const spec = specFor(row.spec);
      if ((await podman.inspect(spec))?.state !== 'running') throw error('upload_cleanup_pending', 'Start the environment to clean up its unfinished uploads');
      return await podman.exec(spec, randomUUID().replaceAll('-', ''), argv, { ...options, persistent: true });
    },
  });
  let sites;
  let disposed = false;
  let reconciling = false;
  const previews = new Set();
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
      if (!internal && ctx.currentAccountUserId() != null && (scope.workspaceRef || (scope.projectRef && scope.projectRef.projectId !== Number(id)) || (!scope.admin && scope.projectIds && !scope.projectIds.includes(Number(id))))) throw error('project_scope', 'Project is outside the current turn scope', 403);
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
    return { registration, input: { resource: { kind: 'site', id: registration.siteId }, generation, image: registration.image, network: registration.network,
      workspaceReadOnly: registration.workspaceReadOnly, limits: { cpus: effective.cpus, memoryMb: effective.memoryMb, pidsLimit: effective.pidsLimit } },
      binding: { namespace, sitesDataDir: registration.sitesDataDir, sourcePath: registration.sourcePath, brokerDir: registration.brokerDir, ...(registration.legacy ? { legacy: registration.legacy } : {}) } };
  }
  function specFor(record) {
    const input = { ...record.input, limits: record.creationLimits ?? record.input.limits };
    const base = input.resource.kind === 'site' ? createBoundSiteSpec(input, record.binding) : createContainerSpec(input, record.paths);
    const spec = same(input.limits, record.input.limits) ? base : withContainerLimits(base, record.input.limits);
    return record.containerId ? bindContainerIdentity(spec, record.containerId) : spec;
  }
  async function rowFor(kind, id, userId, manage = false, internal = false) {
    const authority = await authorize(kind, id, userId, manage, internal);
    let row = store.get(kind, id);
    if (kind === 'site') {
      if (!row) throw error('site_not_registered', 'Register the trusted Site binding before requesting lifecycle work');
      const binding = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !['limits', 'initialIntent', 'snapshotRetention', 'staging'].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
      if (!same(binding(authority), binding(row.spec.registration))) throw error('site_binding_changed', 'The trusted Site binding changed; an explicit handover is required');
    }
    if (!row) {
      const effective = limits(DEFAULT_LIMITS);
      const spec = { input: { resource: { kind: 'project', id: Number(id) }, generation: 1, image: PROJECT_BASE_IMAGE_TAG, previewBroker: true, limits: { cpus: effective.cpus, memoryMb: effective.memoryMb, pidsLimit: effective.pidsLimit } }, paths: { sandboxDataDir: dataDir, namespace } };
      row = store.insert(kind, id, Number(id), spec, effective);
    }
    return row;
  }
  const view = (row) => ({ [row.kind === 'project' ? 'projectId' : 'siteId']: row.kind === 'project' ? Number(row.resource_id) : row.resource_id,
    generation: row.generation, state: row.state, desiredState: row.desired_state, lastError: row.error ?? null, limits: row.limits });
  const operationView = (op) => ({ id: op.id, requestId: op.request_key, [op.kind === 'project' ? 'projectId' : 'siteId']: op.kind === 'project' ? Number(op.resource_id) : op.resource_id,
    accountUserId: op.user_id, generation: op.generation, action: op.action, status: op.status, error: op.error ?? null, ...(op.snapshot_id ? { snapshotId: op.snapshot_id } : {}) });
  const assertGeneration = (row, expected) => { if (expected !== undefined && expected !== row.generation) throw error('generation_changed', 'Environment generation changed'); };
  const checkpoint = (op, values) => { Object.assign(op.checkpoint, values); store.saveOperation(op); };
  const assertLive = () => { if (disposed) throw error('runtime_unavailable', 'The environment provider was detached', 503); };

  async function assertNoPublishedSites(id) {
    if (sites && !sites.projectDependents) throw error('sites_preflight_unavailable', 'Sites must provide publication-dependency preflight before Project deletion');
    const published = sites ? await sites.projectDependents(Number(id)) : [];
    if (published.length || store.all().some((site) => site.kind === 'site' && site.project_id === Number(id) && site.state !== 'deleted')) throw error('published_sites_exist', 'Transfer or delete this Project\'s published Sites before deleting the Project');
  }

  async function request(kind, id, input) {
    assertLive();
    account(input.accountUserId, true);
    const requested = action(input.action, kind);
    await rowFor(kind, id, input.accountUserId, true);
    if (requested.kind === 'delete' && kind === 'project') await assertNoPublishedSites(id);
    if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(input.requestId))) throw error('invalid_request_id', 'Invalid idempotency key', 400);
    return store.transaction(() => {
      account(input.accountUserId, true);
      if (kind === 'project' && !stores().userProjects.canManage(input.accountUserId, Number(id))) throw error('project_forbidden', 'Project access was revoked', 403);
      const row = store.get(kind, id);
      if (!row) throw error('environment_missing', 'Environment metadata changed');
      const active = store.active(kind, id);
      const prior = input.requestId ? store.prior(kind, id, input.accountUserId, input.requestId) : null;
      if (prior && !same(prior.action, requested)) throw error('request_conflict', 'Idempotency key belongs to another action');
      if (prior && prior.status !== 'failed') return operationView(prior);
      assertGeneration(row, input.expectedGeneration);
      if (requested.kind === 'limits' && !stores().usersRead.isAdmin(input.accountUserId)) throw error('admin_required', 'Only administrators may change resource limits', 403);
      if (row.state === 'deleted') throw error('environment_deleted', 'The environment has been deleted');
      if (row.desired_state === 'deleted' && requested.kind !== 'delete') throw error('environment_deleting', 'The environment is deleting');
      if (prior) {
        if (!active) { prior.status = 'pending'; prior.error = null; store.saveOperation(prior); }
        return operationView(prior);
      }
      if (active) {
        if (!input.requestId && active.user_id === input.accountUserId && same(active.action, requested)) return operationView(active);
        throw error('environment_busy', 'An environment lifecycle operation is already pending');
      }
      const op = store.enqueue(row, input.accountUserId, requested, input.requestId);
      if (requested.kind === 'delete') {
        if (kind === 'project' && !stores().projects.beginDeletion(Number(id))) throw error('project_deletion_changed', 'Core Project deletion intent could not be recorded');
        row.desired_state = 'deleted'; row.state = 'deleting';
      }
      else if (['start', 'restart'].includes(requested.kind)) row.desired_state = 'running';
      else if (requested.kind === 'stop') row.desired_state = 'stopped';
      store.save(row);
      return operationView(op);
    });
  }

  async function getOperation(kind, input) {
    account(input.accountUserId);
    const op = store.getOperation(input.operationId);
    if (!op || op.kind !== kind) return null;
    if (!(op.action.kind === 'delete' && op.status === 'succeeded' && op.user_id === input.accountUserId)) await authorize(kind, op.resource_id, input.accountUserId, true);
    return operationView(op);
  }

  async function ready(kind, id, userId) {
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
    if ((await podman.inspect(specFor(row.spec)))?.state !== 'running') throw error('runtime_unavailable', 'The validated container is not running', 503);
    return row;
  }

  async function mint(row, userId, kind) {
    await authorize(row.kind, row.resource_id, userId);
    return store.transaction(() => {
      const current = store.get(row.kind, row.resource_id);
      if (!current || current.generation !== row.generation || current.state !== 'running' || store.active(row.kind, row.resource_id)) throw error('environment_busy', 'Environment changed before execution could be leased');
      const other = store.leases(row.kind, row.resource_id).filter((lease) => lease.kind !== 'preview');
      if (other.some((lease) => lease.kind === 'worktrees') || (kind === 'worktrees' && other.length)) throw error('environment_busy', 'Managed worktree mutation requires an idle execution boundary');
      return store.mintLease(current, userId, kind);
    });
  }
  function leaseHandle(row, lease) {
    const spec = specFor(row.spec);
    let released = false;
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
      async cancel() {
        if (released) return;
        db.prepare('UPDATE p_sandbox_execution_leases SET cancel_requested=1 WHERE id=?').run(lease.id);
        const current = await podman.inspect(spec);
        if (current?.state === 'running') await podman.cancelExecution(spec, lease.execution_id, { persistent: true });
        else if (current && !['stopped', 'exited', 'created'].includes(current.state)) throw error('cancellation_unverified', 'Guest termination cannot be verified');
      },
      async release() {
        if (released) return;
        const current = await podman.inspect(spec);
        if (current?.state === 'running') await podman.releaseExecution(spec, lease.execution_id, { persistent: true });
        else if (current && !['stopped', 'exited', 'created'].includes(current.state)) throw error('cancellation_unverified', 'Guest termination cannot be verified');
        db.prepare('DELETE FROM p_sandbox_execution_leases WHERE id=? AND execution_id=?').run(lease.id, lease.execution_id);
        released = true;
      },
    };
  }

  async function runGuest(row, userId, argv, options = {}) {
    const leased = await mint(row, userId, options.kind ?? 'files');
    const handle = leaseHandle(row, leased);
    let failure;
    try { return await podman.exec(specFor(row.spec), leased.execution_id, argv, { ...options, persistent: true }); }
    catch (cause) { failure = cause; throw cause; }
    finally {
      try { await handle.release(); }
      catch (cause) { throw new AggregateError([...(failure ? [failure] : []), cause], `Managed execution cleanup failed: ${cause.message}`); }
    }
  }

  async function prepareExecution(input, userId) {
    const id = projectId(input.projectRef);
    account(userId, true);
    if (input.workspace || ctx.currentAccess().workspaceRef) throw error('workspace_pinned', 'A legacy narrow workspace cannot widen into a managed Project', 403);
    const row = await ready('project', id, userId);
    const program = command(input.command);
    const cwd = guestPath(input.cwd ?? '/workspace');
    const leased = await mint(row, userId, input.leaseKind);
    const handle = leaseHandle(row, leased);
    try {
      const prepared = await podman.prepareExecution(specFor(row.spec), leased.execution_id, program.argv, { input: program.input, workdir: cwd, timeoutMs: 900000 });
      return { mode: 'managed', projectRef: input.projectRef, cwd: dataDir, displayCwd: cwd, home: '/root', roots: ['/'],
        launch: prepared.launch, stdin: program.input, cancel: () => handle.cancel(), workspace: null, lease: handle,
        sanitizeOutput: (text) => String(text).split(dataDir).join('[environment-storage]') };
    } catch (cause) { await handle.release(); throw cause; }
  }

  async function projectFiles(input) {
    const id = projectId(input.project);
    const op = fileOperation(input.operation);
    account(input.accountUserId, ['write', 'remove', 'mkdir', 'rename', ...UPLOAD_KINDS].includes(op.kind));
    const row = await ready('project', id, input.accountUserId);
    assertGeneration(row, input.expectedGeneration);
    return await withRepoLease(db, `environment-files:project:${id}`, async () => {
      if (UPLOAD_KINDS.includes(op.kind)) return await transfers.perform({ row, accountUserId: input.accountUserId, operation: op });
      const result = await runGuest(row, input.accountUserId, ['/usr/bin/python3', '-c', FILE_HELPER], { input: JSON.stringify(op), timeoutMs: 120000 });
      if (result.truncated) throw error('output_limit', 'Guest file output exceeded its bound');
      let reply;
      try { reply = JSON.parse(result.stdout); } catch { throw error('guest_protocol', 'Invalid guest file response'); }
      if (!reply?.ok || result.code !== 0) throw error(reply?.error?.code ?? 'guest_file_error', reply?.error?.message ?? 'Guest file operation failed');
      if (reply.result?.kind !== op.kind) throw error('guest_protocol', 'Guest response kind differs from the requested operation');
      return reply.result;
    });
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
    const current = await podman.inspect(spec);
    if (!current) return;
    if (current.state === 'paused') await podman.unpause(spec);
    if (['running', 'paused', 'stopping'].includes(current.state)) {
      await cancelLeases(row);
      await podman.stop(spec);
    }
    const stopped = await podman.inspect(spec);
    if (stopped && !['created', 'configured', 'stopped', 'exited'].includes(stopped.state)) throw error('stop_unverified', 'Container stop could not be verified');
    if (row.kind === 'site') await sites.afterStop(row.resource_id);
  }
  async function ensureInitialContainer(row, op) {
    const spec = specFor(row.spec);
    let current = await podman.inspect(spec);
    if (row.spec.containerId || spec.legacy) {
      if (!current) throw error('persistent_container_missing', 'The persistent root filesystem is missing; restore a snapshot explicitly');
      return current;
    }
    if (current && !op.checkpoint.creating) throw error('container_unclaimed', 'A container exists without this creation checkpoint');
    if (!op.checkpoint.creating) checkpoint(op, { creating: true });
    if (!current) {
      if (row.kind === 'site') await sites.beforeCreate?.(row.resource_id);
      current = await podman.create(spec);
    }
    row.spec.containerId = current.id;
    store.save(row);
    return current;
  }

  async function startRow(row, op) {
    if (row.kind === 'project' && row.spec.input.image === PROJECT_BASE_IMAGE_TAG && !op.checkpoint.imageReady) {
      row.spec.input.image = await podman.ensureProjectImage(dataDir);
      store.save(row); checkpoint(op, { imageReady: true });
    }
    if (!row.spec.containerId && !row.spec.binding?.legacy) await storage.prepare(specFor(row.spec));
    const current = await ensureInitialContainer(row, op);
    const spec = specFor(row.spec);
    if (row.kind === 'site') await sites.beforeStart(row.resource_id);
    if (current.state === 'paused') await podman.unpause(spec);
    else if (current.state !== 'running') await podman.start(spec);
    if ((await podman.inspect(spec))?.state !== 'running') throw error('start_unverified', 'Container start could not be verified');
    if (row.kind === 'project' && !op.checkpoint.initialized) {
      const result = await podman.exec(spec, randomUUID().replaceAll('-', ''), ['/bin/bash', '-s'], { input: 'set -eu\nif [ ! -e /workspace/.git ]; then\n git init -b main /workspace\n git -C /workspace -c user.name=Elowen -c user.email=environment@localhost -c core.hooksPath=/dev/null commit --allow-empty -m "Initialize managed project"\nfi\nmkdir -p /worktrees\n', timeoutMs: 30000, persistent: true });
      if (result.code !== 0) throw error('initialization_failed', result.stderr || 'Project initialization failed');
      checkpoint(op, { initialized: true });
    }
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
        await podman.removeRetainedSiteImage(spec, artifact.imageReference, artifact.imageId);
        if (artifact.archivePath) removeOwnedArtifact(artifact.archivePath);
      } else await podman.removeSnapshotImage(spec, manifest.snapshotId);
      await podman.removeSnapshotStorage(spec, manifest.snapshotId);
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
  const siteCleanup = createSiteCleanupService({ podman, store, namespace, siteRecord, normalizeLimits: limits,
    userExists: (id) => stores().usersRead.list().some((user) => user.id === id),
    resolveCleanup: (input) => sites?.resolveCleanup?.(input),
  });

  async function performSiteAction(row, op) {
    const registration = await authorize('site', row.resource_id, op.user_id, true, true);
    const spec = specFor(row.spec);
    const kind = op.action.kind;
    if (kind === 'provision-image') {
      const image = await siteImages.provision(op.action.imageKind);
      if (image !== row.spec.input.image) throw error('site_image_mismatch', 'The fixed recipe does not match the registered Site image');
      return;
    }
    if (kind === 'prepare') {
      if (!row.spec.containerId && !spec.legacy) await storage.prepare(spec);
      const current = await ensureInitialContainer(row, op);
      row.state = current?.state === 'running' ? 'running' : 'stopped';
      row.desired_state = row.state; store.save(row); return;
    }
    if (kind === 'cleanup-stage') {
      if (!registration.staging) throw error('site_not_staging', 'Only an unpublished conversion binding may be cleaned up as staging');
      await stopRow(row);
      if (await podman.inspect(spec)) await podman.remove(spec);
      for (const volume of spec.volumes) await podman.removeVolume(spec, volume.component);
      if (!spec.legacy) await podman.removeGenerationStorage(spec);
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
      const current = await podman.inspect(spec);
      if (kind === 'import-data' && current?.state === 'running') throw error('site_running', 'Stop the conversion target before seeding its data');
      let paused = false;
      try {
        if (kind === 'export-data' && current?.state === 'running') { await podman.pause(spec); paused = true; }
        await podman.siteDataArchive(spec, kind === 'import-data' ? 'import' : 'export', artifact.archivePath);
        checkpoint(op, { archiveCompleted: true });
      } finally { if (paused || (current?.state === 'running' && (await podman.inspect(spec))?.state === 'paused')) await podman.unpause(spec); }
      return;
    }
    if (kind === 'remove-artifact') {
      if (artifact.kind === 'snapshot') {
        await podman.removeRetainedSiteImage(spec, artifact.imageReference, artifact.imageId);
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

  async function perform(row, op) {
    const kind = op.action.kind;
    if (row.kind === 'project' && ['stop', 'restart', 'snapshot', 'restore'].includes(kind)) {
      await cancelLeases(row);
      await transfers.quiesce({ row });
    }
    if (row.kind === 'site' && ['prepare', 'cleanup-stage', 'provision-image', 'import-data', 'export-data', 'import-snapshot', 'remove-artifact', 'export-project'].includes(kind)) return await performSiteAction(row, op);
    if (kind === 'start' || kind === 'restart') {
      row.state = 'starting'; store.save(row);
      if (kind === 'restart' && !op.checkpoint.stopped) { await stopRow(row); checkpoint(op, { stopped: true }); }
      await startRow(row, op);
    } else if (kind === 'stop') {
      await stopRow(row); row.state = 'stopped'; row.error = null; store.save(row);
    } else if (kind === 'snapshot') {
      if (!op.snapshot_id) { op.snapshot_id = `snapshot-${op.id.slice(4)}`; store.saveOperation(op); }
      await cancelLeases(row);
      await snapshot(row, op, op.snapshot_id, op.action.note, op.action.includeData !== false);
      if (row.kind === 'site') await pruneSiteSnapshots(row, op);
    } else if (kind === 'restore') {
      const saved = store.snapshot(row.kind, row.resource_id, op.action.snapshotId);
      if (!saved) throw error('snapshot_missing', 'Snapshot is not retained for this environment');
      const source = JSON.parse(saved.spec_json);
      const storageId = JSON.parse(saved.manifest_json).snapshotId;
      const manifest = await storage.readSnapshot(specFor(source), storageId);
      if (!op.checkpoint.oldSpec) checkpoint(op, { oldSpec: row.spec, oldGeneration: row.generation, wasRunning: row.desired_state === 'running' });
      const old = { ...row, spec: op.checkpoint.oldSpec, generation: op.checkpoint.oldGeneration };
      await stopRow(old);
      if (!op.checkpoint.newSpec) {
        const next = JSON.parse(JSON.stringify(old.spec));
        const reserved = db.prepare("SELECT MAX(json_extract(checkpoint_json,'$.newSpec.input.generation')) AS generation FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=?").get(row.kind, row.resource_id);
        next.input.generation = Math.max(old.generation, Number(reserved?.generation ?? 0)) + 1;
        next.input.image = manifest.image.reference; next.creationLimits = next.input.limits;
        delete next.containerId;
        if (next.binding?.legacy) delete next.binding.legacy;
        checkpoint(op, { newSpec: next });
      }
      let target = specFor(op.checkpoint.newSpec);
      if (!op.checkpoint.imported) {
        if (row.kind === 'site' && op.action.restoreData === false) {
          const backupId = `preserve-${op.id.slice(4)}`;
          await snapshot(old, op, backupId, 'Restore data checkpoint');
          await storage.readSnapshot(specFor(old.spec), backupId);
          await podman.importSnapshotVolume(specFor(old.spec), backupId, target, 'data', { resume: true });
        } else await storage.restoreVolumes(specFor(source), storageId, target);
        checkpoint(op, { imported: true });
      }
      let restored = await podman.inspect(target);
      if (op.checkpoint.newSpec.containerId && !restored) throw error('restore_target_missing', 'The bound restore target is missing; start a new restore intent');
      if (restored && !op.checkpoint.newSpec.containerId && !op.checkpoint.targetCreating) throw error('restore_target_unclaimed', 'The restore target has no creation checkpoint');
      if (!restored) {
        checkpoint(op, { targetCreating: true });
        if (row.kind === 'site') await sites.beforeCreate?.(row.resource_id);
        restored = await podman.create(target);
      }
      if (!op.checkpoint.newSpec.containerId) {
        op.checkpoint.newSpec.containerId = restored.id;
        checkpoint(op, { newSpec: op.checkpoint.newSpec });
        target = specFor(op.checkpoint.newSpec);
      }
      if (op.checkpoint.wasRunning) {
        if (row.kind === 'site') await sites.beforeStart(row.resource_id);
        if ((await podman.inspect(target))?.state !== 'running') await podman.start(target);
        if ((await podman.inspect(target))?.state !== 'running') throw error('restore_start_failed', 'Restored container did not start');
      }
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
      if (await podman.inspect(specFor(old.spec))) await podman.remove(specFor(old.spec));
      // Old volumes are retained until explicit Project deletion, providing a non-destructive rollback checkpoint.
    } else if (kind === 'limits') {
      if (!stores().usersRead.isAdmin(op.user_id)) throw error('admin_required', 'Resource-limit authority was revoked', 403);
      const prior = specFor(row.spec);
      await podman.update(prior, op.action.limits);
      row.spec.creationLimits ??= row.spec.input.limits;
      row.spec.input.limits = { cpus: op.action.limits.cpus, memoryMb: op.action.limits.memoryMb, pidsLimit: op.action.limits.pidsLimit };
      row.limits = op.action.limits; store.save(row);
    } else if (kind === 'delete') {
      if (row.kind === 'project') await assertNoPublishedSites(row.resource_id);
      await stopRow(row);
      const spec = specFor(row.spec);
      const snapshots = store.snapshots(row.kind, row.resource_id);
      const recipes = new Map([[spec.name, row.spec]]);
      for (const saved of snapshots) { const recipe = JSON.parse(saved.spec_json); recipes.set(specFor(recipe).name, recipe); }
      for (const entry of db.prepare('SELECT checkpoint_json FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=?').all(row.kind, row.resource_id)) {
        const previous = JSON.parse(entry.checkpoint_json);
        for (const key of ['oldSpec', 'newSpec']) if (previous[key]) recipes.set(specFor(previous[key]).name, previous[key]);
      }
      recipes.set(spec.name, row.spec);
      for (const recipe of recipes.values()) {
        const owned = specFor(recipe);
        if (await podman.inspect(owned)) {
          await stopRow({ ...row, spec: recipe, generation: recipe.input.generation });
          await podman.remove(owned);
        }
      }
      checkpoint(op, { containerRemoved: true });
      for (const saved of snapshots) {
        const owned = specFor(JSON.parse(saved.spec_json));
        const manifest = JSON.parse(saved.manifest_json);
        if (manifest.retained) await podman.removeRetainedSiteImage(owned, manifest.image.reference, manifest.image.id);
        else await podman.removeSnapshotImage(owned, manifest.snapshotId);
      }
      for (const recipe of recipes.values()) {
        const owned = specFor(recipe);
        for (const volume of owned.volumes) await podman.removeVolume(owned, volume.component);
      }
      if (row.kind === 'site') await podman.removeOrphanLegacySiteData(spec);
      await podman.removeStorage(spec);
      checkpoint(op, { storageRemoved: true });
      store.transaction(() => {
        db.prepare('DELETE FROM p_sandbox_runtime_snapshots WHERE kind=? AND resource_id=?').run(row.kind, row.resource_id);
        db.prepare('DELETE FROM p_sandbox_execution_leases WHERE resource_kind=? AND resource_id=?').run(row.kind, row.resource_id);
        db.prepare('DELETE FROM p_sandbox_file_uploads WHERE resource_kind=? AND resource_id=?').run(row.kind, row.resource_id);
        if (row.kind === 'project') db.prepare('DELETE FROM p_sandbox_managed_worktrees WHERE project_id=?').run(row.project_id);
        if (row.kind === 'project' && !stores().projects.finishDeletion(Number(row.resource_id))) throw error('project_finalize_failed', 'Core Project deletion could not be finalized');
        row.state = 'deleted'; row.error = null; store.save(row);
        op.status = 'succeeded'; op.error = null; store.saveOperation(op);
      });
    }
  }

  async function reconcile() {
    if (!daemon || disposed || reconciling) return;
    reconciling = true;
    try {
      for (const op of store.operations()) {
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
          if (op.kind === 'image') {
            await siteImages.authorizeJob(op);
            const imageReference = await siteImages.provision(op.action.imageKind);
            checkpoint(op, { imageReference });
            op.status = 'succeeded'; op.error = null; store.saveOperation(op);
            continue;
          }
          const row = op.user_id === null ? await siteCleanup.rowForOperation(op) : await rowFor(op.kind, op.resource_id, op.user_id, true, true);
          const expected = op.checkpoint.switched ? op.checkpoint.newSpec.input.generation : op.generation;
          if (row.generation !== expected) throw error('generation_changed', 'Queued environment generation changed');
          store.log(row.kind, row.resource_id, `${op.action.kind} started (${op.id})`);
          await perform(row, op);
          op.status = 'succeeded'; op.error = null; store.saveOperation(op);
          store.log(row.kind, row.resource_id, `${op.action.kind} completed (${op.id})`);
        } catch (cause) {
          if (!claimed) throw cause;
          op.status = 'failed'; op.error = String(cause.message ?? cause).slice(0, 2000); store.saveOperation(op);
          const row = store.get(op.kind, op.resource_id);
          if (row) { row.error = op.error; if (row.desired_state === 'deleted') row.state = 'deleting'; else if (row.state !== 'running' && row.state !== 'stopped') row.state = 'failed'; store.save(row); store.log(row.kind, row.resource_id, op.error); }
        }
      }
      for (const row of store.all()) {
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
    return await manageWorktrees({ db, runGuest, row, userId: input.accountUserId, action: input.action });
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
        try { if (!lstatSync(socketPath).isSocket()) throw error('preview_socket_changed', 'Preview socket ownership changed'); unlinkSync(socketPath); }
        catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
        previews.delete(release);
      })().catch((cause) => { releasing = null; throw cause; });
      return releasing;
    };
    previews.add(release);
    try {
      if (Buffer.byteLength(socketPath) > 107) throw error('preview_path_limit', 'Preview socket path exceeds the operating-system limit');
      await podman.startPreview(spec, leased.execution_id, ['/usr/bin/python3', '-c', PREVIEW_HELPER, String(input.port), `/run/elowen/${name}`]);
      const deadline = Date.now() + 10000;
      for (;;) {
        try { if (lstatSync(socketPath).isSocket()) break; throw error('preview_socket_changed', 'Preview transport is not a socket'); }
        catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
        if (Date.now() >= deadline) throw error('preview_timeout', 'Preview transport did not become ready');
        await wait(50);
      }
      await handle.heartbeat();
      timer = setInterval(() => { handle.heartbeat().catch(() => release().catch((cause) => store.log(row.kind, row.resource_id, `Preview cleanup failed: ${cause.message}`))); }, 5000);
      timer.unref?.();
      return { projectId: id, generation: row.generation, port: input.port, socketPath, release };
    } catch (cause) { await release(); throw cause; }
  }

  const control = {
    discoverSiteSnapshotImage(input) { assertLive(); return siteImages.discoverSnapshot(input); },
    siteImageStatus(input) { assertLive(); return siteImages.status(input); },
    provisionSiteImage(input) { assertLive(); return siteImages.request(input); },
    requestSiteCleanup(input) { assertLive(); return siteCleanup.request(input); },
    projectPreviewBinding,
    async environmentFor(input) {
      const id = projectId(input.project);
      await authorize('project', id, input.accountUserId, true);
      const row = store.get('project', id);
      return row ? view(row) : { projectId: id, generation: 1, state: 'unprovisioned', desiredState: 'running', lastError: null, limits: { ...DEFAULT_LIMITS } };
    },
    async projectOverview(input) {
      const environment = await control.environmentFor(input);
      const id = projectId(input.project);
      const operations = db.prepare("SELECT id FROM p_sandbox_runtime_operations WHERE kind='project' AND resource_id=? ORDER BY rowid DESC").all(String(id))
        .map((item) => operationView(store.getOperation(item.id)));
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
    async discoverSiteEnvironment(input) {
      const registration = await authorize('site', input.siteId, input.accountUserId, true);
      const record = siteRecord(registration, 1);
      return await podman.discoverLegacySite(record.input, { namespace, sitesDataDir: registration.sitesDataDir, sourcePath: registration.sourcePath, brokerDir: registration.brokerDir });
    },
    async registerSiteEnvironment(input) {
      account(input.accountUserId, true);
      const registration = await authorize('site', input.siteId, input.accountUserId, true);
      positive(registration.projectId, 'source project');
      const effective = limits(registration.limits);
      const existing = store.get('site', input.siteId);
      if (existing && existing.state !== 'deleted') return view(await rowFor('site', input.siteId, input.accountUserId, true));
      if (stores().projects.get(registration.projectId)?.lifecycle === 'deleting') throw error('project_deleting', 'A deleting Project cannot acquire a new published Site');
      if (store.active('site', input.siteId)) throw error('site_busy', 'The previous Site lifecycle operation has not completed');
      const record = siteRecord(registration, existing ? existing.generation + 1 : 1);
      const actual = registration.legacy ? await podman.inspectBinding(specFor(record)) : null;
      const intent = registration.initialIntent;
      if (intent && (!['running', 'stopped'].includes(intent.desiredState) || ![null, 'start', 'stop', 'restart'].includes(intent.pendingAction)
        || (intent.restartSequence !== undefined && (!Number.isSafeInteger(intent.restartSequence) || intent.restartSequence < 0)))) throw error('invalid_handover_intent', 'Invalid legacy lifecycle checkpoint');
      return store.transaction(() => {
        const raced = store.get('site', input.siteId);
        if (raced && raced.state !== 'deleted') return view(raced);
        const row = raced ?? store.insert('site', input.siteId, registration.projectId, record, effective);
        row.spec = record; row.generation = record.input.generation; row.limits = effective; row.error = null;
        row.state = actual ? actual.state === 'running' ? 'running' : 'stopped' : 'unprovisioned';
        row.desired_state = intent?.desiredState ?? (actual ? row.state : 'running');
        const pending = intent?.pendingAction ?? (intent && ((row.desired_state === 'running' && row.state !== 'running') || (row.desired_state === 'stopped' && row.state === 'running')) ? row.desired_state === 'running' ? 'start' : 'stop' : null);
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
      const program = command({ type: 'shell', command: input.command });
      return await runGuest(row, input.accountUserId, program.argv, { input: program.input, workdir: guestPath(input.workdir ?? '/workspace'), timeoutMs: input.timeoutMs ?? 120000, signal: input.signal, kind: 'sites' });
    },
    siteEnvironmentLogs: (input) => logs('site', input.siteId, input.accountUserId, input.lines),
    siteEnvironmentSnapshots: (input) => snapshots('site', input.siteId, input.accountUserId),
  };
  return { ...control, control, prepareExecution, reconcile,
    async revokeAccount(userId) { for (const row of store.all()) await cancelLeases(row, userId); },
    async dispose() { disposed = true; for (const release of [...previews]) await release(); } };
}
