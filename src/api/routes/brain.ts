import { streamSSE } from 'hono/streaming';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBody } from '../validation.js';
import { brainStartSchema, brainSendSchema, brainModelSchema, brainAnswerSchema } from '../schemas/brain.js';
import { brainConfigFromOrca } from '../../brain/config.js';
import { listBrainModels, fetchOpenAiModels } from '../../brain/models.js';
import { orcaExec, isExecAllowedForUser } from '../../shared/execs.js';
import type { BrainEvent } from '../../brain/events.js';
import { commandsWithPlugins, findCommand, type SlashSurface } from '../../brain/slashCommands.js';
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
    // Live LSP diagnostics state (the `/lsp` toggle's source of truth) so chat clients can show it.
    const { lspEnabled } = await import('../../brain/tools/lspTools.js');
    return c.json({ ...d.brain.status(c.get('user').id), statusline, lspEnabled: lspEnabled() });
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
  // Every item carries its exec spec (`orca:<provider>/<model>`) so pickers, the users admin UI and
  // the settings catalog all speak the same identifier. Non-admins only see models their allow-list
  // permits — this single server-side filter covers web AND CLI.
  app.get('/brain/models', async c => {
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const cfg = brainConfigFromOrca(d.config, d.brainAuth);
    if (!cfg) return c.json([]);
    const models = (await listBrainModels(cfg)).map((m) => ({ ...m, exec: orcaExec(m.provider, m.model) }));
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

  // Set the active conversation's reasoning effort live (the /think command) — no session rebuild.
  app.post('/brain/think', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const b = (await c.req.json().catch(() => ({}))) as { level?: unknown };
    if (typeof b.level !== 'string') return c.json({ error: 'level must be a string' }, 400);
    try { return c.json(await d.brain.setThinkingLevel(c.get('user').id, b.level)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

  // Manual context compaction (the /compact command in chat clients). Returns the fresh usage numbers
  // plus whether anything was compacted — a too-small/already-compacted session is a benign no-op
  // (200 with compacted:false), NOT an opaque 409, so clients show a friendly notice instead of a failure.
  app.post('/brain/compact', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    try { return c.json(await d.brain.compact(c.get('user').id)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

  // The published slash-command catalog for one surface + user — the SINGLE source of truth
  // (src/brain/slashCommands.ts). Every chat client renders its menu / registers its commands from this,
  // so a new command is added in one place and appears in CLI, Discord and the web dock at once.
  app.get('/brain/commands', async c => {
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const q = c.req.query('surface');
    const surface: SlashSurface = q === 'cli' || q === 'discord' ? q : 'web';
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
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const cmd = typeof body.name === 'string' ? findCommand(body.name) : undefined;
    if (!cmd || cmd.kind !== 'action') return c.json({ error: 'unknown command' }, 400);
    if (cmd.adminOnly && !user.is_admin) return c.json({ error: 'forbidden' }, 403);
    try {
      switch (cmd.name) {
        case 'stop': await d.brain.abort(user.id); return c.json({ ok: true, message: 'Agent stopped.' });
        case 'new': return c.json({ ok: true, message: 'Started a fresh conversation.', data: await d.brain.start(user.id, { fresh: true }) });
        case 'compact': { const r = await d.brain.compact(user.id); return c.json({ ok: true, message: r.compacted ? 'Conversation compacted.' : (r.message ?? 'Nothing to compact yet.'), data: { usage: r.usage } }); }
        case 'restart':
          if (!d.restartDaemon) return c.json({ error: 'restart is not available on this deployment' }, 501);
          await d.restartDaemon(user.id);
          return c.json({ ok: true, message: 'Restarting the Orca daemon…' });
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

  app.post('/brain/send', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const { text, images, mode } = await parseBody(c, brainSendSchema);
    try { await d.brain.send(c.get('user').id, text, images, mode); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); } // not started yet
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

  app.get('/brain/goal', c => {
    if (!d.brain) return c.json(null);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    return c.json(d.brain.goalStatus(c.get('user').id));
  });

  app.post('/brain/goal', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; draft?: unknown; turnBudget?: unknown };
    if (typeof body.text !== 'string') return c.json({ error: 'text must be a string' }, 400);
    const turnBudget = typeof body.turnBudget === 'number' && Number.isFinite(body.turnBudget) ? Math.max(1, Math.min(50, Math.floor(body.turnBudget))) : undefined;
    try { return c.json(await d.brain.setGoal(c.get('user').id, body.text, { draft: body.draft === true, turnBudget }), 201); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

  app.post('/brain/goal/action', c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const action = c.req.query('action');
    if (action !== 'pause' && action !== 'resume' && action !== 'clear') return c.json({ error: 'unknown action' }, 400);
    return c.json(d.brain.goalAction(c.get('user').id, action));
  });

  app.post('/brain/subgoal', async c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { action?: unknown; text?: unknown; index?: unknown };
    if (body.action !== 'add' && body.action !== 'remove' && body.action !== 'clear') return c.json({ error: 'unknown action' }, 400);
    try {
      const value = body.action === 'add' ? body.text : body.action === 'remove' ? body.index : undefined;
      return c.json(d.brain.subgoal(c.get('user').id, body.action, value as string | number | undefined));
    } catch (e) { return c.json({ error: (e as Error).message }, 409); }
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
