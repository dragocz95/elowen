import { resourceToken } from './containerSpec.mjs';
import { isRequestId } from './environmentDb.mjs';
import { SITE_ARTIFACTS, artifactReference } from './rootfsCatalog.mjs';

const error = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const IMAGE_KINDS = Object.keys(SITE_ARTIFACTS);

/** The fixed Sites root filesystems, as this host holds them.
 *
 *  This used to build container images. It now makes sure the published artifact for a fixed recipe is
 *  downloaded and verified, which is the same job with the build taken out of it: the bytes are produced
 *  once by the release pipeline, and a host either already has them or fetches them.
 *
 *  Which artifact a kind means is this runtime's to know, because this runtime is what unpacks it, so the
 *  mapping lives in the catalogue rather than arriving from the Sites authority. What Sites still owns is
 *  which kind a Site runs on and which releases it has retained.
 *
 *  A Site release is pinned by the artifact's reference and digest — the recipe revision and the exact
 *  bytes — where it used to be pinned by a container image id. Both are immutable identities of the same
 *  thing; the digest is the stronger one, because it is derived from the content rather than assigned by
 *  a local image store that another host would number differently.
 *
 *  Every authority contact is a fresh injected callback: actors are re-verified at request and at
 *  dispatch, and the durable idempotency ledger lives in the existing environment operations store. No
 *  Site, Project or environment is ever invented here; the engine stays an injected driver. */
export function createSiteImageService({ artifacts, store, db, account, userExists, isAdmin, authorizeSite, resolveSnapshotImage }) {
  for (const [key, value] of Object.entries({ artifacts, store, db, account, userExists, isAdmin, authorizeSite, resolveSnapshotImage })) {
    if (!value) throw error('invalid_configuration', `A ${key} injection is required for the Sites image service`);
  }
  const operationView = (op) => ({ id: op.id, requestId: op.request_key, imageKind: op.resource_id, status: op.status, error: op.error ?? null });
  function referenceFor(kind) {
    if (!IMAGE_KINDS.includes(kind)) throw error('invalid_image_kind', 'Unknown fixed Sites root filesystem kind', 400);
    return artifactReference(SITE_ARTIFACTS[kind]);
  }
  function administrator(userId, internal = false) {
    if (!internal) account(userId, true);
    if (!userExists(userId) || !isAdmin(userId)) throw error('admin_required', 'Root filesystem provisioning requires a current administrator', 403);
  }

  return {
    /** Read-only and side-effect free: no download, no enqueue, no Site row, valid before any Site
     *  exists. `present` is whether this host holds the bytes; `published` is whether this release pinned
     *  any. They are separate facts and an operator acts on them differently — one is a download away,
     *  the other is a release that has not shipped the artifact at all. */
    async status(input) {
      const kind = input?.imageKind;
      const reference = referenceFor(kind);
      const state = artifacts.status(reference);
      const latest = db.prepare("SELECT id FROM p_sandbox_runtime_operations WHERE kind='image' AND resource_id=? ORDER BY rowid DESC LIMIT 1").get(kind);
      const op = latest ? store.getOperation(latest.id) : null;
      return { imageKind: kind, imageReference: reference, imageId: state.digest, present: state.present,
        published: state.published, sizeBytes: state.sizeBytes, operation: op ? operationView(op) : null };
    },
    /** Requires a real current administrator; durably enqueues kind=image work for the fixed kind. */
    async request(input) {
      administrator(input.accountUserId);
      referenceFor(input.imageKind);
      if (input.requestId !== undefined && !isRequestId(input.requestId)) throw error('invalid_request_id', 'Invalid provisioning request id', 400);
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
        throw error('invalid_image_job', 'Invalid root filesystem provisioning job', 409);
      }
      administrator(op.user_id, true);
    },
    /** Fetch and verify the artifact for a fixed kind. Convergent: a host that already holds the verified
     *  bytes does nothing. There is no dependency between kinds any more — each artifact is a complete
     *  root filesystem rather than a layer, so `base` is not built first and stacked on. */
    async provision(imageKind, onProgress) {
      const reference = referenceFor(imageKind);
      const result = await artifacts.ensure(reference, onProgress ? { onProgress } : {});
      return { imageReference: reference, imageId: result.digest };
    },
    /** Accepts only a reference the fresh Sites authority explicitly approved for this Site, and then
     *  holds the retained release to the digest it was published with. An approval naming a digest this
     *  release does not pin is refused rather than resolved to whatever happens to be present. */
    async discoverSnapshot(input) {
      resourceToken(input.siteId);
      await authorizeSite(input.siteId, input.accountUserId);
      const approved = await resolveSnapshotImage(input);
      if (!approved || approved.imageReference !== input.imageReference) throw error('snapshot_image_forbidden', 'The root filesystem is not a retained release of this Site', 403);
      const state = artifacts.status(input.imageReference);
      if (!state.published) throw error('snapshot_image_unavailable', `This release pins no copy of ${input.imageReference}`);
      if (approved.imageId && approved.imageId !== state.digest) throw error('snapshot_image_changed', 'The retained root filesystem digest changed');
      return { imageReference: input.imageReference, imageId: state.digest };
    },
  };
}
