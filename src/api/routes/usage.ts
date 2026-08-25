import { createHash } from 'node:crypto';
import { queryInt } from '../validation.js';
import type { ElowenApp, RouteContext } from '../context.js';
import type { CostSource } from '../../integrations/usage/types.js';

/** Spend and token aggregates for the caller's brain sessions. */
export function registerUsageRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d, notAdmin } = ctx;
  app.get('/usage/by-model', c => {
    const fromRaw = c.req.query('from');
    const toRaw = c.req.query('to');
    const fromIso = fromRaw && !Number.isNaN(Date.parse(fromRaw)) ? fromRaw : undefined;
    const toIso = toRaw && !Number.isNaN(Date.parse(toRaw)) ? toRaw : undefined;
    const window = fromIso || toIso ? { fromIso, toIso } : undefined;
    const userId = c.get('user')?.id;
    const payload = userId != null ? d.brainStore?.usageByModel(userId, window) ?? [] : [];
    const etag = `"${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)}"`;
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, { etag, 'cache-control': 'private, max-age=0, must-revalidate' });
    return c.json(payload, 200, { etag, 'cache-control': 'private, max-age=0, must-revalidate' });
  });

  app.get('/usage/by-day', c => {
    const days = queryInt(c.req.query('days'), { min: 1, max: 90, fallback: 7 });
    const userId = c.get('user')?.id;
    const payload = userId != null ? d.brainStore?.usageByDay(userId, days) ?? [] : [];
    const etag = `"${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)}"`;
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, { etag, 'cache-control': 'private, max-age=0, must-revalidate' });
    return c.json(payload, 200, { etag, 'cache-control': 'private, max-age=0, must-revalidate' });
  });

  // Who burned the tokens, and from where. ADMIN-ONLY on the server (not merely hidden in the UI): the
  // rows carry client IP addresses, which are personal data, and they span every account on the instance.
  //
  // Served from `usage_by_origin` alone — a write-time rollup, never a query over `brain_messages`. That
  // is a hard constraint, not an optimization: /usage/by-model already scans the largest table in the
  // database with per-row json_extract on the daemon's synchronous event loop, and this view is polled by
  // a drawer. tests/store/usageOriginPlan.test.ts holds the line through EXPLAIN QUERY PLAN.
  //
  // The totals are a SEPARATE counter from /usage/by-day and /usage/by-model, which derive theirs from
  // the messages. They start at `trackingSince` (older spend has no origin and never will), so the two
  // are not expected to agree and this response never claims they do — hence `trackingSince` travels with
  // every answer rather than being something the client has to know to ask for.
  app.get('/usage/by-origin', c => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    if (!d.usageOrigins) return c.json({ error: 'origin usage unavailable' }, 503);
    const groupRaw = c.req.query('group');
    const group = groupRaw === 'user' || groupRaw === 'origin' || groupRaw === 'pair' ? groupRaw : 'pair';
    // Malformed window values are ignored rather than 400'd — the same benevolent posture the sibling
    // usage routes take with `project_id` and `from`/`to`.
    const fromIso = c.req.query('from');
    const toIso = c.req.query('to');
    const rows = d.usageOrigins.topOrigins({
      group,
      ...(fromIso ? { fromIso } : {}),
      ...(toIso ? { toIso } : {}),
      limit: queryInt(c.req.query('limit'), { min: 1, max: 500, fallback: 50 }),
    });
    // Usernames are resolved here, not stored on the rollup: a rename must not fork a user's history into
    // two rows, so the table keeps the id and the display name is looked up at read time. A row whose user
    // no longer exists cannot happen (UserStore.delete removes their rows) but is reported as null rather
    // than invented.
    const names = new Map((d.users?.list() ?? []).map((u) => [u.id, u.username]));
    return c.json({
      rows: rows.map((r) => ({
        userId: r.userId,
        username: r.userId != null ? names.get(r.userId) ?? null : null,
        origin: r.origin, originKind: r.originKind, trusted: r.trusted, origins: r.origins,
        turns: r.turns, tokens: r.tokens,
        input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite,
        // Same discipline as /usage/by-model: a bucket that carried no reported price is `unavailable`
        // with a null cost, never a real $0.
        cost: r.cost, costSource: (r.cost != null ? 'provider_reported' : 'unavailable') satisfies CostSource,
        costedTurns: r.costedTurns,
        firstAt: r.firstAt, lastAt: r.lastAt,
      })),
      group,
      trackingSince: d.usageOrigins.trackingSince(),
    });
  });
  // Reset the caller's message-derived usage and independent origin rollup. Messages remain readable.
  app.post('/usage/reset', c => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const userId = c.get('user')?.id;
    const chat = userId != null ? d.brainStore?.clearUsage(userId) ?? 0 : 0;
    const origins = userId != null ? d.usageOrigins?.clearForUser(userId) ?? 0 : 0;
    return c.json({ ok: true, chatCleared: chat, originsCleared: origins });
  });
}
