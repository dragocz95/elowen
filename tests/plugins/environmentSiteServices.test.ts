import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import { createEnvironmentStore } from '../../plugins/sandbox/lib/environmentDb.mjs';
import { createSiteImageService } from '../../plugins/sandbox/lib/environmentSiteImages.mjs';
import { createSiteCleanupService } from '../../plugins/sandbox/lib/environmentSiteCleanup.mjs';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

const error = (code: string, message: string, status = 409) => Object.assign(new Error(message), { code, status });

function siteRecord(registration: any, generation: number) {
  const effective = { cpus: 1, memoryMb: 1024, pidsLimit: 512, ...registration.limits };
  return { registration, input: { resource: { kind: 'site', id: registration.siteId }, generation, image: registration.image, network: registration.network,
    workspaceReadOnly: registration.workspaceReadOnly, limits: { cpus: effective.cpus, memoryMb: effective.memoryMb, pidsLimit: effective.pidsLimit } },
  binding: { namespace: 'elowen', sitesDataDir: registration.sitesDataDir, sourcePath: registration.sourcePath, brokerDir: registration.brokerDir } };
}

function setup() {
  const sql = openDb(':memory:');
  const db = makePluginDb(sql, 'sandbox', { canMigrate: true });
  const users = new Set([1, 2, 3]);
  const admins = new Set([3]);
  const readOnly = { value: false };
  const ambient = { value: null as number | null };
  const stores = { usersRead: { list: () => [...users].map((id) => ({ id })), isAdmin: (id: number) => admins.has(id), mayUsePlugin: () => true } };
  const ctx: any = { db: () => db, host: { stores: () => stores }, currentAccountUserId: () => ambient.value, currentAccess: () => ({ readOnly: readOnly.value }) };
  initSandboxDb(ctx);
  const store = createEnvironmentStore(db, () => null);
  const beginDeletion = vi.fn(() => true);
  const account = (id: number, writable = false) => {
    if (!Number.isSafeInteger(id) || id <= 0) throw error('invalid_input', 'Invalid account', 400);
    if (ambient.value !== null && ambient.value !== id) throw error('actor_mismatch', 'The acting account does not match the current actor', 403);
    if (!users.has(id)) throw error('account_forbidden', 'Account access is unavailable', 403);
    if (writable && readOnly.value) throw error('read_only', 'A read-only turn cannot modify an environment', 403);
  };
  /** What the host holds, keyed by artifact reference. The store is the only thing a fixed Sites root
   *  filesystem needs now: the bytes are produced by the release pipeline, so there is nothing to build
   *  and no dependency between kinds to order. */
  const held = new Map<string, { digest: string; present: boolean }>();
  const artifacts = {
    status: vi.fn((reference: string) => {
      const entry = held.get(reference);
      return { reference, published: !!entry, present: entry?.present ?? false, digest: entry?.digest ?? null, sizeBytes: entry ? 1024 : null };
    }),
    ensure: vi.fn(async (reference: string) => {
      const entry = held.get(reference);
      if (!entry) throw error('artifact_unpublished', `no pinned copy of ${reference}`);
      entry.present = true;
      return { path: `/tmp/${reference}.tar.gz`, digest: entry.digest, sizeBytes: 1024, fetched: true };
    }),
    collect: vi.fn(() => []),
  };
  const publish = (reference: string) => {
    held.set(reference, { digest: `sha256:${createHash('sha256').update(reference).digest('hex')}`, present: false });
    return held.get(reference)!.digest;
  };
  const authority = {
    resolveSnapshotImage: vi.fn(async (_input: any): Promise<any> => null),
    resolveCleanup: vi.fn(async (_input: any): Promise<any> => null),
  };
  const registration = { siteId: 'demo', projectId: 7, image: 'site-base@1', sourcePath: '/tmp/env-site-services/sources/demo',
    sitesDataDir: '/tmp/env-site-services/sites', brokerDir: '/tmp/env-site-services/brokers/demo', workspaceReadOnly: false, network: 'shared',
    limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 } };
  const images = createSiteImageService({
    artifacts: artifacts as any, store, db,
    account, userExists: (id: number) => users.has(id), isAdmin: (id: number) => admins.has(id),
    authorizeSite: async () => registration,
    resolveSnapshotImage: (input: any) => authority.resolveSnapshotImage?.(input),
  });
  const cleanupService = createSiteCleanupService({
    store,
    resolveCleanup: (input: any) => authority.resolveCleanup?.(input),
    userExists: (id: number) => users.has(id),
    siteRecord, normalizeLimits: (value: any) => {
      if (!value || typeof value !== 'object' || Object.keys(value).some((key) => !['cpus', 'memoryMb', 'pidsLimit'].includes(key))) throw error('invalid_limits', 'Invalid environment limits', 400);
      return { cpus: 1, memoryMb: 1024, pidsLimit: 512, ...value };
    },
  });
  cleanup.push(() => sql.close());
  return { sql, db, store, artifacts, publish, held, images, cleanupService, authority, registration, users, admins, readOnly, ambient, beginDeletion };
}

describe('extracted fixed Sites image services', () => {
  it('bounds the fixed recipe enum on every entry point', async () => {
    const { images, artifacts } = setup();
    for (const bad of ['latest', 'web', 5, undefined, '']) {
      await expect(images.status({ imageKind: bad } as any)).rejects.toMatchObject({ code: 'invalid_image_kind', status: 400 });
      await expect(images.request({ imageKind: bad, accountUserId: 3 } as any)).rejects.toMatchObject({ code: 'invalid_image_kind', status: 400 });
    }
    expect(artifacts.status).not.toHaveBeenCalled();
  });

  it('reports status before any Site exists and never fetches', async () => {
    const { images, artifacts, publish, db } = setup();
    // Unpublished and absent are separate facts, and an operator acts on them differently: one is a
    // release that never shipped the artifact, the other is a download away.
    const unpublished = await images.status({ imageKind: 'node' });
    expect(unpublished).toEqual({ imageKind: 'node', imageReference: 'site-node@1', published: false,
      present: false, imageId: null, sizeBytes: null, operation: null });

    const digest = publish('site-node@1');
    expect(await images.status({ imageKind: 'node' })).toMatchObject({ published: true, present: false, imageId: digest, sizeBytes: 1024 });

    expect(artifacts.status).toHaveBeenCalledWith('site-node@1');
    expect(artifacts.ensure).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_runtime_operations').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_runtimes').get()).toMatchObject({ n: 0 });
  });

  it('surfaces the latest durable image operation in status', async () => {
    const { images } = setup();
    await images.request({ imageKind: 'static', accountUserId: 3, requestId: 'img-1' });
    const status = await images.status({ imageKind: 'static' });
    expect(status.operation).toMatchObject({ imageKind: 'static', requestId: 'img-1', status: 'pending', error: null });
  });

  it('requires a real current administrator and stays idempotent per request id', async () => {
    const { images, db, users, readOnly, ambient, admins } = setup();
    await expect(images.request({ imageKind: 'static', accountUserId: 1 })).rejects.toMatchObject({ code: 'admin_required', status: 403 });
    admins.delete(1);
    ambient.value = 3;
    await expect(images.request({ imageKind: 'static', accountUserId: 1 })).rejects.toMatchObject({ code: 'actor_mismatch', status: 403 });
    ambient.value = 1;
    await expect(images.request({ imageKind: 'static', accountUserId: 3 })).rejects.toMatchObject({ code: 'actor_mismatch', status: 403 });
    ambient.value = null;
    readOnly.value = true;
    await expect(images.request({ imageKind: 'static', accountUserId: 3 })).rejects.toMatchObject({ code: 'read_only', status: 403 });
    readOnly.value = false;
    await expect(images.request({ imageKind: 'static', accountUserId: 3, requestId: 'bad id!' })).rejects.toMatchObject({ code: 'invalid_request_id', status: 400 });
    const op = await images.request({ imageKind: 'static', accountUserId: 3, requestId: 'img-2' });
    expect(op).toMatchObject({ requestId: 'img-2', imageKind: 'static', status: 'pending' });
    expect(await images.request({ imageKind: 'static', accountUserId: 3, requestId: 'img-2' })).toEqual(op);
    expect(await images.request({ imageKind: 'static', accountUserId: 3, requestId: 'img-3' })).toEqual(op);
    expect(await images.request({ imageKind: 'static', accountUserId: 3 })).toEqual(op);
    admins.delete(3);
    await expect(images.request({ imageKind: 'static', accountUserId: 3, requestId: 'img-2' })).rejects.toMatchObject({ code: 'admin_required', status: 403 });
    users.delete(3);
    await expect(images.request({ imageKind: 'static', accountUserId: 3, requestId: 'img-2' })).rejects.toMatchObject({ code: 'account_forbidden', status: 403 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_runtime_operations').get()).toMatchObject({ n: 1 });
  });

  it('rechecks the administrator before dispatch and refuses provisioning without one', async () => {
    const { images, artifacts, store, admins, users } = setup();
    const op = await images.request({ imageKind: 'node', accountUserId: 3, requestId: 'img-3' });
    const job = { ...store.getOperation(op.id) } as any;
    admins.delete(3);
    await expect(images.authorizeJob(job)).rejects.toMatchObject({ code: 'admin_required', status: 403 });
    users.delete(3);
    await expect(images.authorizeJob(job)).rejects.toMatchObject({ code: 'admin_required', status: 403 });
    expect(artifacts.ensure).not.toHaveBeenCalled();
    await expect(images.authorizeJob({ kind: 'image', resource_id: 'node', action: { kind: 'start' } } as any)).rejects.toMatchObject({ code: 'invalid_image_job' });
  });

  it('fetches one complete root filesystem per kind, with no dependency between them', async () => {
    // The container recipes layered `static` and `node` on `base`, so provisioning one built two. An
    // artifact is a whole root filesystem, so each kind is exactly one fetch and the order is nobody's
    // business.
    const { images, artifacts, publish } = setup();
    const digest = publish('site-static@1');
    expect(await images.provision('static')).toEqual({ imageReference: 'site-static@1', imageId: digest });
    expect(artifacts.ensure).toHaveBeenCalledTimes(1);
    expect(artifacts.ensure).toHaveBeenCalledWith('site-static@1', {});

    // Convergent: a host that already holds the verified bytes is asked again and the store decides.
    expect(await images.provision('static')).toEqual({ imageReference: 'site-static@1', imageId: digest });

    // An artifact this release pins no copy of is refused by name, never built locally.
    await expect(images.provision('node')).rejects.toMatchObject({ code: 'artifact_unpublished' });
    await expect(images.provision('latest' as any)).rejects.toMatchObject({ code: 'invalid_image_kind', status: 400 });
  });

  it('rejects an unretained reference without ever consulting the store', async () => {
    const { images, artifacts, authority } = setup();
    authority.resolveSnapshotImage.mockResolvedValue(null);
    await expect(images.discoverSnapshot({ siteId: 'demo', accountUserId: 3, imageReference: 'site-base@1' }))
      .rejects.toMatchObject({ code: 'snapshot_image_forbidden', status: 403 });
    expect(artifacts.status).not.toHaveBeenCalled();
    authority.resolveSnapshotImage.mockResolvedValue({ imageReference: 'site-base@1', imageId: `sha256:${'a'.repeat(64)}` });
    await expect(images.discoverSnapshot({ siteId: 'demo', accountUserId: 3, imageReference: 'site-node@1' }))
      .rejects.toMatchObject({ code: 'snapshot_image_forbidden', status: 403 });
    expect(artifacts.status).not.toHaveBeenCalled();
  });

  it('holds a retained release to the digest it was published with', async () => {
    // A release is pinned by recipe revision and content digest instead of a container image id. The
    // digest is the stronger identity: it is derived from the bytes, where an image id was assigned by a
    // local store and another host would number the same content differently.
    const { images, authority, publish } = setup();
    const digest = publish('site-base@1');
    authority.resolveSnapshotImage.mockResolvedValue({ imageReference: 'site-base@1' });
    expect(await images.discoverSnapshot({ siteId: 'demo', accountUserId: 3, imageReference: 'site-base@1' }))
      .toEqual({ imageReference: 'site-base@1', imageId: digest });

    // An approval naming a digest this release does not pin is refused rather than resolved to whatever
    // is present, which is what keeps a pin a pin.
    authority.resolveSnapshotImage.mockResolvedValue({ imageReference: 'site-base@1', imageId: `sha256:${'d'.repeat(64)}` });
    await expect(images.discoverSnapshot({ siteId: 'demo', accountUserId: 3, imageReference: 'site-base@1' }))
      .rejects.toMatchObject({ code: 'snapshot_image_changed' });

    // And a reference this release pins no copy of is unavailable, not silently approved.
    authority.resolveSnapshotImage.mockResolvedValue({ imageReference: 'site-node@1' });
    await expect(images.discoverSnapshot({ siteId: 'demo', accountUserId: 3, imageReference: 'site-node@1' }))
      .rejects.toMatchObject({ code: 'snapshot_image_unavailable' });
  });
});

describe('extracted removed-account Site cleanup services', () => {
  it('requires the account to actually no longer exist and Sites to authorize the record', async () => {
    const { cleanupService, authority, registration, users } = setup();
    await expect(cleanupService.request({ siteId: 'demo', removedAccountUserId: 2 })).rejects.toMatchObject({ code: 'account_not_removed', status: 403 });
    users.delete(2);
    authority.resolveCleanup.mockResolvedValue(null);
    await expect(cleanupService.request({ siteId: 'demo', removedAccountUserId: 2 })).rejects.toMatchObject({ code: 'cleanup_forbidden', status: 403 });
    authority.resolveCleanup.mockResolvedValue({ ...registration, siteId: 'other' });
    await expect(cleanupService.request({ siteId: 'demo', removedAccountUserId: 2 })).rejects.toMatchObject({ code: 'cleanup_forbidden', status: 403 });
    await expect(cleanupService.request({ siteId: 'demo', removedAccountUserId: 0 })).rejects.toMatchObject({ code: 'invalid_input', status: 400 });
    await expect(cleanupService.request({ siteId: 'BAD_ID', removedAccountUserId: 2 })).rejects.toMatchObject({ message: /resource token/i });
  });

  it('establishes deletion intent with a NULL actor for a Site the runtime never registered', async () => {
    const { cleanupService, db, authority, users, registration } = setup();
    users.delete(2);
    authority.resolveCleanup.mockResolvedValue(registration);
    const op = await cleanupService.request({ siteId: 'demo', removedAccountUserId: 2 });
    expect(op).toMatchObject({ siteId: 'demo', accountUserId: null, action: { kind: 'delete' }, status: 'pending' });
    const row = db.prepare('SELECT * FROM p_sandbox_runtimes WHERE kind=? AND resource_id=?').get('site', 'demo') as any;
    expect(JSON.parse(row.spec_json).binding).toEqual({ namespace: 'elowen', sitesDataDir: '/tmp/env-site-services/sites', sourcePath: '/tmp/env-site-services/sources/demo', brokerDir: '/tmp/env-site-services/brokers/demo' });
    expect(row.project_id).toBe(7);
    expect(row.state).toBe('deleting');
    expect(row.desired_state).toBe('deleted');
    const opRow = db.prepare('SELECT * FROM p_sandbox_runtime_operations WHERE id=?').get(op.id) as any;
    expect(opRow.user_id).toBeNull();
    expect(opRow.request_key).toBe(`account-removed:2:${row.generation}`);
    expect(JSON.parse(opRow.checkpoint_json).lifecycle).toEqual({ removedAccountUserId: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_runtimes WHERE kind='project'").get()).toMatchObject({ n: 0 });
  });

  it('is idempotent under the deterministic NULL-actor key and fences an active operation', async () => {
    const { cleanupService, store, db, authority, users, registration } = setup();
    users.delete(2);
    authority.resolveCleanup.mockResolvedValue(registration);
    const prior = await cleanupService.request({ siteId: 'demo', removedAccountUserId: 2 });
    expect(await cleanupService.request({ siteId: 'demo', removedAccountUserId: 2 })).toEqual(prior);
    expect(db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=?').get('site', 'demo')).toMatchObject({ n: 1 });
    store.saveOperation({ ...store.getOperation(prior.id), status: 'failed', error: 'disk busy' });
    expect(await cleanupService.request({ siteId: 'demo', removedAccountUserId: 2 })).toMatchObject({ id: prior.id, status: 'pending', error: null });
    // A completed prior releases the fence; a different generation yields a different deterministic key.
    store.saveOperation({ ...store.getOperation(prior.id), status: 'succeeded', error: null });
    const row = store.get('site', 'demo');
    row.generation = 2;
    store.save(row);
    const next = await cleanupService.request({ siteId: 'demo', removedAccountUserId: 2 });
    expect(next.id).not.toBe(prior.id);
    expect(next.requestId).toBe('account-removed:2:2');
    expect(db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=?').get('site', 'demo')).toMatchObject({ n: 2 });
  });

  it('fences an active Site operation when no cleanup intent exists yet', async () => {
    const { cleanupService, store, db, authority, users, registration } = setup();
    users.delete(2);
    authority.resolveCleanup.mockResolvedValue(registration);
    store.insert('site', 'demo', 7, siteRecord(registration, 1), registration.limits);
    store.enqueue(store.get('site', 'demo'), 1, { kind: 'stop' }, 'manual-stop' as any);
    await expect(cleanupService.request({ siteId: 'demo', removedAccountUserId: 2 })).rejects.toMatchObject({ code: 'site_busy' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=?').get('site', 'demo')).toMatchObject({ n: 1 });
  });

  it('never touches the shared core Project or the removed creator authority', async () => {
    const { cleanupService, db, authority, users, registration, beginDeletion } = setup();
    users.delete(2);
    authority.resolveCleanup.mockResolvedValue(registration);
    const op = await cleanupService.request({ siteId: 'demo', removedAccountUserId: 2 });
    expect(op.accountUserId).toBeNull();
    expect(beginDeletion).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_runtimes WHERE kind='project'").get()).toMatchObject({ n: 0 });
    const opRow = db.prepare('SELECT * FROM p_sandbox_runtime_operations WHERE id=?').get(op.id) as any;
    expect(opRow.user_id).toBeNull();
    expect(JSON.parse(opRow.action_json)).toEqual({ kind: 'delete' });
  });

  it('rechecks cleanup authority and rejects wrong, drifted or missing bindings at dispatch', async () => {
    const { cleanupService, store, db, authority, users, registration } = setup();
    users.delete(2);
    authority.resolveCleanup.mockResolvedValue(registration);
    const op = await cleanupService.request({ siteId: 'demo', removedAccountUserId: 2 });
    const stored = store.getOperation(op.id);
    expect((await cleanupService.rowForOperation(stored)).resource_id).toBe('demo');
    expect(authority.resolveCleanup).toHaveBeenCalledWith({ siteId: 'demo', removedAccountUserId: 2 });
    await expect(cleanupService.rowForOperation({ ...stored, action: { kind: 'start' } } as any)).rejects.toMatchObject({ code: 'cleanup_forbidden' });
    await expect(cleanupService.rowForOperation({ ...stored, checkpoint: {} } as any)).rejects.toMatchObject({ code: 'cleanup_forbidden' });
    users.add(2);
    await expect(cleanupService.rowForOperation(stored)).rejects.toMatchObject({ code: 'account_not_removed', status: 403 });
    users.delete(2);
    authority.resolveCleanup.mockResolvedValue({ ...registration, sourcePath: '/tmp/env-site-services/sources/moved' });
    await expect(cleanupService.rowForOperation(stored)).rejects.toMatchObject({ code: 'cleanup_binding_changed' });
    authority.resolveCleanup.mockResolvedValue({ ...registration, projectId: 99 });
    await expect(cleanupService.rowForOperation(stored)).rejects.toMatchObject({ code: 'cleanup_binding_changed' });
    authority.resolveCleanup.mockResolvedValue(registration);
    store.transaction(() => { db.prepare('DELETE FROM p_sandbox_runtimes WHERE kind=? AND resource_id=?').run('site', 'demo'); });
    await expect(cleanupService.rowForOperation(stored)).rejects.toMatchObject({ code: 'cleanup_binding_missing' });
  });

  it('rejects another removed account the authority does not bind to this Site', async () => {
    const { cleanupService, authority, users } = setup();
    users.delete(5);
    authority.resolveCleanup.mockResolvedValue(null);
    await expect(cleanupService.request({ siteId: 'demo', removedAccountUserId: 5 })).rejects.toMatchObject({ code: 'cleanup_forbidden', status: 403 });
  });
});