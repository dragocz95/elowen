import { streamSSE } from 'hono/streaming';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBody } from '../validation.js';
import { brainStartSchema, brainSendSchema, brainModelSchema } from '../schemas/brain.js';
import { brainConfigFromOrca } from '../../brain/config.js';
import { listBrainModels } from '../../brain/models.js';
import type { BrainEvent } from '../../brain/brainService.js';
import type { OrcaApp, RouteContext } from '../context.js';

/** Per-user embedded brain (the new advisor engine): status / start / send / live event stream.
 *  Full-scope callers only — a spawned agent must not drive a human's brain. Each route acts on the
 *  caller's own conversation (`brain-<userId>`). Degrades gracefully when the brain is not wired. */
export function registerBrainRoutes(app: OrcaApp, ctx: RouteContext): void {
  const { d } = ctx;
  const forbidden = (c: { get: (k: 'tokenScope') => string }) => c.get('tokenScope') === 'agent';

  app.get('/brain/status', async c => {
    if (!d.brain) return c.json({ running: false, sessionId: null, model: '', usage: null, statusline: null });
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    // The statusline plugin's display toggles ride along (no secrets in there), so any chat client —
    // web dock or CLI — renders the same user-configured statusline without an admin-only call.
    const statusline = d.config.get().plugins.enabled.includes('statusline')
      ? d.config.pluginConfig('statusline')
      : null;
    return c.json({ ...d.brain.status(c.get('user').id), statusline });
  });

  app.post('/brain/start', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const { provider, session, fresh } = await parseBody(c, brainStartSchema);
    try { return c.json(await d.brain.start(c.get('user').id, { provider, session, fresh }), 201); }
    catch (e) { return c.json({ error: (e as Error).message }, 500); }
  });

  // The caller's conversations (most recent first) for the session pickers in web chat and the CLI.
  app.get('/brain/sessions', async c => {
    if (!d.brain) return c.json([]);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    return c.json(d.brain.listSessions(c.get('user').id));
  });

  // Generated images (image-gen plugin) — name is strictly sanitized, path stays inside the data dir.
  app.get('/brain/images/:file', async c => {
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const file = c.req.param('file');
    if (!d.pluginDataRoot || !/^[a-z0-9]+\.png$/.test(file)) return c.json({ error: 'not found' }, 404);
    // Generated + edited images live in their respective plugin data dirs; try each.
    for (const dir of ['image-gen', 'image-edit']) {
      try {
        const body = readFileSync(join(d.pluginDataRoot, dir, file));
        return c.body(new Uint8Array(body), 200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=31536000' });
      } catch { /* try the next dir */ }
    }
    return c.json({ error: 'not found' }, 404);
  });

  app.delete('/brain/sessions/:id', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    try { d.brain.deleteSession(c.get('user').id, c.req.param('id')); return c.json({ ok: true }); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  });

  app.get('/brain/messages', async c => {
    if (!d.brain) return c.json([]);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    return c.json(d.brain.history(c.get('user').id));
  });

  // The pickable models across every configured brain provider — dedicated entries, connected OAuth
  // accounts, or the relay fallback (feeds the Account → CLI dropdown).
  app.get('/brain/models', async c => {
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const cfg = brainConfigFromOrca(d.config, d.brainAuth);
    if (!cfg) return c.json([]);
    return c.json(await listBrainModels(cfg));
  });

  // Stop the streaming turn (the Esc key in chat clients).
  app.post('/brain/abort', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    try { await d.brain.abort(c.get('user').id); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

  // Switch the active conversation to another configured model (the /model picker). Existing event
  // streams die with the old session — clients reopen their stream after this call.
  app.post('/brain/model', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const sel = await parseBody(c, brainModelSchema);
    try { return c.json(await d.brain.switchModel(c.get('user').id, sel)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

  // Manual context compaction (the /compact command in chat clients). Returns the fresh usage numbers.
  app.post('/brain/compact', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    try { return c.json({ usage: await d.brain.compact(c.get('user').id) }); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

  app.post('/brain/send', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const { text, images } = await parseBody(c, brainSendSchema);
    try { await d.brain.send(c.get('user').id, text, images); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); } // not started yet
  });

  app.get('/brain/stream', c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const brain = d.brain;
    const userId = c.get('user').id;
    return streamSSE(c, async stream => {
      let off: (() => void) | null = null;
      try { off = brain.subscribe(userId, (e: BrainEvent) => void stream.writeSSE({ data: JSON.stringify(e), event: e.type })); }
      catch { await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: 'brain not started' }), event: 'error' }); return; }
      c.req.raw.signal.addEventListener('abort', off);
      // Comment flush so the channel connects through the BFF proxy on a quiet system (see /events).
      await stream.write(': connected\n\n');
      while (!c.req.raw.signal.aborted) {
        await stream.sleep(30000);
        if (c.req.raw.signal.aborted) break;
        await stream.write(': ping\n\n');
      }
    });
  });
}
