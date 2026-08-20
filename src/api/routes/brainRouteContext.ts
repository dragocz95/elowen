import { clientOrigin } from '../clientIp.js';
import type { ElowenContext, RouteContext } from '../context.js';

export type BrainService = NonNullable<RouteContext['d']['brain']>;

export interface BrainRouteContext {
  d: RouteContext['d'];
  forbidden: (c: { get: (k: 'tokenScope') => string }) => boolean;
  pinOrigin: (c: ElowenContext, sessionId: string) => void;
  withBrain: (
    handler: (c: ElowenContext, brain: BrainService) => Response | Promise<Response>,
    opts?: { admin?: boolean },
  ) => (c: ElowenContext) => Promise<Response>;
}

export function createBrainRouteContext(ctx: RouteContext): BrainRouteContext {
  const { d } = ctx;
  const forbidden = (c: { get: (k: 'tokenScope') => string }): boolean => c.get('tokenScope') === 'agent';

  const pinOrigin = (c: ElowenContext, sessionId: string): void => {
    d.usageOrigins?.recordRequest(
      sessionId, c.get('user').id,
      clientOrigin(c, d.config.get().security.trustProxy), d.clock.now(),
    );
  };

  const withBrain = (
    handler: (c: ElowenContext, brain: BrainService) => Response | Promise<Response>,
    opts?: { admin?: boolean },
  ) => async (c: ElowenContext): Promise<Response> => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c) || (opts?.admin === true && !c.get('user')?.is_admin)) return c.json({ error: 'forbidden' }, 403);
    return handler(c, d.brain);
  };

  return { d, forbidden, pinOrigin, withBrain };
}

export function messagePageOpts(rawLimit?: string, rawBefore?: string): { limit: number; before?: number } | undefined {
  if (rawLimit === undefined) return undefined;
  const limit = Number(rawLimit);
  if (!Number.isFinite(limit) || limit <= 0) return undefined;
  const opts: { limit: number; before?: number } = { limit: Math.min(Math.floor(limit), 200) };
  if (rawBefore !== undefined) {
    const before = Number(rawBefore);
    if (Number.isFinite(before) && before >= 0) opts.before = Math.floor(before);
  }
  return opts;
}
