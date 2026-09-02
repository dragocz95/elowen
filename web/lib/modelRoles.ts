import type { BrainModelOption } from './types';

/** One instance-level model route as the daemon stores it: a provider id and a model id, BOTH of which
 *  must be set for the route to exist. */
export interface ModelRoute { providerId: string; model: string }

/** The pair encoding every role picker uses. `::` never appears in a provider id, and a model id may
 *  itself contain slashes — which is exactly why the pair is not joined with one. An empty key means
 *  "no explicit pick", which every inheritable role already stores as the empty pair. */
export const roleKey = (providerId: string, model: string): string => (providerId && model ? `${providerId}::${model}` : '');

export function splitRoleKey(key: string): ModelRoute {
  const at = key.indexOf('::');
  return at < 0 ? { providerId: '', model: '' } : { providerId: key.slice(0, at), model: key.slice(at + 2) };
}

/** THE RUNTIME'S RULE for the daily digest, mirrored once (`src/daemon/brainCore.ts` `dashDigestInference`):
 *
 *      dash.providerId && dash.model  →  the digest route
 *      cat.providerId  && cat.model   →  the utility route it inherits
 *      otherwise                      →  no route at all, the digest cannot run
 *
 *  BOTH halves decide. A half-set stored pair — `{providerId: '', model: 'x'}` from an older UI that wrote
 *  the two fields separately — is NOT a route, and reading `digest.model || categorization.model` reported
 *  `x` as the digest model while the daemon quietly ran the utility one. Every surface that states which
 *  model writes the digest reads this, so Recap and Models cannot disagree with each other or with the
 *  daemon. Saving through the single role picker writes both halves together, which is what retires the
 *  half-set state for good. */
export function resolveDigestRoute(
  digest: Partial<ModelRoute> | undefined,
  utility: Partial<ModelRoute> | undefined,
): { route: ModelRoute | null; inherited: boolean } {
  if (digest?.providerId && digest.model) return { route: { providerId: digest.providerId, model: digest.model }, inherited: false };
  if (utility?.providerId && utility.model) return { route: { providerId: utility.providerId, model: utility.model }, inherited: true };
  return { route: null, inherited: true };
}

/** Whether a stored provider/model pair is one the catalog still offers this caller.
 *
 *  An empty pair is not "missing" — it is the inherit sentinel, and every inheritable role stores it. A
 *  NON-empty pair the catalog does not list is a pin the runtime will not honour: the spawn chain skips a
 *  selection the allow-list refuses (`lifecycle.ts`), `resolveBrainModelRoute` throws for a provider that
 *  is gone, and `resolveCompactionFallback` discards a stale compaction pick. Showing it as the active
 *  model is the lie this predicate exists to prevent. */
export function isOfferedModel(key: string, catalog: BrainModelOption[]): boolean {
  if (!key) return true;
  return catalog.some((m) => roleKey(m.provider, m.model) === key);
}
