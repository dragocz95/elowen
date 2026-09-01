// The memory module's read endpoints. The catch-all's `[]` renders /memory as an empty state, which is
// exactly the shape that cannot exercise a REGISTER: no rows means no row rhythm, no sticky header to
// scroll under and — because the list paginates client-side at 20 — no pager. The viewport audit needs
// all three, so the memory list is modeled with enough rows to spill onto a third page.
//
// Read-only on purpose: this exists to give the layout something to lay out. A spec that needs to
// exercise a memory WRITE should model that write deliberately rather than lean on a fixture list.
import type { Hono } from 'hono';
import { memories, memoryCategories } from '../../seed/fixtures.ts';

export function registerMemoryRoutes(app: Hono): void {
  // The web sends `status`/`kind`/`q`/`categoryId` and paginates in the browser, so filtering here only
  // has to be faithful enough that a filtered view is not silently the unfiltered one.
  app.get('/memory', (c) => {
    const status = c.req.query('status') ?? 'active';
    const kind = c.req.query('kind');
    const q = c.req.query('q')?.trim().toLowerCase();
    let rows = memories;
    if (status && status !== 'all' && status !== '') rows = rows.filter((m) => m.status === status);
    if (kind) rows = rows.filter((m) => m.kind === kind);
    if (q) rows = rows.filter((m) => m.body.toLowerCase().includes(q));
    return c.json(rows);
  });

  app.get('/memory/categories', (c) => c.json(memoryCategories));
  app.get('/memory/events', (c) => c.json([]));
  // The detail rail. Without these the rail opens and then throws on an undefined record, which reads in
  // a test run as "the rail does not open" rather than as the missing fixture it is.
  app.get('/memory/:id{[0-9]+}', (c) => {
    const row = memories.find((m) => m.id === Number(c.req.param('id')));
    return row ? c.json(row) : c.json({ error: 'not found' }, 404);
  });
  app.get('/memory/:id{[0-9]+}/events', (c) => c.json([]));
  app.get('/memory/:id{[0-9]+}/vitality-history', (c) => c.json({
    points: [], forecast: [], recalls: [], floor: 0.1, evictAt: null, historyFrom: null, now: '2026-07-20T10:00:00.000Z',
  }));
  // Admin-only workspace settings the module reads before it can paint its settings tab.
  app.get('/memory/embedding', (c) => c.json({ providerId: '', model: '', baseUrl: '', configured: false }));
  app.get('/memory/categorization', (c) => c.json({ providerId: '', model: '', baseUrl: '', configured: false }));
  app.get('/memory/maintenance', (c) => c.json({
    reindex: { operation: 'reindex', status: 'idle', id: null, mode: null, total: 0, processed: 0, succeeded: 0, failed: 0, error: null, startedAt: null, finishedAt: null },
    recategorize: { operation: 'recategorize', status: 'idle', id: null, mode: null, total: 0, processed: 0, succeeded: 0, failed: 0, error: null, startedAt: null, finishedAt: null },
  }));
}
