import { clientOrigin } from '../clientIp.js';
import type { ElowenContext, RouteContext } from '../context.js';

export type BrainService = NonNullable<RouteContext['d']['brain']>;

export interface BrainRouteContext {
  d: RouteContext['d'];
  forbidden: (c: { get: (k: 'tokenScope') => string }) => boolean;
  /** The API-wide setup-tolerant admin gate, passed through so a brain route uses the SAME predicate as
   *  every other route instead of re-deriving one from `d.users.count()` and `user.is_admin` by hand. */
  notAdminUnlessSetup: RouteContext['notAdminUnlessSetup'];
  pinOrigin: (c: ElowenContext, sessionId: string) => void;
  withBrain: (
    handler: (c: ElowenContext, brain: BrainService) => Response | Promise<Response>,
    opts?: { admin?: boolean },
  ) => (c: ElowenContext) => Promise<Response>;
}

export function createBrainRouteContext(ctx: RouteContext): BrainRouteContext {
  const { d } = ctx;
  const forbidden = (c: { get: (k: 'tokenScope') => string }): boolean => c.get('tokenScope') === 'agent';

  /** Pin this request's origin to the conversation whose turn it is about to start, so the spend of that
   *  turn is attributed to the address that ORDERED it — read now, at request time, not at settle, when
   *  the requester may be gone or on another network. Called on the turn-STARTING routes only; a read
   *  route has nothing to attribute. Silent no-op where the store is unwired (minimal test wiring). */
  const pinOrigin = (c: ElowenContext, sessionId: string): void => {
    d.usageOrigins?.recordRequest(
      sessionId, c.get('user').id,
      clientOrigin(c, d.config.get().security.trustProxy), d.clock.now(),
    );
  };

  /** The prologue almost every brain route shares: 503 when the engine isn't wired, 403 for an agent-scope
   *  token (a spawned agent must never drive a human's brain), and — with `{ admin: true }` — 403 for a
   *  non-admin. Wrapping it hands the handler a guaranteed-present `brain`, so the guard is the DEFAULT a new
   *  route can't forget rather than a two-line prologue copy-pasted (and occasionally mis-ordered) per handler.
   *  Routes whose unavailable response is a benign default (`status`/`sessions`/`rate-limits` → {} / [] / null)
   *  and the SSE stream keep their bespoke guard — this covers only the uniform `503 + forbidden` shape. */
  const withBrain = (
    handler: (c: ElowenContext, brain: BrainService) => Response | Promise<Response>,
    opts?: { admin?: boolean },
  ) => async (c: ElowenContext): Promise<Response> => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c) || (opts?.admin === true && !c.get('user')?.is_admin)) return c.json({ error: 'forbidden' }, 403);
    return handler(c, d.brain);
  };

  return { d, forbidden, pinOrigin, withBrain, notAdminUnlessSetup: ctx.notAdminUnlessSetup };
}

/** Opt-in backwards pagination for the message history (the chat's lazy-load): undefined when `?limit` is
 *  absent so the caller keeps the historical full bare-array response (the CLI + read-only view rely on
 *  that). `limit` is clamped to a sane window; `before` is the exclusive upper-bound cursor a previous page
 *  returned as `nextBefore` (absent → the newest turns). */
export function messagePageOpts(rawLimit?: string, rawBefore?: string): { limit: number; before?: number } | undefined {
  if (rawLimit === undefined) return undefined;
  const limit = Number(rawLimit);
  if (!Number.isFinite(limit) || limit <= 0) return undefined; // garbage limit → the historical bare array
  const opts: { limit: number; before?: number } = { limit: Math.min(Math.floor(limit), 200) };
  if (rawBefore !== undefined) {
    const before = Number(rawBefore);
    if (Number.isFinite(before) && before >= 0) opts.before = Math.floor(before);
  }
  return opts;
}
