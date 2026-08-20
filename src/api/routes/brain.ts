import { streamSSE } from 'hono/streaming';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBody } from '../validation.js';
import { brainStartSchema, brainRenameSchema } from '../schemas/brain.js';
import { readChatImage, isStoredChatImageName } from '../../brain/chatImages.js';
import type { BrainEvent } from '../../brain/events.js';
import { logger } from '../../shared/logger.js';
import { UsageService, type ProviderUsage } from '../../brain/providerUsage.js';
import { codexUsageSource } from '../../brain/openaiCodexUsage.js';
import { kimiUsageSource } from '../../brain/kimiUsage.js';
import { anthropicUsageSource } from '../../brain/anthropicUsage.js';
import { brainEventReplayCursor, withoutBrainEventReplayCursor } from '../../brain/session/liveEventReplay.js';
import { SerializedEventBuffer } from '../../brain/session/serializedEventBuffer.js';
import type { ElowenApp, RouteContext } from '../context.js';
import { registerBrainChatRoutes } from './brainChat.js';
import { registerBrainDebugRoutes } from './brainDebug.js';
import { registerBrainProviderRoutes } from './brainProviders.js';
import { createBrainRouteContext, messagePageOpts } from './brainRouteContext.js';

/** Opt-in pagination for the session listing: undefined when neither query param is present (the caller
 *  keeps the historical bare-array response), otherwise the clamped non-negative ints. A missing/garbage
 *  value coerces to 0 rather than 400 — pagination is a convenience window, not a validated resource. */
function sessionPageOpts(rawLimit?: string, rawOffset?: string): { limit?: number; offset?: number } | undefined {
  if (rawLimit === undefined && rawOffset === undefined) return undefined;
  const clamp = (v?: string): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const opts: { limit?: number; offset?: number } = {};
  if (rawLimit !== undefined) opts.limit = clamp(rawLimit);
  if (rawOffset !== undefined) opts.offset = clamp(rawOffset);
  return opts;
}

/** Per-user embedded brain (the new advisor engine): status / start / send / live event stream.
 *  Full-scope callers only — a spawned agent must not drive a human's brain. Each route acts on the
 *  caller's own conversation (`brain-<userId>`). Degrades gracefully when the brain is not wired. */
export function registerBrainRoutes(app: ElowenApp, ctx: RouteContext): void {
  const route = createBrainRouteContext(ctx);
  const { d, forbidden, pinOrigin, withBrain } = route;
  // One usage poller per provider that publishes a subscription rate-limit rail, keyed by the pi provider
  // id the active model reports. Each returns null until its OAuth account is connected, so the route can
  // look one up unconditionally and simply get null when the active model has no rail.
  const usageServices: Record<string, UsageService> = d.brainAuth ? {
    [codexUsageSource.provider]: new UsageService(codexUsageSource, d.brainAuth),
    [kimiUsageSource.provider]: new UsageService(kimiUsageSource, d.brainAuth),
    [anthropicUsageSource.provider]: new UsageService(anthropicUsageSource, d.brainAuth),
  } : {};

  registerBrainDebugRoutes(app, route);

  app.get('/brain/status', async c => {
    if (!d.brain) return c.json({ running: false, sessionId: null, model: '', usage: null, statusline: null, project: { cwd: null, branch: null }, mcp: null });
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    // The statusline plugin's display toggles ride along (no secrets in there), so any chat client —
    // web dock or CLI — renders the same user-configured statusline without an admin-only call.
    const statusline = d.config.get().plugins.enabled.includes('statusline')
      ? d.config.pluginConfig('statusline')
      : null;
    const registry = await d.plugins?.get().catch(() => null);
    // Live LSP diagnostics state, read from the lsp plugin's control so chat clients can show it. The
    // plugin owns the subsystem: with it disabled there is no control, the field is OMITTED (never a
    // fabricated `false`) and every client hides its LSP row instead of claiming diagnostics are off.
    const lsp = registry?.control('lsp');
    // MCP servers are DAEMON-GLOBAL state, not the caller's: they stay behind the same admin gate as
    // GET /plugins/mcp/servers. A non-admin gets null, which hides the section instead of naming another
    // account's tooling. Reading the memoized registry costs no plugin load on this hot poll.
    const mcp = c.get('user')?.is_admin
      ? registry?.control('mcp')?.listServers()
        .map((s) => ({ name: s.name, status: s.status })) ?? null
      : null;
    // `?session=<id>`: a session-bound client (the CLI) asks about ITS conversation, not the active one.
    try { return c.json({ ...d.brain.status(c.get('user').id, c.req.query('session')), statusline, ...(lsp ? { lspEnabled: lsp.diagnosticsEnabled() } : {}), mcp }); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  });

  /** OAuth subscription limit windows for the caller's active/bound session, selected by the active
   *  model's provider (OpenAI Codex, Kimi, …). Kept separate from the hot status poll: the CLI can refresh
   *  these slow-changing limits independently. Returns null when the active model has no usage rail. */
  app.get('/brain/rate-limits', async c => {
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    if (!d.brain) return c.json(null);
    try {
      const status = d.brain.status(c.get('user').id, c.req.query('session'));
      const service = usageServices[status.provider];
      if (!service) return c.json(null);
      return c.json(await service.getUsage());
    } catch { return c.json({ error: 'unknown session' }, 404); }
  });

  /** What is filling the conversation's context window right now, category by category — the data behind
   *  the CLI's `/context` overlay and the web's Usage → Context section. Read-only; `null` when no live
   *  session holds the conversation (there is no prompt to measure yet). Distinct path from the
   *  `POST /brain/context` channel re-key, which is a different operation entirely. */
  app.get('/brain/context-usage', withBrain((c, brain) => {
    try { return c.json(brain.contextBreakdown(c.get('user').id, c.req.query('session'))); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  }));

  /** OAuth subscription usage for every connected account, keyed by pi provider id — independent of the
   *  active model. The settings page renders a per-account usage rail from this; accounts without a usable
   *  OAuth credential (or no rail) return null and are omitted. */
  app.get('/brain/rate-limits/all', async c => {
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const entries = await Promise.all(
      Object.entries(usageServices).map(async ([provider, service]) => [provider, await service.getUsage()] as const),
    );
    const result: Record<string, ProviderUsage> = {};
    for (const [provider, usage] of entries) if (usage) result[provider] = usage;
    return c.json(result);
  });

  app.post('/brain/start', withBrain(async (c, brain) => {
    const { provider, session, fresh, cwd, client, generation } = await parseBody(c, brainStartSchema);
    try {
      const started = await brain.start(c.get('user').id, { provider, session, fresh, cwd, clientId: client, clientGeneration: generation });
      // Opening a conversation does not itself burn tokens, but it establishes where this client is
      // talking from — an advisor autostart or a first turn that follows finds the pin already set.
      pinOrigin(c, started.sessionId);
      return c.json(started, 201);
    }
    catch (e) {
      const message = (e as Error).message;
      return message === 'client request is no longer current'
        ? c.json({ error: message }, 409)
        : c.json({ error: message }, 500);
    }
  }));

  // The caller's conversations (most recent first) for the session pickers in web chat and the CLI.
  // Pagination is opt-in via ?limit&offset (applied after the identity filter): absent → the historical
  // bare array every current caller consumes; present → a { items, total, hasMore } window.
  app.get('/brain/sessions', async c => {
    if (!d.brain) return c.json([]);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const opts = sessionPageOpts(c.req.query('limit'), c.req.query('offset'));
    return c.json(opts ? d.brain.listSessions(c.get('user').id, opts) : d.brain.listSessions(c.get('user').id));
  });

  // Admin session-management panel: EVERY brain session the operator anchors — their own conversations
  // PLUS the platform channel (Discord) and task-worker sessions. Distinct base path from `/brain/sessions`
  // so `:id` below never captures "managed-sessions". Admin-only (channel/task sessions are shared state).
  app.get('/brain/managed-sessions', async c => {
    if (!d.brain) return c.json([]);
    if (forbidden(c) || !c.get('user')?.is_admin) return c.json({ error: 'forbidden' }, 403);
    return c.json(d.brain.listManagedSessions(c.get('user').id));
  });
  // Delete EVERYTHING (the panel's confirmed "delete all"). Registered before the `/:id` variant.
  app.delete('/brain/managed-sessions', withBrain((c, brain) =>
    c.json({ deleted: brain.deleteAllManagedSessions(c.get('user').id) }), { admin: true }));
  app.delete('/brain/managed-sessions/:id', withBrain((c, brain) =>
    c.json({ deleted: brain.deleteManagedSession(c.get('user').id, c.req.param('id')!) }), { admin: true }));

  // Background processes (terminal plugin's `Bash(background:true)` children) — the panel next to
  // the todos lists them, reads output for the modal, and kills on demand. OWNER-only (not merely admin):
  // the underlying shell reads any absolute path — secrets, the config DB — exactly like the terminal tools
  // that spawn these (owner-only there). A second admin is admin-but-not-owner and must not see the buffers.
  const denyNonOwner = (c: { get: (k: 'tokenScope' | 'user') => unknown }): boolean => {
    const u = c.get('user') as { id: number } | undefined; // absent during setup mode (0 users) — fail closed
    return forbidden(c as { get: (k: 'tokenScope') => string }) || !u || !d.brain?.isOwner(u.id);
  };
  app.get('/brain/processes', c => {
    if (denyNonOwner(c)) return c.json({ error: 'forbidden' }, 403);
    try { return c.json(d.brain!.processes(c.get('user').id, c.req.query('session'))); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  });
  app.get('/brain/processes/:id/output', c => {
    if (denyNonOwner(c)) return c.json({ error: 'forbidden' }, 403);
    let out: string | null;
    try { out = d.brain!.processOutput(c.get('user').id, c.req.param('id'), c.req.query('session')); }
    catch { return c.json({ error: 'unknown session' }, 404); }
    return out === null ? c.json({ error: 'unknown process' }, 404) : c.json({ output: out });
  });
  app.delete('/brain/processes/:id', c => {
    if (denyNonOwner(c)) return c.json({ error: 'forbidden' }, 403);
    try { return c.json({ killed: d.brain!.killProcess(c.get('user').id, c.req.param('id'), c.req.query('session')) }); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  });

  // Fulltext search across the caller's own conversations (newest first). Queries under 2 chars
  // yield [] — the store enforces that, plus the ownership scoping.
  app.get('/brain/search', async c => {
    if (!d.brain) return c.json([]);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    return c.json(d.brain.searchMessages(c.get('user').id, c.req.query('q') ?? ''));
  });

  // A user's own chat attachments, kept next to the database so a bubble still shows them after a reload.
  // Loaded straight from an <img>: through the web proxy the request carries the session cookie, which the
  // proxy turns into a daemon bearer, so this needs no signed link — it is a normal authenticated GET.
  app.get('/brain/chat-images/:file', async c => {
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    if (!d.chatImagesDir || !d.brainStore) return c.json({ error: 'not found' }, 404);
    const file = c.req.param('file');
    // Shape first, and only then the database: the ownership check scans message content for this string,
    // so a wildcard like `%` would otherwise buy an unauthenticated-shaped scan of the caller's whole
    // history per request. It can never match a real name, only cost work.
    if (!isStoredChatImageName(file)) return c.json({ error: 'not found' }, 404);
    // An unguessable name is secrecy, not authorization: the attachment is exactly as private as the
    // conversation it was sent in, so serve it only to an owner of a message that references it. Answered
    // as 404, not 403 — telling a stranger the file exists is itself a leak.
    if (!d.brainStore.chatImageBelongsTo(c.get('user').id, file)) return c.json({ error: 'not found' }, 404);
    const image = readChatImage(d.chatImagesDir, file);
    if (!image) return c.json({ error: 'not found' }, 404);
    // Immutable bytes under a random name, so it caches hard and privately. `nosniff` because these bytes
    // are agent-supplied and served from the app's own origin: a file that is a valid image AND valid
    // script must never be re-interpreted as one by a browser guessing at the type.
    return c.body(new Uint8Array(image.body), 200, {
      'content-type': image.mimeType,
      'cache-control': 'private, max-age=31536000',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
    });
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

  app.delete('/brain/sessions/:id', withBrain(async (c, brain) => {
    // Awaited: the delete serializes on the conversation's session lock, so the 200 must not be sent
    // before the teardown has actually run — a client that reloads its list on the response would
    // otherwise still see the conversation it just deleted.
    try { await brain.deleteSession(c.get('user').id, c.req.param('id')!); return c.json({ ok: true }); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  }));

  // Branch one of the caller's OWN conversations: a new peer conversation seeded with a copy of the
  // source's history, which the client then opens like any other stored conversation. Distinct path
  // segment (`/fork`) so it never collides with the `:id` handlers above; ownership is enforced in
  // forkSession via the shared isOwnedUserSession rule, so a foreign/unknown source is a 404.
  app.post('/brain/sessions/:id/fork', withBrain((c, brain) => {
    try { return c.json(brain.forkSession(c.get('user').id, c.req.param('id')!), 201); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  }));

  app.patch('/brain/sessions/:id', withBrain(async (c, brain) => {
    const { title } = await parseBody(c, brainRenameSchema);
    try { return c.json(brain.renameSession(c.get('user').id, c.req.param('id')!, title)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Download one of the caller's OWN conversations as a self-contained HTML transcript (`?format=html`,
  // the default) or a JSONL session file (`?format=jsonl`). Owner-scoped exactly like /brain/messages —
  // ownership is enforced in exportSession via the store row's user_id. Rendered into a private temp dir
  // through PI's own exporter, streamed as a download attachment, then the temp dir is removed. Distinct
  // path segment (`/export`) so it never collides with the `:id` delete/patch handlers above.
  app.get('/brain/sessions/:id/export', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const format = c.req.query('format') === 'jsonl' ? 'jsonl' : 'html';
    let out;
    try { out = await d.brain.exportSession(c.get('user').id, c.req.param('id'), format); }
    catch (e) {
      // Only a genuine ownership/lookup miss is a 404 — a render/parse failure must surface as 500 with a
      // log line, not be masked as "unknown session" (which hides real bugs and leaves nothing to debug).
      const msg = (e as Error).message;
      if (msg === 'unknown session') return c.json({ error: msg }, 404);
      logger('brain-export').error(`export failed for session ${c.req.param('id')}: ${msg}`);
      return c.json({ error: 'export failed' }, 500);
    }
    try {
      const body = readFileSync(out.path);
      return c.body(new Uint8Array(body), 200, {
        'content-type': out.contentType,
        'content-disposition': `attachment; filename="${out.filename}"`,
      });
    } finally { out.cleanup(); }
  });

  // Active conversation's history by default, or ANY of the caller's sessions when `?session=<id>` is
  // given (read-only view of a channel/task session — ownership checked in messagesOf).
  app.get('/brain/messages', async c => {
    if (!d.brain) return c.json([]);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const session = c.req.query('session');
    const page = messagePageOpts(c.req.query('limit'), c.req.query('before'));
    try {
      if (page) return c.json(d.brain.messagesPage(c.get('user').id, session, page));
      return c.json(session ? d.brain.messagesOf(c.get('user').id, session) : d.brain.history(c.get('user').id));
    } catch { return c.json({ error: 'unknown session' }, 404); }
  });

  registerBrainProviderRoutes(app, route);

  registerBrainChatRoutes(app, route);

  // Live events of the ACTIVE conversation by default, or of one explicitly owned session when
  // `?session=<id>` is given (the sub-agent drill-in stream — survives that session's respawns).
  app.get('/brain/stream', c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const brain = d.brain;
    const userId = c.get('user').id;
    const session = c.req.query('session');
    const rawClientId = c.req.query('client');
    if (rawClientId !== undefined && (rawClientId.length === 0 || rawClientId.length > 200)) {
      return c.json({ error: 'invalid client id' }, 400);
    }
    // Authentication is already complete at this point; lifecycle scopes the opaque client id by this
    // userId, so another account can never detach or stop this caller's attachment.
    const clientId = rawClientId;
    const rawClientGeneration = c.req.query('generation');
    const clientGeneration = rawClientGeneration === undefined ? undefined : Number(rawClientGeneration);
    if (clientGeneration !== undefined
      && (!Number.isSafeInteger(clientGeneration) || clientGeneration <= 0 || !clientId)) {
      return c.json({ error: 'invalid client generation' }, 400);
    }
    // Explicit opt-in: normal parent/web streams keep their existing non-replaying contract. Drill-in
    // clients request one replace-in-place snapshot so reconnecting never appends duplicate deltas.
    const withSnapshot = !!session && c.req.query('snapshot') === '1';
    // The snapshot's history is windowed only for a client that asked for a page (`?history=<n>`, the web
    // chat's lazy-load). Without it the frame keeps carrying the full transcript — the CLI's contract.
    const historyWindow = withSnapshot ? messagePageOpts(c.req.query('history')) : undefined;
    return streamSSE(c, async stream => {
      let off: (() => void) | null = null;
      let ready = !withSnapshot;
      const pending = new SerializedEventBuffer<BrainEvent>();
      let pendingOverflow = false;
      let overflowClose: Promise<void> | null = null;
      let writes = Promise.resolve();
      const unsubscribe = (): void => {
        const dispose = off;
        off = null;
        dispose?.();
      };
      const closeOverflow = (): Promise<void> => {
        c.req.raw.signal.removeEventListener('abort', unsubscribe);
        unsubscribe();
        overflowClose ??= stream.close();
        return overflowClose;
      };
      const writeEvent = (e: BrainEvent): void => {
        const cursor = brainEventReplayCursor(e);
        // Replay identity travels in SSE's standard `id` field, not in the public BrainEvent JSON. That
        // keeps Discord/plugin consumers and existing JSONL clients on the stable event schema while a
        // reconnecting CLI can still distinguish an already seen coalesced delta from a new one.
        writes = writes.then(() => stream.writeSSE({
          data: JSON.stringify(withoutBrainEventReplayCursor(e)), event: e.type,
          ...(cursor !== undefined ? { id: String(cursor) } : {}),
        })).catch(() => undefined);
      };
      const deliver = (e: BrainEvent): void => {
        if (!ready) {
          // The first snapshot is useful only with its COMPLETE post-capture replay. On either raw-event
          // or serialized UTF-8 overflow, unsubscribe and close: the reconnect will obtain a new atomic
          // snapshot instead of treating a retained suffix as complete state.
          if (pending.append(e) === 'overflow' && !pendingOverflow) {
            pendingOverflow = true;
            void closeOverflow();
          }
          return;
        }
        writeEvent(e);
      };
      let snapshot: Awaited<ReturnType<typeof brain.tapSessionSnapshot>>['snapshot'] | null = null;
      try {
        if (session && withSnapshot) {
          const attached = await brain.tapSessionSnapshot(userId, session, deliver, clientId, clientGeneration, historyWindow);
          off = attached.off;
          snapshot = attached.snapshot;
        } else off = session
          ? brain.tapSession(userId, session, deliver, clientId, clientGeneration)
          : brain.subscribe(userId, deliver, clientId, clientGeneration);
      }
      catch { await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: session ? 'unknown session' : 'brain not started' }), event: 'error' }); return; }
      // Remote runner taps attach asynchronously. The client may disconnect before that IPC round-trip
      // completes, so consume an already-fired abort before registering the ordinary close listener.
      if (c.req.raw.signal.aborted) { unsubscribe(); return; }
      c.req.raw.signal.addEventListener('abort', unsubscribe, { once: true });
      if (pendingOverflow) {
        await closeOverflow();
        return;
      }
      if (snapshot) {
        writes = writes.then(() => stream.writeSSE({
          data: JSON.stringify(snapshot), event: 'snapshot', id: String(snapshot.cursor),
        })).catch(() => undefined);
        await writes;
        if (pendingOverflow) {
          await closeOverflow();
          return;
        }
        ready = true;
        for (const event of pending.drain()) writeEvent(event);
        await writes;
      }
      // Comment flush so the channel connects through the BFF proxy on a quiet system (see /events).
      await stream.write(': connected\n\n');
      // An SSE comment line never surfaces in an EventSource, so `: ping` is invisible to a browser client
      // and cannot carry a silence watchdog. `?heartbeat=1` upgrades the keep-alive to a named frame the
      // client CAN observe; it stays opt-in so CLI, Discord and JSONL consumers keep reading a stream whose
      // events are only ever BrainEvent types.
      const namedHeartbeat = c.req.query('heartbeat') === '1';
      while (!c.req.raw.signal.aborted) {
        await stream.sleep(30000);
        if (c.req.raw.signal.aborted) break;
        if (!namedHeartbeat) { await stream.write(': ping\n\n'); continue; }
        writes = writes.then(() => stream.writeSSE({ data: '{}', event: 'heartbeat' })).catch(() => undefined);
        await writes;
      }
    });
  });
}
