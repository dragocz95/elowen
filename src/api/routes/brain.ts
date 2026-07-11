import { streamSSE } from 'hono/streaming';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBody } from '../validation.js';
import { brainStartSchema, brainStopSchema, brainSendSchema, brainModelSchema, brainAnswerSchema, lspInstallSchema, subagentSendSchema } from '../schemas/brain.js';
import { brainConfigFromElowen } from '../../brain/config.js';
import { listBrainModels, fetchOpenAiModels } from '../../brain/models.js';
import { elowenExec, isExecAllowedForUser } from '../../shared/execs.js';
import type { BrainEvent } from '../../brain/events.js';
import { commandsWithPlugins, findCommand, type SlashSurface } from '../../brain/slashCommands.js';
import { processRegistry } from '../../brain/processRegistry.js';
import { logger } from '../../shared/logger.js';
import { OpenAiCodexUsageService } from '../../brain/openaiCodexUsage.js';
import { appendBufferedBrainEvent, brainEventReplayCursor, withoutBrainEventReplayCursor } from '../../brain/session/liveEventReplay.js';
import type { ElowenApp, RouteContext } from '../context.js';

/** Per-user embedded brain (the new advisor engine): status / start / send / live event stream.
 *  Full-scope callers only — a spawned agent must not drive a human's brain. Each route acts on the
 *  caller's own conversation (`brain-<userId>`). Degrades gracefully when the brain is not wired. */
export function registerBrainRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d } = ctx;
  const codexUsage = d.brainAuth ? new OpenAiCodexUsageService({ auth: d.brainAuth }) : null;
  const forbidden = (c: { get: (k: 'tokenScope') => string }) => c.get('tokenScope') === 'agent';

  app.get('/brain/status', async c => {
    if (!d.brain) return c.json({ running: false, sessionId: null, model: '', usage: null, statusline: null });
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    // The statusline plugin's display toggles ride along (no secrets in there), so any chat client —
    // web dock or CLI — renders the same user-configured statusline without an admin-only call.
    const statusline = d.config.get().plugins.enabled.includes('statusline')
      ? d.config.pluginConfig('statusline')
      : null;
    // Live LSP diagnostics state (the `/lsp` toggle's source of truth) so chat clients can show it.
    const { lspEnabled } = await import('../../brain/tools/lspTools.js');
    // `?session=<id>`: a session-bound client (the CLI) asks about ITS conversation, not the active one.
    try { return c.json({ ...d.brain.status(c.get('user').id, c.req.query('session')), statusline, lspEnabled: lspEnabled() }); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  });

  /** ChatGPT OAuth subscription windows for the caller's active/bound OpenAI session. Kept separate
   *  from the hot status poll: the CLI can refresh these slow-changing limits independently. */
  app.get('/brain/rate-limits', async c => {
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    if (!d.brain || !codexUsage) return c.json(null);
    try {
      const status = d.brain.status(c.get('user').id, c.req.query('session'));
      if (!status.fastAvailable) return c.json(null);
      return c.json(await codexUsage.getUsage());
    } catch { return c.json({ error: 'unknown session' }, 404); }
  });

  app.post('/brain/start', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const { provider, session, fresh, cwd, client, generation } = await parseBody(c, brainStartSchema);
    try { return c.json(await d.brain.start(c.get('user').id, { provider, session, fresh, cwd, clientId: client, clientGeneration: generation }), 201); }
    catch (e) {
      const message = (e as Error).message;
      return message === 'client request is no longer current'
        ? c.json({ error: message }, 409)
        : c.json({ error: message }, 500);
    }
  });

  // The caller's conversations (most recent first) for the session pickers in web chat and the CLI.
  app.get('/brain/sessions', async c => {
    if (!d.brain) return c.json([]);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    return c.json(d.brain.listSessions(c.get('user').id));
  });

  // Admin session-management panel: EVERY brain session the operator anchors — their own conversations
  // PLUS the platform channel (Discord) and task-worker sessions. Distinct base path from `/brain/sessions`
  // so `:id` below never captures "managed-sessions". Admin-only (channel/task sessions are shared state).
  app.get('/brain/managed-sessions', async c => {
    if (!d.brain) return c.json([]);
    if (forbidden(c) || !c.get('user').is_admin) return c.json({ error: 'forbidden' }, 403);
    return c.json(d.brain.listManagedSessions(c.get('user').id));
  });
  // Delete EVERYTHING (the panel's confirmed "delete all"). Registered before the `/:id` variant.
  app.delete('/brain/managed-sessions', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c) || !c.get('user').is_admin) return c.json({ error: 'forbidden' }, 403);
    return c.json({ deleted: d.brain.deleteAllManagedSessions(c.get('user').id) });
  });
  app.delete('/brain/managed-sessions/:id', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c) || !c.get('user').is_admin) return c.json({ error: 'forbidden' }, 403);
    return c.json({ deleted: d.brain.deleteManagedSession(c.get('user').id, c.req.param('id')) });
  });

  // Background processes (terminal plugin's `run_command(background:true)` children) — the panel next to
  // the todos lists them, reads output for the modal, and kills on demand. OWNER-only (not merely admin):
  // the underlying shell reads any absolute path — secrets, the config DB — exactly like the terminal tools
  // that spawn these (owner-only there). A second admin is admin-but-not-owner and must not see the buffers.
  const denyNonOwner = (c: { get: (k: 'tokenScope' | 'user') => unknown }): boolean =>
    forbidden(c as { get: (k: 'tokenScope') => string }) || !d.brain?.isOwner((c.get('user') as { id: number }).id);
  app.get('/brain/processes', c => {
    if (denyNonOwner(c)) return c.json({ error: 'forbidden' }, 403);
    return c.json(processRegistry.list());
  });
  app.get('/brain/processes/:id/output', c => {
    if (denyNonOwner(c)) return c.json({ error: 'forbidden' }, 403);
    const out = processRegistry.output(c.req.param('id'));
    return out === null ? c.json({ error: 'unknown process' }, 404) : c.json({ output: out });
  });
  app.delete('/brain/processes/:id', c => {
    if (denyNonOwner(c)) return c.json({ error: 'forbidden' }, 403);
    return c.json({ killed: processRegistry.kill(c.req.param('id')) });
  });

  // Fulltext search across the caller's own conversations (newest first). Queries under 2 chars
  // yield [] — the store enforces that, plus the ownership scoping.
  app.get('/brain/search', async c => {
    if (!d.brain) return c.json([]);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    return c.json(d.brain.searchMessages(c.get('user').id, c.req.query('q') ?? ''));
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

  app.patch('/brain/sessions/:id', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
    if (typeof body.title !== 'string') return c.json({ error: 'title must be a string' }, 400);
    try { return c.json(d.brain.renameSession(c.get('user').id, c.req.param('id'), body.title)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

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
    try {
      return c.json(session ? d.brain.messagesOf(c.get('user').id, session) : d.brain.history(c.get('user').id));
    } catch { return c.json({ error: 'unknown session' }, 404); }
  });

  // The pickable models across every configured brain provider — dedicated entries, connected OAuth
  // accounts, or the relay fallback (feeds the Account → CLI dropdown and the CLI /model picker).
  // Every item carries its exec spec (`elowen:<provider>/<model>`) so pickers, the users admin UI and
  // the settings catalog all speak the same identifier. Non-admins only see models their allow-list
  // permits — this single server-side filter covers web AND CLI.
  app.get('/brain/models', async c => {
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const cfg = brainConfigFromElowen(d.config, d.brainAuth);
    if (!cfg) return c.json([]);
    const models = (await listBrainModels(cfg)).map((m) => ({ ...m, exec: elowenExec(m.provider, m.model) }));
    const u = d.users ? c.get('user') : undefined;
    if (!u || u.is_admin) return c.json(models);
    const globalExecs = d.config.get().allowedExecs;
    return c.json(models.filter((m) => isExecAllowedForUser(u, globalExecs, m.exec)));
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
  app.post('/brain/abort', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const b = (await c.req.json().catch(() => ({}))) as { session?: unknown };
    try { await d.brain.abort(c.get('user').id, typeof b.session === 'string' ? b.session : undefined); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

  // Closing a session-bound client: abort its active run and dispose the live PI session only when no
  // other client is attached. Persisted history remains resumable.
  app.post('/brain/session/stop', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const { session, client, generation } = await parseBody(c, brainStopSchema);
    try { return c.json(await d.brain.stopSession(c.get('user').id, session, client, generation)); }
    catch (e) { return c.json({ error: (e as Error).message }, 404); }
  });

  // Switch the active conversation to another configured model (the /model picker). Existing event
  // streams die with the old session — clients reopen their stream after this call.
  app.post('/brain/model', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const { session, ...sel } = await parseBody(c, brainModelSchema);
    try { return c.json(await d.brain.switchModel(c.get('user').id, sel, session)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

  // Set the active conversation's reasoning effort live (the /think command) — no session rebuild.
  app.post('/brain/think', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const b = (await c.req.json().catch(() => ({}))) as { level?: unknown; session?: unknown };
    if (typeof b.level !== 'string') return c.json({ error: 'level must be a string' }, 400);
    try { return c.json(await d.brain.setThinkingLevel(c.get('user').id, b.level, typeof b.session === 'string' ? b.session : undefined)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

  // OpenAI OAuth priority service tier (`service_tier: priority`). Session-scoped and live, like YOLO;
  // unsupported providers are rejected instead of silently pretending Fast is active.
  app.post('/brain/fast', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const b = (await c.req.json().catch(() => ({}))) as { on?: unknown; session?: unknown };
    try { return c.json(d.brain.setFast(c.get('user').id, typeof b.on === 'boolean' ? b.on : undefined, typeof b.session === 'string' ? b.session : undefined)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

  // SESSION-scoped YOLO override (the CLI /yolo command): flips "ask" permission rules to auto-approve
  // for the caller's ACTIVE live conversation only (deny rules still deny). `on` absent → toggle the
  // current effective state. The persisted per-user default lives at /auth/me/permissions.
  app.post('/brain/yolo', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const b = (await c.req.json().catch(() => ({}))) as { on?: unknown; session?: unknown };
    try { return c.json(d.brain.setYolo(c.get('user').id, typeof b.on === 'boolean' ? b.on : undefined, typeof b.session === 'string' ? b.session : undefined)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

  // Manual context compaction (the /compact command in chat clients). Returns the fresh usage numbers
  // plus whether anything was compacted — a too-small/already-compacted session is a benign no-op
  // (200 with compacted:false), NOT an opaque 409, so clients show a friendly notice instead of a failure.
  app.post('/brain/compact', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const b = (await c.req.json().catch(() => ({}))) as { session?: unknown };
    try { return c.json(await d.brain.compact(c.get('user').id, typeof b.session === 'string' ? b.session : undefined)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

  // The published slash-command catalog for one surface + user — the SINGLE source of truth
  // (src/brain/slashCommands.ts). Every chat client renders its menu / registers its commands from this,
  // so a new command is added in one place and appears in CLI, Discord and the web dock at once.
  app.get('/brain/commands', async c => {
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const q = c.req.query('surface');
    const surface: SlashSurface = q === 'cli' || q === 'discord' || q === 'whatsapp' ? q : 'web';
    // Built-ins + any plugin-contributed prompt commands from the live registry (surface-scoped; a plugin
    // can never shadow a built-in — enforced both at registration and in commandsWithPlugins).
    const registry = await d.plugins?.get().catch(() => null);
    const pluginCommands = registry
      ? [...registry.commands.values()].map((cmd) => ({ ...cmd, plugin: registry.commandOwner.get(cmd.name) }))
      : [];
    return c.json({ commands: commandsWithPlugins(surface, !!c.get('user').is_admin, pluginCommands) });
  });

  // Execute a server-side (`action`) slash command through ONE dispatch path for every surface. Pickers
  // (`model`/`think`) and info (`status`/`help`) stay client-side (their own endpoints / rendering).
  app.post('/brain/command', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const user = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; session?: unknown; on?: unknown };
    const cmd = typeof body.name === 'string' ? findCommand(body.name) : undefined;
    if (!cmd || cmd.kind !== 'action') return c.json({ error: 'unknown command' }, 400);
    if (cmd.adminOnly && !user.is_admin) return c.json({ error: 'forbidden' }, 403);
    try {
      switch (cmd.name) {
        case 'stop': await d.brain.abort(user.id, typeof body.session === 'string' ? body.session : undefined); return c.json({ ok: true, message: 'Agent stopped.' });
        case 'new': return c.json({ ok: true, message: 'Started a fresh conversation.', data: await d.brain.start(user.id, { fresh: true }) });
        case 'compact': { const r = await d.brain.compact(user.id, typeof body.session === 'string' ? body.session : undefined); return c.json({ ok: true, message: r.compacted ? 'Conversation compacted.' : (r.message ?? 'Nothing to compact yet.'), data: { usage: r.usage } }); }
        case 'fast': {
          const r = d.brain.setFast(user.id, typeof body.on === 'boolean' ? body.on : undefined, typeof body.session === 'string' ? body.session : undefined);
          return c.json({ ok: true, message: `Fast mode ${r.fast ? 'enabled' : 'disabled'}.`, data: r });
        }
        case 'restart':
          if (!d.restartDaemon) return c.json({ error: 'restart is not available on this deployment' }, 501);
          await d.restartDaemon(user.id);
          return c.json({ ok: true, message: 'Restarting the Elowen daemon…' });
        case 'lsp': {
          const { toggleLsp } = await import('../../brain/tools/lspTools.js');
          const r = toggleLsp();
          // Persist the flip so a daemon restart keeps the operator's choice (bootstrap re-seeds from it).
          d.config.update({ lspEnabled: r.enabled });
          return c.json({ ok: true, message: r.message, data: { enabled: r.enabled } });
        }
        default: return c.json({ error: 'command is not server-dispatchable' }, 400);
      }
    } catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

  // LSP health at a glance: enabled?, any server running?, and a per-server installed/running row.
  // Read-only for every chat user (the toggle above stays admin-only) — drives the CLI /lsp modal and
  // any panel indicator. Dynamic import mirrors the command dispatch (the manager is a lazy singleton).
  app.get('/brain/lsp', async c => {
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const { lspManager } = await import('../../brain/tools/lspTools.js');
    return c.json(lspManager().status());
  });

  // Install a registry language server daemon-side (the /lsp modal's ctrl+i). Admin-only — it installs
  // software on the host. Only npm-canonical servers are self-installable; the rest 400 with their
  // toolchain's install hint so the CLI shows the exact command to run instead.
  app.post('/brain/lsp/install', async c => {
    if (forbidden(c) || !c.get('user').is_admin) return c.json({ error: 'forbidden' }, 403);
    const { command } = await parseBody(c, lspInstallSchema);
    const { listServers, commandExists } = await import('../../lsp/servers.js');
    const spec = listServers().find((s) => s.command === command);
    if (!spec) return c.json({ error: 'unknown language server' }, 404);
    if (commandExists(spec.command)) return c.json({ ok: true, message: `${spec.label} is already installed.` });
    if (!spec.npmPackages?.length) return c.json({ error: `${spec.label} ships with its toolchain — install it with: ${spec.installHint}` }, 400);
    const { npmInstallGlobal } = await import('../../lsp/install.js');
    const r = await npmInstallGlobal(spec.npmPackages);
    if (r.ok && commandExists(spec.command)) return c.json({ ok: true, message: `${spec.label} installed.` });
    // npm may "succeed" into a global bin dir that isn't on PATH — report honestly either way.
    return c.json({ error: r.ok ? `Installed, but ${spec.command} is not on PATH — check the npm global bin directory.` : `Install failed: ${r.detail}` }, 502);
  });

  // Uninstall a server from Elowen's own LSP prefix (the /lsp modal's ctrl+u). Admin-only, npm-managed
  // servers only; a live client for it is disposed first so nothing keeps running from a removed binary.
  app.post('/brain/lsp/uninstall', async c => {
    if (forbidden(c) || !c.get('user').is_admin) return c.json({ error: 'forbidden' }, 403);
    const { command } = await parseBody(c, lspInstallSchema);
    const { listServers, commandExists } = await import('../../lsp/servers.js');
    const spec = listServers().find((s) => s.command === command);
    if (!spec) return c.json({ error: 'unknown language server' }, 404);
    if (!spec.npmPackages?.length) return c.json({ error: `${spec.label} is not managed by Elowen — remove it with your toolchain (installed via: ${spec.installHint}).` }, 400);
    if (!commandExists(spec.command)) return c.json({ ok: true, message: `${spec.label} is not installed.` });
    const { lspManager } = await import('../../brain/tools/lspTools.js');
    lspManager().disposeAll(); // free any live client before its binary disappears
    const { npmUninstallGlobal } = await import('../../lsp/install.js');
    const r = await npmUninstallGlobal(spec.npmPackages);
    if (!r.ok) return c.json({ error: `Uninstall failed: ${r.detail}` }, 502);
    // Still resolvable afterwards = a system copy outside Elowen's prefix; say so instead of "removed".
    return c.json({ ok: true, message: commandExists(spec.command) ? `${spec.label} removed from Elowen's prefix — a system-installed copy remains on PATH.` : `${spec.label} uninstalled.` });
  });

  app.post('/brain/send', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const { text, images, mode, cwd, session, display, client, generation } = await parseBody(c, brainSendSchema);
    // `session` binds the turn to the caller's own explicit conversation (ownership-checked in send();
    // channel/task sessions rejected). Absent → the active conversation, exactly as before. `display` is
    // the clean text the daemon echoes back as the authoritative `user` turn (the client no longer echoes
    // optimistically); absent → the model-facing text is shown.
    const boundClient = session && client && generation ? { id: client, generation } : undefined;
    try { d.brain.preflightSend(c.get('user').id, session, boundClient); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); } // not started yet / unknown session
    // A model/tool turn can outlive nginx/SSH proxy request timeouts while its authoritative output is
    // already flowing over SSE. Wait only until the user row + stream echo are durable, then return 202.
    // A failure before that boundary is an HTTP error; a later failure is an ordered SSE error so an
    // attached TUI/headless client cannot silently lose an accepted prompt.
    const operation = d.brain.startSend({
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
        d.brain?.publishAcceptedSendFailure(admittedSession, error);
      } catch { /* pre-admission failure is returned by this request below */ }
    });
    try { await operation.admitted; }
    catch (error) {
      logger('brain-send').error('turn admission failed', error);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
    return c.json({ ok: true, accepted: true }, 202);
  });

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
  app.delete('/brain/queue/:id', c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    try { return c.json({ removed: d.brain.queueRemove(c.get('user').id, c.req.param('id'), c.req.query('session')) }); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  });

  // Answer a parked ask_user_question. Deliberately bypasses the per-turn send() lock (the parked turn
  // holds it) — it just resolves the registry Promise, so it never deadlocks. An unknown/expired id is a
  // tolerated no-op (matched:false) rather than an error, so a late double-click is harmless.
  app.post('/brain/answer', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const { id, answers } = await parseBody(c, brainAnswerSchema);
    const matched = d.brain.answerQuestion(id, answers, c.get('user').id); // owner route: only the caller's own question
    return c.json({ ok: true, matched });
  });

  // Goal routes: `session` (query on GET/action, body on POST) scopes the goal to the caller's own
  // bound conversation (the CLI); absent → the active one.
  app.get('/brain/goal', c => {
    if (!d.brain) return c.json(null);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    try { return c.json(d.brain.goalStatus(c.get('user').id, c.req.query('session'))); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  });

  app.post('/brain/goal', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; draft?: unknown; turnBudget?: unknown; session?: unknown };
    if (typeof body.text !== 'string') return c.json({ error: 'text must be a string' }, 400);
    const turnBudget = typeof body.turnBudget === 'number' && Number.isFinite(body.turnBudget) ? Math.max(1, Math.min(50, Math.floor(body.turnBudget))) : undefined;
    try { return c.json(await d.brain.setGoal(c.get('user').id, body.text, { draft: body.draft === true, turnBudget }, typeof body.session === 'string' ? body.session : undefined), 201); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

  app.post('/brain/goal/action', c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const action = c.req.query('action');
    if (action !== 'pause' && action !== 'resume' && action !== 'clear') return c.json({ error: 'unknown action' }, 400);
    try { return c.json(d.brain.goalAction(c.get('user').id, action, c.req.query('session'))); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  });

  app.post('/brain/subgoal', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { action?: unknown; text?: unknown; index?: unknown; session?: unknown };
    if (body.action !== 'add' && body.action !== 'remove' && body.action !== 'clear') return c.json({ error: 'unknown action' }, 400);
    try {
      const value = body.action === 'add' ? body.text : body.action === 'remove' ? body.index : undefined;
      return c.json(d.brain.subgoal(c.get('user').id, body.action, value as string | number | undefined, typeof body.session === 'string' ? body.session : undefined));
    } catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

  // The owner talking into a delegated sub-agent's session: steered into its running turn, or run as
  // a fresh turn when the child is idle. Fire-and-forget — the reply rides the tapped session stream
  // (an idle child's turn can take minutes; blocking the HTTP call on it would just time out).
  app.post('/brain/subagent/send', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const brain = d.brain;
    const body = await parseBody(c, subagentSendSchema);
    try { brain.messagesOf(c.get('user').id, body.session); } catch { return c.json({ error: 'unknown session' }, 404); }
    // Validate the durable child boundary before detaching the potentially minutes-long turn. Without this
    // preflight, a legacy child (no persisted scope) would reject inside the swallowed Promise and the
    // caller would receive a misleading `{ok:true}` with no continuation ever running.
    try { brain.preflightSubagentSend(c.get('user').id, body.session); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
    void brain.sendToSubagent(c.get('user').id, body.session, body.text).catch(() => { /* surfaced on the child's stream */ });
    return c.json({ ok: true });
  });

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
    return streamSSE(c, async stream => {
      let off: (() => void) | null = null;
      let ready = !withSnapshot;
      const pending: BrainEvent[] = [];
      let writes = Promise.resolve();
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
          // Snapshot writes are tiny/fast, but coalesce provider deltas defensively so a stalled socket
          // cannot retain one object per token before the first frame flushes. The helper replaces the
          // route-local tail instead of mutating replay's event shared with every concurrent stream.
          appendBufferedBrainEvent(pending, e, 2_048);
          return;
        }
        writeEvent(e);
      };
      let snapshot: ReturnType<typeof brain.tapSessionSnapshot>['snapshot'] | null = null;
      try {
        if (session && withSnapshot) {
          const attached = brain.tapSessionSnapshot(userId, session, deliver, clientId, clientGeneration);
          off = attached.off;
          snapshot = attached.snapshot;
        } else off = session
          ? brain.tapSession(userId, session, deliver, clientId, clientGeneration)
          : brain.subscribe(userId, deliver, clientId, clientGeneration);
      }
      catch { await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: session ? 'unknown session' : 'brain not started' }), event: 'error' }); return; }
      c.req.raw.signal.addEventListener('abort', off);
      if (snapshot) {
        writes = writes.then(() => stream.writeSSE({
          data: JSON.stringify(snapshot), event: 'snapshot', id: String(snapshot.cursor),
        })).catch(() => undefined);
        await writes;
        ready = true;
        for (const event of pending.splice(0)) writeEvent(event);
        await writes;
      }
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
