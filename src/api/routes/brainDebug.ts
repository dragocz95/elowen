import type { ElowenApp, ElowenContext } from '../context.js';
import type { BrainRouteContext } from './brainRouteContext.js';

const debugNumber = (raw?: string): number | undefined => {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : undefined;
};

const debugDate = (raw: string | undefined, endOfDay = false): string | undefined => {
  if (raw === undefined) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const date = new Date(dateOnly ? `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : raw);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid debug filter');
  return date.toISOString().replace('T', ' ').slice(0, 19);
};

const debugEnum = <T extends string>(raw: string | undefined, values: readonly T[]): T | undefined => {
  if (raw === undefined) return undefined;
  if ((values as readonly string[]).includes(raw)) return raw as T;
  throw new Error('invalid debug filter');
};

const debugError = (c: ElowenContext, error: unknown): Response => {
  const message = (error as Error).message;
  if (message === 'invalid debug cursor' || message === 'invalid debug filter') return c.json({ error: message }, 400);
  const bytes = /^debug payload exceeds byte limit:(\d+)$/.exec(message)?.[1];
  if (bytes) return c.json({ error: 'payload exceeds byte limit', requiredBytes: Number(bytes) }, 413);
  throw error;
};

export function registerBrainDebugRoutes(app: ElowenApp, route: BrainRouteContext): void {
  const { d } = route;

  // Raw model prompts may contain private user/tool data. Every response in this namespace — including
  // auth failures and 404s — is private and non-cacheable.
  app.use('/brain/debug/*', async (c, next) => {
    if (!c.get('user')?.is_admin) {
      const response = c.json({ error: 'forbidden' }, 403);
      response.headers.set('Cache-Control', 'private, no-store');
      return response;
    }
    await next();
    c.res.headers.set('Cache-Control', 'private, no-store');
  });

  app.get('/brain/debug/sessions', c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    try {
      return c.json(d.brain.debugSessions({
        cursor: c.req.query('cursor'), limit: debugNumber(c.req.query('limit')), search: c.req.query('search'),
        from: debugDate(c.req.query('from')), to: debugDate(c.req.query('to'), true), userId: debugNumber(c.req.query('userId')),
        surface: debugEnum(c.req.query('surface'), ['conversation', 'channel', 'subagent'] as const),
        provider: c.req.query('provider'), model: c.req.query('model'),
        status: debugEnum(c.req.query('status'), ['pending', 'succeeded', 'error', 'interrupted', 'captured', 'legacy'] as const),
      }));
    } catch (error) { return debugError(c, error); }
  });

  app.get('/brain/debug/sessions/:id', c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    const item = d.brain.debugSession(c.req.param('id'));
    return item ? c.json(item) : c.json({ error: 'not found' }, 404);
  });

  app.get('/brain/debug/sessions/:id/requests', c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    try {
      const page = d.brain.debugRequests(c.req.param('id'), {
        cursor: c.req.query('cursor'), limit: debugNumber(c.req.query('limit')), search: c.req.query('search'),
        kind: debugEnum(c.req.query('kind'), ['chat', 'compaction', 'remote_compaction'] as const),
        provider: c.req.query('provider'), model: c.req.query('model'),
        status: debugEnum(c.req.query('status'), ['pending', 'succeeded', 'error', 'interrupted'] as const),
      });
      return page ? c.json(page) : c.json({ error: 'not found' }, 404);
    } catch (error) { return debugError(c, error); }
  });

  app.get('/brain/debug/sessions/:id/requests/:requestId', c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    const item = d.brain.debugRequest(c.req.param('id'), c.req.param('requestId'));
    return item ? c.json(item) : c.json({ error: 'not found' }, 404);
  });

  app.get('/brain/debug/sessions/:id/requests/:requestId/segments', c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    try {
      const page = d.brain.debugRequestSegments(c.req.param('id'), c.req.param('requestId'), {
        cursor: c.req.query('cursor'), limit: debugNumber(c.req.query('limit')), maxBytes: debugNumber(c.req.query('maxBytes')),
      });
      return page ? c.json(page) : c.json({ error: 'not found' }, 404);
    } catch (error) { return debugError(c, error); }
  });

  app.get('/brain/debug/sessions/:id/requests/:requestId/segments/:index', c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    try {
      const item = d.brain.debugRequestSegment(
        c.req.param('id'), c.req.param('requestId'), Number(c.req.param('index')), debugNumber(c.req.query('maxBytes')),
      );
      return item ? c.json(item) : c.json({ error: 'not found' }, 404);
    } catch (error) { return debugError(c, error); }
  });

  app.get('/brain/debug/sessions/:id/requests/:requestId/raw', c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    try {
      const payload = d.brain.debugRawRequest(c.req.param('id'), c.req.param('requestId'), debugNumber(c.req.query('maxBytes')));
      return payload ? c.json(payload) : c.json({ error: 'not found' }, 404);
    } catch (error) { return debugError(c, error); }
  });

  app.get('/brain/debug/sessions/:id/legacy-transcript', c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    try {
      const page = d.brain.debugLegacyTranscript(c.req.param('id'), {
        cursor: c.req.query('cursor'), limit: debugNumber(c.req.query('limit')), maxBytes: debugNumber(c.req.query('maxBytes')),
      });
      return page ? c.json(page) : c.json({ error: 'not found' }, 404);
    } catch (error) { return debugError(c, error); }
  });
}
