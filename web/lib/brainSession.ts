'use client';
/** Web mirror of the CLI's session binding (src/cli/chat/brainClient.ts). The dock/chat controller binds
 *  itself to ONE conversation exactly like a CLI process: a stable per-tab client identity, a monotonic
 *  generation bumped on every (re)connect / session switch, and the bound session id threaded through
 *  every session-scoped brain call. That lets a second tab (or the CLI) work another conversation without
 *  interleaving into this one, and lets the daemon fence a network-reordered older selection. */

/** The stable client identity for THIS document load. Generated once in memory and kept for the life of
 *  the page — reconnects within the page reuse it, a second tab gets its own, and a RELOAD deliberately
 *  starts fresh. This mirrors "one CLI process = one clientId": a reload is a new process, so it must not
 *  reuse an id whose generation counter has reset (the daemon fences a known client whose generation did
 *  not advance — persisting the id across reloads while resetting generation makes start() 409 "no longer
 *  current"). The generation counter lives in the controller and always begins at 1 for this fresh id. */
let cachedClientId: string | null = null;
export function getBrainClientId(): string {
  if (typeof window === 'undefined') return '';
  if (!cachedClientId) cachedClientId = crypto.randomUUID();
  return cachedClientId;
}

/** The conditional binding threaded onto session-scoped brain calls. Mirrors BrainClient's shape exactly:
 *  client+generation ride only once the session is bound AND its generation committed; the bare session
 *  before that; nothing before the first start(). */
export interface BrainBinding { session?: string; client?: string; generation?: number }

/** Build the binding from the controller's bound state, mirroring BrainClient (brainClient.ts :192-194). */
export function buildBinding(
  boundSession: string | undefined,
  boundGeneration: number | undefined,
  clientId: string,
): BrainBinding {
  if (boundSession && boundGeneration !== undefined) return { session: boundSession, client: clientId, generation: boundGeneration };
  if (boundSession) return { session: boundSession };
  return {};
}
