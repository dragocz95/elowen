import { streamSSE } from 'hono/streaming';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBody } from '../validation.js';
import { brainStartSchema, brainStopSchema, brainVisibilitySchema, brainSendSchema, brainModelSchema, brainRenameSchema, brainToggleSchema, brainThinkSchema, brainCwdSchema, brainCompactSchema, brainContextSchema, brainTerminalSchema, brainGoalSchema, brainAnswerSchema, subagentSendSchema } from '../schemas/brain.js';
import { brainConfigFromElowen } from '../../brain/config.js';
import { readChatImage, isStoredChatImageName } from '../../brain/chatImages.js';
import { listBrainModels, fetchOpenAiModels } from '../../brain/models.js';
import { elowenExec, isExecAllowedForUser } from '../../shared/execs.js';
import { brainProviderIds } from '../../store/configStore.js';
import type { BrainEvent } from '../../brain/events.js';
import { commandsWithPlugins, findCommand, type SlashSurface } from '../../brain/slashCommands.js';
import { logger } from '../../shared/logger.js';
import { UsageService, type ProviderUsage } from '../../brain/providerUsage.js';
import { codexUsageSource } from '../../brain/openaiCodexUsage.js';
import { kimiUsageSource } from '../../brain/kimiUsage.js';
import { anthropicUsageSource } from '../../brain/anthropicUsage.js';
import { brainEventReplayCursor, withoutBrainEventReplayCursor } from '../../brain/session/liveEventReplay.js';
import { SerializedEventBuffer } from '../../brain/session/serializedEventBuffer.js';
import { clientOrigin } from '../clientIp.js';
import type { ElowenApp, ElowenContext, RouteContext } from '../context.js';

/** Normalize a client-supplied `/compact <text>` instruction: require a string, trim, drop empty, and cap
 *  the length so a stray large payload can't bloat the summary prompt. Undefined means "default compaction". */
function compactInstruction(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed ? trimmed.slice(0, 2000) : undefined;
}

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

/** Opt-in backwards pagination for the message history (the chat's lazy-load): undefined when `?limit` is
 *  absent so the caller keeps the historical full bare-array response (the CLI + read-only view rely on
 *  that). `limit` is clamped to a sane window; `before` is the exclusive upper-bound cursor a previous page
 *  returned as `nextBefore` (absent → the newest turns). */
function messagePageOpts(rawLimit?: string, rawBefore?: string): { limit: number; before?: number } | undefined {
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

/** Per-user embedded brain (the new advisor engine): status / start / send / live event stream.
 *  Full-scope callers only — a spawned agent must not drive a human's brain. Each route acts on the
 *  caller's own conversation (`brain-<userId>`). Degrades gracefully when the brain is not wired. */
export function registerBrainRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d } = ctx;
  // One usage poller per provider that publishes a subscription rate-limit rail, keyed by the pi provider
  // id the active model reports. Each returns null until its OAuth account is connected, so the route can
  // look one up unconditionally and simply get null when the active model has no rail.
  const usageServices: Record<string, UsageService> = d.brainAuth ? {
    [codexUsageSource.provider]: new UsageService(codexUsageSource, d.brainAuth),
    [kimiUsageSource.provider]: new UsageService(kimiUsageSource, d.brainAuth),
    [anthropicUsageSource.provider]: new UsageService(anthropicUsageSource, d.brainAuth),
  } : {};
  const forbidden = (c: { get: (k: 'tokenScope') => string }) => c.get('tokenScope') === 'agent';

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
  type BrainService = NonNullable<typeof d.brain>;
  const withBrain = (handler: (c: ElowenContext, brain: BrainService) => Response | Promise<Response>, opts?: { admin?: boolean }) =>
    async (c: ElowenContext): Promise<Response> => {
      if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
      if (forbidden(c) || (opts?.admin === true && !c.get('user')?.is_admin)) return c.json({ error: 'forbidden' }, 403);
      return handler(c, d.brain);
    };

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

  // The pickable models across every configured brain provider — dedicated entries, connected OAuth
  // accounts, or the relay fallback (feeds the Account → CLI dropdown and the CLI /model picker).
  //
  // Each item carries its identity STRUCTURALLY (`program` + the `provider`/`model` it already had) so a
  // client can render the bare model name without parsing anything out of a string — a model id may
  // itself contain slashes, so splitting the spec is not a safe way to get it. `exec` is the canonical
  // spelling and the picker's identifier — since migration v13 it is also what configs, task labels and
  // per-user allow-lists actually store. `legacyExec` is the pre-v13 `elowen:` spelling, kept ONLY so a
  // client built against the older wire format still resolves a pick; nothing in this repo, the web app
  // or the plugin registry reads it, and it goes away in the migration's cleanup phase. Non-admins only
  // see models their allow-list permits — this single server-side filter covers web AND CLI.
  app.get('/brain/models', async c => {
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const cfg = brainConfigFromElowen(d.config, d.brainAuth);
    if (!cfg) return c.json([]);
    const models = (await listBrainModels(cfg)).map((m) => {
      const legacyExec = `elowen:${m.provider}/${m.model}`;
      return { ...m, program: 'elowen' as const, legacyExec, exec: elowenExec(m.provider, m.model) };
    });
    const u = d.users ? c.get('user') : undefined;
    if (!u || u.is_admin) return c.json(models);
    const globalExecs = d.config.get().allowedExecs;
    // Judged on the structured identity — the gate asks the program, not the prefix of a string.
    return c.json(models.filter((m) => isExecAllowedForUser(u, globalExecs, { program: m.program, provider: m.provider, model: m.model }, brainProviderIds(d.config))));
  });

  // Probe an OpenAI-compatible endpoint's /models for the provider add/edit dialog — so the admin
  // clicks models instead of typing them. `apiKey` may be omitted when editing (`id` resolves the
  // stored key). Admin-only: it can exercise arbitrary stored credentials.
  app.post('/brain/providers/probe', async c => {
    const u = d.users ? c.get('user') : undefined;
    if (d.users && d.users.count() > 0 && (!u || !u.is_admin)) return c.json({ error: 'forbidden' }, 403);
    const b = (await c.req.json().catch(() => ({}))) as { baseUrl?: unknown; apiKey?: unknown; id?: unknown };
    const baseUrl = typeof b.baseUrl === 'string' ? b.baseUrl.trim() : '';
    if (!baseUrl) return c.json({ error: 'baseUrl required' }, 400);
    let apiKey = typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : null;
    if (!apiKey && typeof b.id === 'string') apiKey = d.config.brainProviders().find((p) => p.id === b.id)?.apiKey ?? null;
    const models = await fetchOpenAiModels({ id: 'probe', label: 'probe', type: 'openai', baseUrl, models: [], apiKey }, fetch);
    return c.json({ models });
  });

  // Smoke-test the configured brain: run ONE minimal non-streaming completion to prove it actually
  // answers. Admin-only (it exercises stored provider credentials, like providers/probe). Always 200 with
  // a structured result — a provider failure is reported as { ok:false, error }, never a 500.
  app.post('/brain/test', async c => {
    const u = d.users ? c.get('user') : undefined; // setup/open mode: no user store or zero users → skip the admin gate (matches providers/probe)
    if (d.users && d.users.count() > 0 && (!u || !u.is_admin)) return c.json({ error: 'forbidden' }, 403);
    if (!d.brain) return c.json({ ok: false, error: 'brain unavailable' });
    const b = (await c.req.json().catch(() => ({}))) as { providerId?: unknown; model?: unknown };
    const sel = {
      providerId: typeof b.providerId === 'string' ? b.providerId : undefined,
      model: typeof b.model === 'string' ? b.model : undefined,
    };
    return c.json(await d.brain.smokeTest(sel));
  });

  // Stop the streaming turn (the Esc key in chat clients). `session` scopes it to the caller's own
  // bound conversation (the CLI); absent → the active one.
  app.post('/brain/abort', withBrain(async (c, brain) => {
    const { session } = await parseBody(c, brainStopSchema);
    try { await brain.abort(c.get('user').id, session); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Esc with a queued owner message: atomically interrupt the active PI run and promote the oldest queue
  // entry into a fresh user turn. Client generation fencing prevents a delayed request from reviving a
  // conversation after that CLI switched/stopped.
  app.post('/brain/interrupt-queued', withBrain(async (c, brain) => {
    const { session, client, generation } = await parseBody(c, brainStopSchema);
    const boundClient = session && client && generation ? { id: client, generation } : undefined;
    try { return c.json(await brain.interruptQueued(c.get('user').id, session, boundClient)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Ctrl+B: release foreground delegate tool waits without cancelling their child channels. The plugin
  // keeps the jobs alive; BrainService routes their eventual results back into this exact conversation.
  app.post('/brain/subagents/background', withBrain(async (c, brain) => {
    const { session, client, generation } = await parseBody(c, brainStopSchema);
    const boundClient = session && client && generation ? { id: client, generation } : undefined;
    try { return c.json(await brain.detachForegroundSubagents(c.get('user').id, session, boundClient)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // A tab reporting that it went to the background, or came back. Presence only: the stream stays
  // attached either way, so nothing about the session's lifecycle changes — it only decides whether a
  // finished turn reaches for the user's phone instead of assuming somebody is reading the answer. A
  // browser keeps its SSE stream open behind a locked screen, so attachment alone cannot tell these apart.
  app.post('/brain/visibility', withBrain(async (c, brain) => {
    const { client, hidden } = await parseBody(c, brainVisibilitySchema);
    return c.json(brain.setClientVisibility(c.get('user').id, client, hidden));
  }));

  // Ctrl+B: move a running foreground Bash command to the background without killing it. The plugin keeps
  // it running; its exit later nudges this same conversation, exactly like Bash(background=true).
  app.post('/brain/commands/background', withBrain(async (c, brain) => {
    const { session, client, generation } = await parseBody(c, brainStopSchema);
    const boundClient = session && client && generation ? { id: client, generation } : undefined;
    try { return c.json(await brain.detachForegroundCommands(c.get('user').id, session, boundClient)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Stop escalation (a further Esc / repeat Ctrl+C after the graceful interrupt): hard-kill the running
  // foreground Bash command(s) of this conversation. The turn's abort has already been requested by the
  // client; killing settles the Bash tool as [killed], which lets the parked agent loop unwind instead of
  // waiting the command out. Same body shape as the background routes above.
  app.post('/brain/commands/kill', withBrain(async (c, brain) => {
    const { session, client, generation } = await parseBody(c, brainStopSchema);
    const boundClient = session && client && generation ? { id: client, generation } : undefined;
    try { return c.json(await brain.killForegroundCommands(c.get('user').id, session, boundClient)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Ctrl+B: detach a foreground WorkflowStart so its DAG keeps running and delivers its summary back
  // into this conversation, exactly like a background workflow. Same shape as the two routes above.
  app.post('/brain/workflows/background', withBrain(async (c, brain) => {
    const { session, client, generation } = await parseBody(c, brainStopSchema);
    const boundClient = session && client && generation ? { id: client, generation } : undefined;
    try { return c.json(await brain.detachForegroundWorkflows(c.get('user').id, session, boundClient)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Closing a session-bound client: abort its active run and dispose the live PI session only when no
  // other client is attached. Persisted history remains resumable. `detachOnly` (the web beacon) keeps the
  // binding release but refuses the teardown while work is in flight — a closing tab must not kill an
  // agent. Logged on both outcomes: this route used to be silent, which made a phone-lock teardown
  // impossible to confirm from the daemon log.
  app.post('/brain/session/stop', withBrain(async (c, brain) => {
    const { session, client, generation, detachOnly } = await parseBody(c, brainStopSchema);
    try {
      const result = await brain.stopSession(c.get('user').id, session, client, generation, { detachOnly: detachOnly === true });
      logger('brain').info(`session stop: session=${session ?? '-'} client=${client ?? '-'} generation=${generation ?? '-'} detachOnly=${detachOnly === true} → stopped=${result.stopped} disposed=${result.disposed}`);
      return c.json(result);
    } catch (e) {
      logger('brain').warn(`session stop failed: session=${session ?? '-'} client=${client ?? '-'} — ${(e as Error).message}`);
      return c.json({ error: (e as Error).message }, 404);
    }
  }));

  // Switch the active conversation (or the caller's explicit `session`) to another configured model (the
  // /model picker). The session respawns in place under the same id — open SSE taps survive the respawn
  // and every attached client reconciles via the pushed `session-event`, so no client reopens its stream.
  app.post('/brain/model', withBrain(async (c, brain) => {
    const { session, ...sel } = await parseBody(c, brainModelSchema);
    try { return c.json(await brain.switchModel(c.get('user').id, sel, session)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Bind (MOVE, not fork) one of the caller's OWN conversations into a platform channel/thread (the
  // /context picker): the chosen session is re-keyed onto `brain-ch-<channel>` so the channel's next turn
  // continues in it, and whatever occupied the slot is archived. A `picker`, so it can NOT go through
  // POST /brain/command (that handler rejects kind!=='action') — hence this dedicated endpoint. Unlike
  // POST /brain/model (which only mutates the caller's OWN session), binding mutates SHARED channel state
  // on a caller-supplied `channel` target, so it is ADMIN-gated here too — matching the operator gate the
  // platform adapters already apply — on top of the ownership guard inside bindChannelContext (caller-owned
  // sessions only). `channel` is the keyOf key (e.g. 'discord-123'); a guard rejection surfaces as 409.
  app.post('/brain/context', withBrain(async (c, brain) => {
    const { channel, session } = await parseBody(c, brainContextSchema);
    try { return c.json(await brain.bindChannelContext(c.get('user').id, channel, session)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }, { admin: true }));

  // Open (or re-attach to) an admin's interactive `elowen chat` terminal bound to one of THEIR OWN
  // conversations. ADMIN-only (invariant 4): agent tokens AND ordinary full-scope non-admins are rejected
  // 403 — the same is_admin gate /brain/context uses. Ownership is enforced inside open() (a foreign
  // admin's session throws `unknown session`), so the generic admin bypass never widens this. The response
  // carries only { terminal, created } — the per-terminal token (invariant 5) never leaves the daemon.
  // The running state is DERIVED from the owner-filtered GET /sessions (no separate polling endpoint).
  app.post('/brain/terminal', withBrain(async (c) => {
    if (!d.brainTerminal) return c.json({ error: 'brain unavailable' }, 503);
    const { session } = await parseBody(c, brainTerminalSchema);
    try { return c.json(await d.brainTerminal.open(c.get('user').id, session), 201); }
    catch (e) {
      // Never echo raw error text here: open()'s launch-failure path would otherwise carry the tmux argv
      // (and thus the per-terminal token) into the response body. Only the known ownership rejection is
      // surfaced verbatim; open() already sanitizes launch failures to a constant, and any other throw
      // collapses to that same constant so nothing sensitive leaks (invariant 5).
      const msg = (e as Error).message;
      if (msg === 'unknown session') return c.json({ error: msg }, 404);
      return c.json({ error: 'terminal launch failed' }, 409);
    }
  }, { admin: true }));

  // Set the active conversation's reasoning effort live (the /think command) — no session rebuild.
  app.post('/brain/think', withBrain(async (c, brain) => {
    const { level, session } = await parseBody(c, brainThinkSchema);
    try { return c.json(await brain.setThinkingLevel(c.get('user').id, level, session)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Record that the client moved its working directory (the CLI's /cd). The cwd itself already rides
  // every turn; this only annotates the conversation so the agent is told, and rejects a directory the
  // caller's policy would refuse rather than announcing a move that cannot happen.
  app.post('/brain/cwd', withBrain(async (c, brain) => {
    const { dir, session } = await parseBody(c, brainCwdSchema);
    try { return c.json(brain.noteWorkDir(c.get('user').id, dir, session)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // OpenAI OAuth priority service tier (`service_tier: priority`). Session-scoped and live, like YOLO;
  // unsupported providers are rejected instead of silently pretending Fast is active.
  app.post('/brain/fast', withBrain(async (c, brain) => {
    const { on, session } = await parseBody(c, brainToggleSchema);
    try { return c.json(brain.setFast(c.get('user').id, on, session)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // SESSION-scoped YOLO override (the CLI /yolo command): flips "ask" permission rules to auto-approve
  // for the caller's ACTIVE live conversation only (deny rules still deny). `on` absent → toggle the
  // current effective state. The persisted per-user default lives at /auth/me/permissions.
  app.post('/brain/yolo', withBrain(async (c, brain) => {
    const { on, session } = await parseBody(c, brainToggleSchema);
    try { return c.json(brain.setYolo(c.get('user').id, on, session)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Manual context compaction (the /compact command in chat clients). Returns the fresh usage numbers
  // plus whether anything was compacted — a too-small/already-compacted session is a benign no-op
  // (200 with compacted:false), NOT an opaque 409, so clients show a friendly notice instead of a failure.
  app.post('/brain/compact', withBrain(async (c, brain) => {
    const { session, instruction } = await parseBody(c, brainCompactSchema);
    try { return c.json(await brain.compact(c.get('user').id, session, compactInstruction(instruction))); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // The published slash-command catalog for one surface + user — the SINGLE source of truth
  // (src/brain/slashCommands.ts). Every chat client renders its menu / registers its commands from this,
  // so a new command is added in one place and appears in CLI, Discord and the web dock at once.
  app.get('/brain/commands', async c => {
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const q = c.req.query('surface');
    const surface: SlashSurface = q === 'cli' || q === 'discord' || q === 'whatsapp' || q === 'telegram' || q === 'msteams' ? q : 'web';
    // Built-ins + any plugin-contributed prompt commands from the live registry (surface-scoped; a plugin
    // can never shadow a built-in — enforced both at registration and in commandsWithPlugins).
    const registry = await d.plugins?.get().catch(() => null);
    const pluginCommands = registry
      ? [...registry.commands.values()].map((cmd) => ({ ...cmd, plugin: registry.commandOwner.get(cmd.name) }))
      : [];
    // No registry (still loading, or it failed) means nothing is running, so every plugin-gated built-in
    // is withheld rather than advertised on a hunch.
    return c.json({ commands: commandsWithPlugins(surface, !!c.get('user').is_admin, pluginCommands, registry?.loadedNames ?? new Set()) });
  });

  // Execute a server-side (`action`) slash command through ONE dispatch path for every surface. Pickers
  // (`model`/`think`) and info (`status`/`help`) stay client-side (their own endpoints / rendering).
  app.post('/brain/command', withBrain(async (c, brain) => {
    const user = c.get('user');
    // Polymorphic dispatch body: `name` selects the command and the remaining fields are per-command, so
    // this one stays a permissive hand-rolled read rather than a single zod schema (mirrors the streaming
    // handler). A bad `name` is a 400 below either way.
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; session?: unknown; on?: unknown; instruction?: unknown };
    const cmd = typeof body.name === 'string' ? findCommand(body.name) : undefined;
    if (!cmd || cmd.kind !== 'action') return c.json({ error: 'unknown command' }, 400);
    if (cmd.adminOnly && !user.is_admin) return c.json({ error: 'forbidden' }, 403);
    try {
      switch (cmd.name) {
        case 'stop': await brain.abort(user.id, typeof body.session === 'string' ? body.session : undefined); return c.json({ ok: true, message: 'Agent stopped.' });
        case 'new': return c.json({ ok: true, message: 'Started a fresh conversation.', data: await brain.start(user.id, { fresh: true }) });
        // Destructive and deliberate: it empties the caller's own conversation in place. A conversation
        // with work in flight throws, which the catch below turns into a 409 carrying the reason.
        case 'clear': {
          const data = await brain.clearSession(user.id, typeof body.session === 'string' ? body.session : undefined);
          return c.json({ ok: true, message: 'Conversation cleared.', data });
        }
        case 'compact': {
          const target = typeof body.session === 'string' ? body.session : undefined;
          // A compaction runs a summarizing model turn, so its tokens are spend like any other and are
          // attributed to whoever asked for it. preflightSend is used purely as the ownership-checked
          // resolver of "which conversation is this about"; a failure here is not this route's error.
          try { pinOrigin(c, brain.preflightSend(user.id, target)); } catch { /* no conversation to attribute */ }
          const r = await brain.compact(user.id, target, compactInstruction(body.instruction));
          return c.json({ ok: true, message: r.compacted ? 'Conversation compacted.' : (r.message ?? 'Nothing to compact yet.'), data: { usage: r.usage } });
        }
        case 'fast': {
          const r = brain.setFast(user.id, typeof body.on === 'boolean' ? body.on : undefined, typeof body.session === 'string' ? body.session : undefined);
          return c.json({ ok: true, message: `Fast mode ${r.fast ? 'enabled' : 'disabled'}.`, data: r });
        }
        case 'restart':
          if (!d.restartDaemon) return c.json({ error: 'restart is not available on this deployment' }, 501);
          await d.restartDaemon(user.id);
          return c.json({ ok: true, message: 'Restarting the Elowen daemon…' });
        default: return c.json({ error: 'command is not server-dispatchable' }, 400);
      }
    } catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  app.post('/brain/send', withBrain(async (c, brain) => {
    const { text, images, mode, cwd, session, display, client, generation } = await parseBody(c, brainSendSchema);
    // `session` binds the turn to the caller's own explicit conversation (ownership-checked in send();
    // channel/task sessions rejected). Absent → the active conversation, exactly as before. `display` is
    // the clean text the daemon echoes back as the authoritative `user` turn (the client no longer echoes
    // optimistically); absent → the model-facing text is shown.
    const boundClient = session && client && generation ? { id: client, generation } : undefined;
    // preflightSend resolves the conversation this turn will land in (the bound session, else the active
    // one) and throws when there is none — so it is both the guard and the only place the target id is
    // known BEFORE the turn starts, which is exactly when the origin has to be captured.
    let targetSession: string;
    try { targetSession = brain.preflightSend(c.get('user').id, session, boundClient); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); } // not started yet / unknown session
    pinOrigin(c, targetSession);
    // A model/tool turn can outlive nginx/SSH proxy request timeouts while its authoritative output is
    // already flowing over SSE. Wait only until the user row + stream echo are durable, then return 202.
    // A failure before that boundary is an HTTP error; a later failure is an ordered SSE error so an
    // attached TUI/headless client cannot silently lose an accepted prompt.
    const operation = brain.startSend({
      userId: c.get('user').id,
      text,
      images,
      mode,
      clientCwd: cwd,
      session,
      display,
      client: boundClient,
    });
    void operation.completed.catch(async (error) => {
      try {
        const admittedSession = await operation.admitted;
        logger('brain-send').error(`accepted turn failed for ${admittedSession}`, error);
        brain.publishAcceptedSendFailure(admittedSession, error);
      } catch { /* pre-admission failure is returned by this request below */ }
    });
    try { await operation.admitted; }
    catch (error) {
      logger('brain-send').error('turn admission failed', error);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
    return c.json({ ok: true, accepted: true }, 202);
  }));

  // The caller's pending mid-turn backlog (messages sent while a turn streams are STEERED into it and
  // reported by PI until delivered). `session` scopes it to a bound CLI's conversation; absent → the
  // active one. Full snapshot (id + text) — the same shape the `queue` stream event carries, so clients
  // seed and reconcile alike.
  app.get('/brain/queue', c => {
    if (!d.brain) return c.json([]);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    try { return c.json(d.brain.queueList(c.get('user').id, c.req.query('session'))); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  });

  // Drop the pending mid-turn backlog (the CLI's queue-remove keybind / the web × button). PI steers a
  // mid-turn message into the running turn within a step or two, so there is no per-id removal to target —
  // the `:id` is accepted for wire compatibility and ignored; this clears whatever is still pending.
  // Always 200 with { removed } (false when nothing was pending). The cleared snapshot fans out via the
  // `queue` stream event.
  app.delete('/brain/queue/:id', withBrain((c, brain) => {
    try { return c.json({ removed: brain.queueRemove(c.get('user').id, c.req.param('id')!, c.req.query('session')) }); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  }));

  // Pop the LAST pending mid-turn message and return its text — the CLI ↑-recall (restores it to the
  // composer) and ctrl+x remove-last. Pops by value from the authoritative queue, not the fragile
  // positional id, so it can never leave a message both queued and re-sendable. { text: null } when the
  // queue is already empty. The reduced snapshot fans out via the `queue` stream event.
  app.post('/brain/queue/recall', withBrain((c, brain) => {
    try { return c.json(brain.queueRecall(c.get('user').id, c.req.query('session'))); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  }));

  // Answer a parked AskUserQuestion. Deliberately bypasses the per-turn send() lock (the parked turn
  // holds it) — it just resolves the registry Promise, so it never deadlocks. An unknown/expired id is a
  // tolerated no-op (matched:false) rather than an error, so a late double-click is harmless.
  app.post('/brain/answer', withBrain(async (c, brain) => {
    const { id, answers } = await parseBody(c, brainAnswerSchema);
    const matched = brain.answerQuestion(id, answers, c.get('user').id); // owner route: only the caller's own question
    return c.json({ ok: true, matched });
  }));

  // Goal routes: `session` (query on GET/action, body on POST) scopes the goal to the caller's own
  // bound conversation (the CLI); absent → the active one.
  app.get('/brain/goal', c => {
    if (!d.brain) return c.json(null);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    try { return c.json(d.brain.goalStatus(c.get('user').id, c.req.query('session'))); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  });

  app.post('/brain/goal', withBrain(async (c, brain) => {
    const { text, draft, turnBudget: rawBudget, session } = await parseBody(c, brainGoalSchema);
    const turnBudget = rawBudget !== undefined && Number.isFinite(rawBudget) ? Math.max(1, Math.min(50, Math.floor(rawBudget))) : undefined;
    try { return c.json(await brain.setGoal(c.get('user').id, text, { draft: draft === true, turnBudget }, session), 201); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  app.post('/brain/goal/action', withBrain((c, brain) => {
    const action = c.req.query('action');
    if (action !== 'pause' && action !== 'resume' && action !== 'clear') return c.json({ error: 'unknown action' }, 400);
    try { return c.json(brain.goalAction(c.get('user').id, action, c.req.query('session'))); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  }));

  app.post('/brain/subgoal', withBrain(async (c, brain) => {
    // Polymorphic on `action` (add carries `text`, remove carries `index`), so a hand-rolled read rather
    // than a single schema — like /brain/command. An unknown action is a 400 below.
    const body = (await c.req.json().catch(() => ({}))) as { action?: unknown; text?: unknown; index?: unknown; session?: unknown };
    if (body.action !== 'add' && body.action !== 'remove' && body.action !== 'clear') return c.json({ error: 'unknown action' }, 400);
    try {
      const value = body.action === 'add' ? body.text : body.action === 'remove' ? body.index : undefined;
      return c.json(brain.subgoal(c.get('user').id, body.action, value as string | number | undefined, typeof body.session === 'string' ? body.session : undefined));
    } catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // The owner talking into a delegated sub-agent's session: steered into its running turn, or run as
  // a fresh turn when the child is idle. Fire-and-forget — the reply rides the tapped session stream
  // (an idle child's turn can take minutes; blocking the HTTP call on it would just time out).
  app.post('/brain/subagent/send', withBrain(async (c, brain) => {
    const body = await parseBody(c, subagentSendSchema);
    try { brain.messagesOf(c.get('user').id, body.session); } catch { return c.json({ error: 'unknown session' }, 404); }
    // Validate the durable child boundary before detaching the potentially minutes-long turn. Without this
    // preflight, a legacy child (no persisted scope) would reject inside the swallowed Promise and the
    // caller would receive a misleading `{ok:true}` with no continuation ever running.
    try { brain.preflightSubagentSend(c.get('user').id, body.session); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
    // The child's own session, not the parent's: a sub-agent turn ordered by hand is attributed to the
    // human who typed into it. A sub-agent turn the PARENT spawns has no request of its own and settles
    // as `internal`, which is the honest answer — nobody typed it.
    pinOrigin(c, body.session);
    void brain.sendToSubagent(c.get('user').id, body.session, body.text).catch(() => { /* surfaced on the child's stream */ });
    return c.json({ ok: true });
  }));

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
