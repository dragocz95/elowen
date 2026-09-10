import { resourceToken } from './containerSpec.mjs';
import { operationView } from './environmentDb.mjs';

const error = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

function positive(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw error('invalid_input', `Invalid ${label}`, 400);
  return value;
}

/** Extracted removed-account Site cleanup services. Deletion intent is established only after the
 * fresh Sites authority positively authorizes it for an account that provably no longer exists and
 * whose authoritative retained Site record still names it as creator. Operations are always enqueued
 * with a NULL actor (no fabricated user), under one deterministic key per generation, fenced against
 * any active Site operation. This service never deletes or marks a shared core Project and never
 * performs container/volume deletion itself: the parent retains lifecycle and restore decisions. */
export function createSiteCleanupService({ store, resolveCleanup, userExists, siteRecord, normalizeLimits }) {
  for (const [key, value] of Object.entries({ store, resolveCleanup, userExists, siteRecord, normalizeLimits })) {
    if (!value) throw error('invalid_configuration', `A ${key} injection is required for the Sites cleanup service`);
  }
  async function registration(siteId, removedAccountUserId) {
    positive(removedAccountUserId, 'removed account');
    resourceToken(siteId);
    if (userExists(removedAccountUserId)) throw error('account_not_removed', 'Account-removal authority requires an actually removed account', 403);
    const resolved = await resolveCleanup({ siteId, removedAccountUserId });
    if (!resolved || resolved.siteId !== siteId) throw error('cleanup_forbidden', 'Sites did not authorize this removed-account cleanup', 403);
    return resolved;
  }

  return {
    registration,
    /** Idempotent host lifecycle intent for an account that Sites proved removed and that still owns
     * the authoritative retained Site record. */
    async request(input) {
      const resolved = await registration(input.siteId, input.removedAccountUserId);
      let row = store.get('site', input.siteId);
      if (!row) row = store.insert('site', input.siteId, resolved.projectId, siteRecord(resolved, 1), normalizeLimits(resolved.limits));
      const key = `account-removed:${input.removedAccountUserId}:${row.generation}`;
      return store.transaction(() => {
        const prior = store.prior('site', input.siteId, null, key);
        const active = store.active('site', input.siteId);
        if (prior) {
          if (prior.status === 'failed' && !active) { prior.status = 'pending'; prior.error = null; store.saveOperation(prior); }
          return operationView(prior);
        }
        if (active) throw error('site_busy', 'Finish the active Site operation before lifecycle cleanup');
        const op = store.enqueue(row, null, { kind: 'delete' }, key);
        Object.assign(op.checkpoint, { lifecycle: { removedAccountUserId: input.removedAccountUserId } });
        store.saveOperation(op);
        row.state = 'deleting'; row.desired_state = 'deleted'; store.save(row);
        return operationView(op);
      });
    },
    /** Dispatch-time authority recheck: cleanup intent, removed account, and the trusted binding
     * (site, project, source) must all still match before any lifecycle work runs. */
    async rowForOperation(op) {
      if (op.action.kind !== 'delete' || !op.checkpoint.lifecycle) throw error('cleanup_forbidden', 'Invalid host lifecycle intent');
      const resolved = await registration(op.resource_id, op.checkpoint.lifecycle.removedAccountUserId);
      const row = store.get('site', op.resource_id);
      if (!row) throw error('cleanup_binding_missing', 'The cleanup binding is missing');
      for (const key of ['siteId', 'projectId', 'sourcePath', 'sitesDataDir', 'brokerDir']) if (resolved[key] !== row.spec.registration[key]) throw error('cleanup_binding_changed', 'The Site changed ownership or source binding before cleanup');
      return row;
    },
  };
}