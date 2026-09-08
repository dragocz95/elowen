import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import { createEnvironmentStore } from '../../plugins/sandbox/lib/environmentDb.mjs';
import { createBoundSiteSpec } from '../../plugins/sandbox/lib/containerSpec.mjs';
import { createSiteImageService } from '../../plugins/sandbox/lib/environmentSiteImages.mjs';
import { createSiteCleanupService } from '../../plugins/sandbox/lib/environmentSiteCleanup.mjs';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

const error = (code: string, message: string, status = 409) => Object.assign(new Error(message), { code, status });

function siteRecord(registration: any, generation: number) {
  const effective = { cpus: 1, memoryMb: 1024, pidsLimit: 512, diskSoftMb: 10240, ...registration.limits };
  return { registration, input: { resource: { kind: 'site', id: registration.siteId }, generation, image: registration.image, network: registration.network,
    workspaceReadOnly: registration.workspaceReadOnly, limits: { cpus: effective.cpus, memoryMb: effective.memoryMb, pidsLimit: effective.pidsLimit } },
  binding: { namespace: 'elowen', sitesDataDir: registration.sitesDataDir, sourcePath: registration.sourcePath, brokerDir: registration.brokerDir, ...(registration.legacy ? { legacy: registration.legacy } : {}) } };
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
  const siteImages = new Map<string, { id: string; site: string }>();
  const podman = {
    imageStatus: vi.fn(async (reference: string) => siteImages.has(reference) ? { present: true, imageId: siteImages.get(reference)!.id } : { present: false, imageId: null }),
    ensureSiteImage: vi.fn(async (_dataDir: string, recipe: any) => {
      const id = `sha256:${createHash('sha256').update(recipe.tag).digest('hex')}`;
      siteImages.set(recipe.tag, { id, site: '' });
      return recipe.tag;
    }),
    discoverRetainedSiteImage: vi.fn(async (spec: any, reference: string) => {
      const owned = siteImages.get(reference);
      if (!owned || owned.site !== spec.resource.id) throw error('retained_ownership', 'Retained Sites image ownership mismatch');
      return owned.id;
    }),
    discoverLegacySite: vi.fn(async (): Promise<any> => null),
  };
  const recipes: Record<string, any> = {
    base: { tag: 'localhost/elowen-sites-base:fixed', files: { Containerfile: 'FROM scratch\n' } },
    static: { tag: 'localhost/elowen-sites-static:fixed', files: { Containerfile: 'FROM base\n' }, requiresBase: true },
    node: { tag: 'localhost/elowen-sites-node:fixed', files: { Containerfile: 'FROM static\n' }, requiresBase: true },
  };
  const authority = {
    imageRecipe: (kind: string) => recipes[kind],
    resolveSnapshotImage: vi.fn(async (_input: any): Promise<any> => null),
    resolveCleanup: vi.fn(async (_input: any): Promise<any> => null),
  };
  const registration = { siteId: 'demo', projectId: 7, image: 'localhost/elowen/site:fixed', sourcePath: '/tmp/env-site-services/sources/demo',
    sitesDataDir: '/tmp/env-site-services/sites', brokerDir: '/tmp/env-site-services/brokers/demo', workspaceReadOnly: false, network: 'shared',
    limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512, diskSoftMb: 10240 } };
  const images = createSiteImageService({
    podman: podman as any, store, db, dataDir: '/tmp/env-site-services',
    recipe: (kind: string) => authority.imageRecipe?.(kind),
    account, userExists: (id: number) => users.has(id), isAdmin: (id: number) => admins.has(id),
    authorizeSite: async () => registration,
    siteSpec: (value: any) => createBoundSiteSpec(siteRecord(value, 1).input, siteRecord(value, 1).binding),
    resolveSnapshotImage: (input: any) => authority.resolveSnapshotImage?.(input),
  });
  const cleanupService = createSiteCleanupService({
    podman: podman as any, store, namespace: 'elowen',
    resolveCleanup: (input: any) => authority.resolveCleanup?.(input),
    userExists: (id: number) => users.has(id),
    siteRecord, normalizeLimits: (value: any) => {
      if (!value || typeof value !== 'object' || Object.keys(value).some((key) => !['cpus', 'memoryMb', 'pidsLimit', 'diskSoftMb'].includes(key))) throw error('invalid_limits', 'Invalid environment limits', 400);
      return { cpus: 1, memoryMb: 1024, pidsLimit: 512, diskSoftMb: 10240, ...value };
    },
  });
  cleanup.push(() => sql.close());
  return { sql, db, store, podman, images, cleanupService, authority, registration, users, admins, readOnly, ambient, siteImages, beginDeletion };
}

describe('extracted fixed Sites image services', () => {
  it('bounds the fixed recipe enum on every entry point', async () => {
    const { images, podman } = setup();
    for (const bad of ['latest', 'web', 5, undefined, '']) {
      await expect(images.status({ imageKind: bad } as any)).rejects.toMatchObject({ code: 'invalid_image_kind', status: 400 });
      await expect(images.request({ imageKind: bad, accountUserId: 3 } as any)).rejects.toMatchObject({ code: 'invalid_image_kind', status: 400 });
    }
    expect(podman.imageStatus).not.toHaveBeenCalled();
  });

  it('reports status before any Site exists and never provisions', async () => {
    const { images, podman, db } = setup();
    const status = await images.status({ imageKind: 'node' });
    expect(status).toEqual({ imageKind: 'node', imageReference: 'localhost/elowen-sites-node:fixed', present: false, imageId: null, operation: null });
    expect(podman.imageStatus).toHaveBeenCalledWith('localhost/elowen-sites-node:fixed');
    expect(podman.ensureSiteImage).not.toHaveBeenCalled();
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
    const { images, podman, store, admins, users } = setup();
    const op = await images.request({ imageKind: 'node', accountUserId: 3, requestId: 'img-3' });
    const job = { ...store.getOperation(op.id) } as any;
    admins.delete(3);
    await expect(images.authorizeJob(job)).rejects.toMatchObject({ code: 'admin_required', status: 403 });
    users.delete(3);
    await expect(images.authorizeJob(job)).rejects.toMatchObject({ code: 'admin_required', status: 403 });
    expect(podman.ensureSiteImage).not.toHaveBeenCalled();
    await expect(images.authorizeJob({ kind: 'image', resource_id: 'node', action: { kind: 'start' } } as any)).rejects.toMatchObject({ code: 'invalid_image_job' });
  });

  it('builds the base dependency first when the fixed recipe requires it', async () => {
    const { images, podman } = setup();
    expect(await images.provision('static')).toBe('localhost/elowen-sites-static:fixed');
    expect(podman.ensureSiteImage).toHaveBeenCalledTimes(2);
    expect(podman.ensureSiteImage.mock.calls[0][1].tag).toBe('localhost/elowen-sites-base:fixed');
    expect(podman.ensureSiteImage.mock.calls[1][1].tag).toBe('localhost/elowen-sites-static:fixed');
    podman.ensureSiteImage.mockClear();
    expect(await images.provision('base')).toBe('localhost/elowen-sites-base:fixed');
    expect(podman.ensureSiteImage).toHaveBeenCalledTimes(1);
    await expect(images.provision('latest' as any)).rejects.toMatchObject({ code: 'invalid_image_kind', status: 400 });
  });

  it('rejects an unretained reference without ever calling the engine', async () => {
    const { images, podman, authority } = setup();
    authority.resolveSnapshotImage.mockResolvedValue(null);
    await expect(images.discoverSnapshot({ siteId: 'demo', accountUserId: 3, imageReference: 'localhost/other:evil' }))
      .rejects.toMatchObject({ code: 'snapshot_image_forbidden', status: 403 });
    expect(podman.discoverRetainedSiteImage).not.toHaveBeenCalled();
    authority.resolveSnapshotImage.mockResolvedValue({ imageReference: 'localhost/approved:1', imageId: `sha256:${'a'.repeat(64)}` });
    await expect(images.discoverSnapshot({ siteId: 'demo', accountUserId: 3, imageReference: 'localhost/unapproved:1' }))
      .rejects.toMatchObject({ code: 'snapshot_image_forbidden', status: 403 });
    expect(podman.discoverRetainedSiteImage).not.toHaveBeenCalled();
  });

  it('verifies engine ownership and a retained immutable pin for an approved reference', async () => {
    const { images, podman, authority, siteImages } = setup();
    const imageId = `sha256:${'b'.repeat(64)}`;
    siteImages.set('localhost/elowen/site-release:demo', { id: imageId, site: 'demo' });
    siteImages.set('localhost/foreign:1', { id: `sha256:${'c'.repeat(64)}`, site: 'other' });
    authority.resolveSnapshotImage.mockResolvedValue({ imageReference: 'localhost/elowen/site-release:demo' });
    expect(await images.discoverSnapshot({ siteId: 'demo', accountUserId: 3, imageReference: 'localhost/elowen/site-release:demo' }))
      .toEqual({ imageReference: 'localhost/elowen/site-release:demo', imageId });
    const spec = podman.discoverRetainedSiteImage.mock.calls[0][0];
    expect(spec.resource).toEqual({ kind: 'site', id: 'demo' });
    expect(spec.labels['io.elowen.site']).toBe('demo');
    authority.resolveSnapshotImage.mockResolvedValue({ imageReference: 'localhost/foreign:1' });
    await expect(images.discoverSnapshot({ siteId: 'demo', accountUserId: 3, imageReference: 'localhost/foreign:1' }))
      .rejects.toMatchObject({ code: 'retained_ownership', message: /ownership/i });
    authority.resolveSnapshotImage.mockResolvedValue({ imageReference: 'localhost/elowen/site-release:demo', imageId: `sha256:${'d'.repeat(64)}` });
    await expect(images.discoverSnapshot({ siteId: 'demo', accountUserId: 3, imageReference: 'localhost/elowen/site-release:demo' }))
      .rejects.toMatchObject({ code: 'snapshot_image_changed' });
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

  it('establishes deletion intent with a NULL actor from verified legacy adoption metadata', async () => {
    const { cleanupService, podman, db, authority, users, registration } = setup();
    users.delete(2);
    authority.resolveCleanup.mockResolvedValue(registration);
    podman.discoverLegacySite.mockResolvedValue({ containerId: 'c'.repeat(64), imageId: `sha256:${'e'.repeat(64)}`, volumeMountpoint: '/tmp/env-site-services/volumes/demo', state: 'stopped' });
    const op = await cleanupService.request({ siteId: 'demo', removedAccountUserId: 2 });
    expect(podman.discoverLegacySite).toHaveBeenCalledWith(expect.objectContaining({ resource: { kind: 'site', id: 'demo' } }),
      { namespace: 'elowen', sitesDataDir: '/tmp/env-site-services/sites', sourcePath: '/tmp/env-site-services/sources/demo', brokerDir: '/tmp/env-site-services/brokers/demo' });
    expect(op).toMatchObject({ siteId: 'demo', accountUserId: null, action: { kind: 'delete' }, status: 'pending' });
    const row = db.prepare('SELECT * FROM p_sandbox_runtimes WHERE kind=? AND resource_id=?').get('site', 'demo') as any;
    expect(JSON.parse(row.spec_json).binding.legacy).toMatchObject({ containerId: 'c'.repeat(64) });
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