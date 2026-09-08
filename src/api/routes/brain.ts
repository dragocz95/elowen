import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBody } from '../validation.js';
import { brainStartSchema, brainRenameSchema, brainActivityReadSchema } from '../schemas/brain.js';
import { readChatImage, isStoredChatImageName } from '../../brain/chatImages.js';
import { chatFileDisposition, chatFilesDir, isStoredChatFileName, readChatFile } from '../../brain/chatFiles.js';
import { logger } from '../../shared/logger.js';
import { isPluginAllowedForUser } from '../../shared/pluginAccess.js';
import { CRON_PLATFORM, channelSessionId, isNonUserSession } from '../../brain/sessionId.js';
import { UsageService, type ProviderUsage } from '../../brain/providerUsage.js';
import { codexUsageSource } from '../../brain/openaiCodexUsage.js';
import { kimiUsageSource } from '../../brain/kimiUsage.js';
import { anthropicUsageSource } from '../../brain/anthropicUsage.js';
import type { ElowenApp, RouteContext } from '../context.js';
import { registerBrainChatRoutes } from './brainChat.js';
import { registerBrainDebugRoutes } from './brainDebug.js';
import { registerBrainProviderRoutes } from './brainProviders.js';
import { createBrainRouteContext, messagePageOpts } from './brainRouteContext.js';
import { registerBrainStreamRoutes } from './brainStream.js';
import { registerBrainUploadRoutes } from './brainUploads.js';

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

/** How many conversations one request may name explicitly. Matches the store's own root ceiling, so a
 *  caller cannot widen the batch by listing more ids than a page could hold. */
const MAX_REQUESTED_CONVERSATIONS = 100;

/** The `?ids` narrowing of GET /brain/conversation-links: the conversations actually on screen, as a
 *  comma-separated list. Undefined when the parameter is absent or names nothing, which keeps the
 *  historical whole-listing behaviour. These are a REQUEST, not an authorization — the caller intersects
 *  them with the set core itself authorized. */
function requestedConversationIds(raw?: string): string[] | undefined {
  if (raw === undefined) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_REQUESTED_CONVERSATIONS) break;
  }
  return out.length > 0 ? out : undefined;
}

/** One navigation row of GET /brain/conversation-links. Mirrors ConversationJobLink in web/lib/types.ts. */
interface ConversationJobLink {
  jobId: string;
  conversationId: string;
  name: string;
  enabled: boolean;
  scope: 'personal' | 'instance';
  href: string;
  /** The conversation the job's turns actually RAN in, once core has verified the caller may open it.
   *  Null when the plugin named none, the transcript does not exist yet (a job that has never fired) or
   *  the caller may not read it — the row then still navigates to `href`, the schedule's own editor.
   *  `continuable` is false for the job's cron channel, which is opened read-only. */
  run: { sessionId: string; continuable: boolean } | null;
}

/** Resolve the run target a cron link claims, or null. The plugin decides WHERE a job runs; whether the
 *  caller may open that transcript is core's decision alone, so both forms are re-checked here against the
 *  store rather than trusted. A named conversation must be the caller's own real conversation; a cron
 *  channel is built from the channel id (never accepted as a ready-made session id, so a plugin can point
 *  at nothing but its own platform's rooms) and is readable by its owner or an administrator. */
function resolveJobRun(
  store: import('../../store/brainStore.js').BrainStore | undefined,
  requester: { id: number; admin: boolean },
  entry: { runSessionId?: unknown; runChannelId?: unknown },
): { sessionId: string; continuable: boolean } | null {
  if (!store) return null;
  if (typeof entry.runSessionId === 'string' && entry.runSessionId) {
    const id = entry.runSessionId;
    const row = store.getSession(id);
    if (!row || isNonUserSession(id) || row.user_id !== requester.id) return null;
    return { sessionId: id, continuable: true };
  }
  if (typeof entry.runChannelId === 'string' && entry.runChannelId) {
    const id = channelSessionId(`${CRON_PLATFORM}-${entry.runChannelId}`);
    const row = store.getSession(id);
    if (!row || (row.user_id !== requester.id && !requester.admin)) return null;
    return { sessionId: id, continuable: false };
  }
  return null;
}

/** Turn what the cron plugin contributed into rows core is willing to serialize.
 *
 *  Three things are re-decided here rather than trusted. The conversation must be one of the ids core
 *  itself authorized — a link naming anything else would announce that a conversation exists and hang a
 *  branch on a row the caller never asked about. Job visibility is re-applied, so an ordinary account
 *  sees only its own jobs and never an instance job's name, which is instance configuration. And the
 *  destination is BUILT here from the job id, so a plugin can only ever point a row at the cron editor on
 *  this same origin. A malformed entry is dropped rather than rendered. */
function toConversationJobLinks(
  contributed: unknown,
  requester: { id: number; admin: boolean },
  authorized: ReadonlySet<string>,
  store?: import('../../store/brainStore.js').BrainStore,
): ConversationJobLink[] {
  if (!Array.isArray(contributed)) return [];
  const out: ConversationJobLink[] = [];
  for (const raw of contributed) {
    const entry = raw as Partial<Record<'jobId' | 'conversationId' | 'name' | 'enabled' | 'ownerUserId' | 'runSessionId' | 'runChannelId', unknown>>;
    const jobId = typeof entry?.jobId === 'string' ? entry.jobId.trim() : '';
    const conversationId = typeof entry?.conversationId === 'string' ? entry.conversationId : '';
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (!jobId || !name || !authorized.has(conversationId)) continue;
    const ownerUserId = typeof entry.ownerUserId === 'number' ? entry.ownerUserId : null;
    if (!requester.admin && ownerUserId !== requester.id) continue;
    out.push({
      jobId,
      conversationId,
      name,
      enabled: entry.enabled === true,
      scope: ownerUserId === null ? 'instance' : 'personal',
      href: `/p/cronjob?job=${encodeURIComponent(jobId)}`,
      run: resolveJobRun(store, requester, entry),
    });
  }
  return out;
}

/** Per-user embedded brain (the new advisor engine): status / start / send / live event stream.
 *  Full-scope callers only — a spawned agent must not drive a human's brain. Each route acts on the
 *  caller's own conversation (`brain-<userId>`). Degrades gracefully when the brain is not wired. */
export function registerBrainRoutes(app: ElowenApp, ctx: RouteContext): void {
  const route = createBrainRouteContext(ctx);
  const { d, pinOrigin, withBrain } = route;
  // One usage poller per provider that publishes a subscription rate-limit rail, keyed by the pi provider
  // id the active model reports. Each returns null until its OAuth account is connected, so the route can
  // look one up unconditionally and simply get null when the active model has no rail.
  const usageServices: Record<string, UsageService> = d.brainAuth ? {
    [codexUsageSource.provider]: new UsageService(codexUsageSource, d.brainAuth),
    [kimiUsageSource.provider]: new UsageService(kimiUsageSource, d.brainAuth),
    [anthropicUsageSource.provider]: new UsageService(anthropicUsageSource, d.brainAuth),
  } : {};

  registerBrainDebugRoutes(app, route);
  registerBrainUploadRoutes(app, route);

  app.get('/brain/status', async c => {
    if (!d.brain) return c.json({ running: false, sessionId: null, model: '', usage: null, statusline: null, project: { cwd: null, branch: null }, mcp: null });
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
    if (!d.brain) return c.json(null);
    try {
      const status = d.brain.status(c.get('user').id, c.req.query('session'));
      // `usageProvider`, not `provider`: the map is keyed by PI provider id, while `provider` is the
      // operator's config entry id that clients display. See BrainStatusView for the split.
      const service = usageServices[status.usageProvider];
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
    const entries = await Promise.all(
      Object.entries(usageServices).map(async ([provider, service]) => [provider, await service.getUsage()] as const),
    );
    const result: Record<string, ProviderUsage> = {};
    for (const [provider, usage] of entries) if (usage) result[provider] = usage;
    return c.json(result);
  });

  app.post('/brain/start', withBrain(async (c, brain) => {
    const { provider, session, fresh, cwd, client, generation, surface } = await parseBody(c, brainStartSchema);
    try {
      const started = await brain.start(c.get('user').id, { provider, session, fresh, cwd, clientId: client, clientGeneration: generation, ...(surface ? { surface } : {}) });
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
    const opts = sessionPageOpts(c.req.query('limit'), c.req.query('offset'));
    return c.json(opts ? d.brain.listSessions(c.get('user').id, opts) : d.brain.listSessions(c.get('user').id));
  });

  app.post('/brain/sessions/:id/read', withBrain(async (c, brain) => {
    const { through, surface } = await parseBody(c, brainActivityReadSchema);
    try { return c.json(brain.readSessionActivity(c.get('user').id, c.req.param('id')!, through, surface)); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  }));

  // Admin session-management panel: EVERY brain session the operator anchors — their own conversations
  // PLUS the platform channel (Discord) and task-worker sessions. Distinct base path from `/brain/sessions`
  // so `:id` below never captures "managed-sessions". Admin-only (channel/task sessions are shared state).
  app.get('/brain/managed-sessions', async c => {
    if (!d.brain) return c.json([]);
    if (!c.get('user')?.is_admin) return c.json({ error: 'forbidden' }, 403);
    return c.json(d.brain.listManagedSessions(c.get('user').id));
  });
  // Delete EVERYTHING the caller was shown (the panel's confirmed "delete all"). Registered before the
  // `/:id` variant. `?scope=all` is the cross-account register, anything else is the caller's own list —
  // the button must delete exactly the rows under it, or "delete all" quietly deletes some. Reaching
  // across accounts is admin-only, which this whole route already is; no second gate is added here,
  // because a second place to ask would be a second place to get it wrong.
  app.delete('/brain/managed-sessions', withBrain((c, brain) =>
    c.json({ deleted: brain.deleteAllManagedSessions(c.get('user').id, c.req.query('scope') === 'all' ? 'any' : 'own') }), { admin: true }));
  // The register spans every account, so its per-row delete does too ('any').
  app.delete('/brain/managed-sessions/:id', withBrain((c, brain) =>
    c.json({ deleted: brain.deleteManagedSession(c.get('user').id, c.req.param('id')!, 'any') }), { admin: true }));

  /** The branches under a conversation listing: the schedules filed under each conversation, and the
   *  sub-agents that ran under it. ONE read per listing, never per row.
   *
   *  `?scope=all` answers for the admin register and needs an administrator; the default `mine` answers
   *  for the caller's OWN conversation list — the actual personal sidebar roots, deliberately not the
   *  wider set a job may be attached to, so a shared platform target never appears among someone's
   *  personal navigation. `?ids` narrows the answer to the page actually on screen and is INTERSECTED
   *  with that authorized set, never trusted: a forged id names nothing, so the reply cannot be used to
   *  discover which conversations exist.
   *
   *  The two branches are independent, and the ordering below is what makes them so. The sub-agent tree
   *  is CORE data read from the store; the schedules are a plugin contribution. A cron plugin that is
   *  disabled, too old, ungranted or simply broken says nothing whatsoever about which sub-agents a
   *  conversation ran, so it may not take that branch down with it — which the early returns here used to
   *  do, one shared `return` at a time.
   *
   *  Each branch carries its own status so a client never has to guess (see ConversationLinksResponse in
   *  web/lib/types.ts). `unavailable` is "there is nothing to ask": for cron the plugin disabled,
   *  uninstalled, too old to carry the optional navigation method, or not granted to this account; for
   *  the core branch an unwired store. A genuine failure is logged and reported as `error` — never as a
   *  confirmed empty list, which would quietly claim the user has no schedules or no sub-agents. */
  app.get('/brain/conversation-links', withBrain(async (c, brain) => {
    const user = c.get('user');
    const all = c.req.query('scope') === 'all';
    if (all && !user?.is_admin) return c.json({ error: 'forbidden' }, 403);

    const conversationIds = all
      ? brain.listManagedSessions(user.id).map((s) => s.id)
      : brain.listSessions(user.id).map((s) => s.id);
    const authorized = new Set(conversationIds);
    const requested = requestedConversationIds(c.req.query('ids'));
    const rootIds = requested ? requested.filter((id) => authorized.has(id)) : conversationIds;

    // Read FIRST and independently, so nothing the cron half does below can reach it.
    let subagentStatus: 'available' | 'unavailable' | 'error' = 'unavailable';
    let subagents: Record<string, unknown> = {};
    let subagentsTruncated = false;
    if (d.brainStore) {
      try {
        const branches = d.brainStore.conversationSubagentBranches(rootIds);
        subagents = branches.byConversation;
        subagentsTruncated = branches.truncated;
        subagentStatus = 'available';
      } catch (e) {
        logger('brain-conversation-links').error(`sub-agent branch read failed: ${(e as Error).message}`);
        subagentStatus = 'error';
      }
    }
    const core = { subagentStatus, subagents, subagentsTruncated };

    let registry;
    try { registry = await d.plugins?.get(); }
    catch (e) {
      logger('brain-conversation-links').error(`plugin registry unavailable: ${(e as Error).message}`);
      return c.json({ status: 'error', links: [], ...core });
    }
    // The GRANT is checked against whichever plugin actually owns the cron control, so core never has to
    // hardcode a plugin package name to gate its own route on.
    const owner = registry?.controlOwner.get('cron');
    const control = registry?.control('cron');
    const granted = !!owner && !!registry
      && isPluginAllowedForUser(user, { name: owner, userGrantable: registry.userGrantable.has(owner) });
    if (!control?.conversationLinks || !granted) return c.json({ status: 'unavailable', links: [], ...core });

    let contributed: unknown;
    try {
      contributed = control.conversationLinks({
        requesterUserId: user.id, requesterIsAdmin: !!user.is_admin, conversationIds,
      });
    } catch (e) {
      logger('brain-conversation-links').error(`cron link read failed: ${(e as Error).message}`);
      return c.json({ status: 'error', links: [], ...core });
    }
    const links = toConversationJobLinks(contributed, { id: user.id, admin: !!user.is_admin }, authorized, d.brainStore);
    return c.json({ status: 'available', links, ...core });
  }));

  // Background processes (terminal plugin's `Bash(run_in_background:true)` children) — the panel next to
  // the todos lists them, reads output for the modal, and kills on demand. Restricted to whoever operates
  // the instance, exactly like the terminal tools that spawn these: the underlying shell reads any absolute
  // path — secrets, the config DB — so an ordinary user must never see the buffers. Each caller still sees
  // only processes they own (`ownsProcess`), so one operator's shell output never reaches another's panel.
  const denyNonOwner = (c: { get: (k: 'tokenScope' | 'user') => unknown }): boolean => {
    const u = c.get('user') as { id: number } | undefined; // absent during setup mode (0 users) — fail closed
    return !u || !d.brain?.isOwner(u.id);
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
    return c.json(d.brain.searchMessages(c.get('user').id, c.req.query('q') ?? ''));
  });

  // A user's own chat attachments, kept next to the database so a bubble still shows them after a reload.
  // Loaded straight from an <img>: through the web proxy the request carries the session cookie, which the
  // proxy turns into a daemon bearer, so this needs no signed link — it is a normal authenticated GET.
  app.get('/brain/chat-images/:file', async c => {
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

  // Agent-shared general files. This intentionally differs from chat-images: arbitrary bytes — especially
  // HTML — must NEVER render from the app's own origin, so every response is a forced opaque download.
  app.get('/brain/chat-files/:file', async c => {
    if (!d.chatImagesDir || !d.brainStore) return c.json({ error: 'not found' }, 404);
    const file = c.req.param('file');
    // Shape BEFORE the database for the same reason as images: `%`/`_` must not widen the LIKE scan.
    if (!isStoredChatFileName(file)) return c.json({ error: 'not found' }, 404);
    // The parsed reference proves both ownership and the original filename. Foreign and missing files are
    // deliberately indistinguishable: 404 avoids leaking that another user's artifact exists.
    const owned = d.brainStore.chatFileForUser(c.get('user').id, file);
    if (!owned) return c.json({ error: 'not found' }, 404);
    const body = readChatFile(chatFilesDir(d.chatImagesDir), file);
    if (!body) return c.json({ error: 'not found' }, 404);
    return c.body(new Uint8Array(body), 200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'private, max-age=31536000',
      'x-content-type-options': 'nosniff',
      'content-disposition': chatFileDisposition(owned.name),
    });
  });

  // Generated images (image-gen plugin) — name is strictly sanitized, path stays inside the data dir.
  app.get('/brain/images/:file', async c => {
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
  //
  // An ADMIN additionally reads foreign transcripts here, which is what the oversight register opens.
  // READ ONLY: the send path keeps its own ownership check, so this never becomes a way to post into
  // someone else's conversation.
  app.get('/brain/messages', async c => {
    if (!d.brain) return c.json([]);
    const session = c.req.query('session');
    const page = messagePageOpts(c.req.query('limit'), c.req.query('before'));
    const access = { anyOwner: !!c.get('user')?.is_admin };
    try {
      if (page) return c.json(d.brain.messagesPage(c.get('user').id, session, page, access));
      return c.json(session ? d.brain.messagesOf(c.get('user').id, session, access) : d.brain.history(c.get('user').id));
    } catch { return c.json({ error: 'unknown session' }, 404); }
  });

  registerBrainProviderRoutes(app, route);

  registerBrainChatRoutes(app, route);

  registerBrainStreamRoutes(app, route);
}
