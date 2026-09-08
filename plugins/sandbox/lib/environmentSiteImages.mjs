import { resourceToken } from './containerSpec.mjs';

const error = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const IMAGE_KINDS = ['base', 'static', 'node'];
const REQUEST_ID = /^[a-zA-Z0-9_.:-]{1,160}$/;

/** Extracted fixed Sites image services. Every authority contact is a fresh injected callback:
 * recipes come only from the trusted Sites authority, actors are re-verified at request and at
 * dispatch, and the durable idempotency ledger lives in the existing environment operations store.
 * No Site, Project or container is ever invented here; the engine stays an injected driver. */
export function createSiteImageService({ podman, store, db, dataDir, recipe, account, userExists, isAdmin, authorizeSite, siteSpec, resolveSnapshotImage }) {
  for (const [key, value] of Object.entries({ podman, store, db, dataDir, recipe, account, userExists, isAdmin, authorizeSite, siteSpec, resolveSnapshotImage })) {
    if (!value) throw error('invalid_configuration', `A ${key} injection is required for the Sites image service`);
  }
  const operationView = (op) => ({ id: op.id, requestId: op.request_key, imageKind: op.resource_id, status: op.status, error: op.error ?? null });
  function recipeFor(kind) {
    if (!IMAGE_KINDS.includes(kind)) throw error('invalid_image_kind', 'Unknown fixed Sites image kind', 400);
    const resolved = recipe(kind);
    if (!resolved || typeof resolved.tag !== 'string') throw error('site_recipe_missing', 'Sites did not provide its fixed image recipes');
    return resolved;
  }
  function administrator(userId, internal = false) {
    if (!internal) account(userId, true);
    if (!userExists(userId) || !isAdmin(userId)) throw error('admin_required', 'Image provisioning requires a current administrator', 403);
  }

  return {
    /** Read-only and side-effect free: no provisioning, no enqueue, no Site row, valid before any Site exists. */
    async status(input) {
      const kind = input?.imageKind;
      const fixed = recipeFor(kind);
      const status = await podman.imageStatus(fixed.tag);
      const latest = db.prepare("SELECT id FROM p_sandbox_runtime_operations WHERE kind='image' AND resource_id=? ORDER BY rowid DESC LIMIT 1").get(kind);
      const op = latest ? store.getOperation(latest.id) : null;
      return { imageKind: kind, imageReference: fixed.tag, ...status, operation: op ? operationView(op) : null };
    },
    /** Requires a real current administrator; durably enqueues kind=image work for the fixed kind. */
    async request(input) {
      administrator(input.accountUserId);
      recipeFor(input.imageKind);
      if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId))) throw error('invalid_request_id', 'Invalid image provisioning request id', 400);
      return store.transaction(() => {
        const active = store.active('image', input.imageKind);
        const prior = input.requestId ? store.prior('image', input.imageKind, input.accountUserId, input.requestId) : null;
        if (prior) {
          if (prior.status === 'failed' && !active) { prior.status = 'pending'; prior.error = null; store.saveOperation(prior); }
          return operationView(prior);
        }
        if (active) return operationView(active);
        return operationView(store.enqueue({ kind: 'image', resource_id: input.imageKind, generation: 1 }, input.accountUserId, { kind: 'provision-image', imageKind: input.imageKind }, input.requestId));
      });
    },
    /** Daemon dispatch authority: the enqueued actor must still be a current administrator. */
    async authorizeJob(op) {
      if (op.kind !== 'image' || op.action?.kind !== 'provision-image' || op.resource_id !== op.action.imageKind || !IMAGE_KINDS.includes(op.action.imageKind)) {
        throw error('invalid_image_job', 'Invalid image provisioning job', 409);
      }
      administrator(op.user_id, true);
    },
    /** Builds only trusted fixed recipes; the base dependency is built first when required. */
    async provision(imageKind) {
      const fixed = recipeFor(imageKind);
      if (fixed.requiresBase) await podman.ensureSiteImage(dataDir, recipeFor('base'));
      return await podman.ensureSiteImage(dataDir, fixed);
    },
    /** Accepts only a reference the fresh Sites authority explicitly approved for this Site; the
     * engine then verifies io.elowen.site ownership and any retained immutable image pin. */
    async discoverSnapshot(input) {
      resourceToken(input.siteId);
      const registration = await authorizeSite(input.siteId, input.accountUserId);
      const approved = await resolveSnapshotImage(input);
      if (!approved || approved.imageReference !== input.imageReference) throw error('snapshot_image_forbidden', 'The image is not a retained release of this Site', 403);
      const imageId = await podman.discoverRetainedSiteImage(siteSpec(registration), input.imageReference);
      if (approved.imageId && approved.imageId.replace(/^sha256:/, '') !== imageId.replace(/^sha256:/, '')) throw error('snapshot_image_changed', 'The retained image identity changed');
      return { imageReference: input.imageReference, imageId };
    },
  };
}