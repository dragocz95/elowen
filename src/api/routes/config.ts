import { streamSSE } from 'hono/streaming';
import { accessSync, constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { isNewer } from '../../cli/version.js';
import { handleMcpRequest } from '../../mcp/server.js';
import { eventProjectId } from '../eventProject.js';
import { ELOWEN_VERSION, ELOWEN_INSTALLED_AT, ELOWEN_PORT, defaultLatestVersion, defaultStartUpdate, defaultStartRestart } from '../version.js';
import { parseBody } from '../validation.js';
import { pushSubscribeSchema, pushUnsubscribeSchema, systemRestartSchema } from '../schemas/config.js';
import { resolveExecutor } from '../../overseer/routing.js';
import { DEFAULT_BINS, BARE_PLAIN_PROGRAM, parseElowenExec } from '../../shared/execs.js';
import type { ElowenEvent } from '../sse.js';
import type { ConfigPatch } from '../../store/configStore.js';
import type { ElowenApp, RouteContext } from '../context.js';
import { readSystemDiagnostics } from '../systemDiagnostics.js';

/** True when `bin` resolves to an executable on the daemon's PATH — the readiness check for a task exec
 *  that names an external agent CLI (the embedded `elowen:` engine skips this, it's always runnable). */
function binOnPath(bin: string): boolean {
  if (!bin) return false;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try { accessSync(join(dir, bin), constants.X_OK); return true; } catch { /* try the next PATH entry */ }
  }
  return false;
}

/** Whether a non-`elowen:` task exec spec names an installed agent CLI: resolve it to its program (the
 *  same routing the scheduler uses) and probe that program's binary on PATH. */
function execCliInstalled(spec: string, providers: Record<string, { bin: string }>): boolean {
  if (!spec) return false;
  const { program } = resolveExecutor([`exec:${spec}`], { program: BARE_PLAIN_PROGRAM, model: spec });
  // Honor a configured bin path (what the scheduler actually spawns — `elowen install` sets these) before
  // falling back to the program's default name. An absolute/relative path is probed directly; a bare name
  // is searched on PATH.
  const bin = providers[program]?.bin || (DEFAULT_BINS as Record<string, string>)[program];
  if (!bin) return false;
  return bin.includes('/') ? binExists(bin) : binOnPath(bin);
}

/** True when an absolute/relative binary path is executable (a configured `providers.<program>.bin`). */
function binExists(path: string): boolean { try { accessSync(path, constants.X_OK); return true; } catch { return false; } }

/** Daemon-wide surface: the stateless MCP endpoint, web-push key + per-user subscribe/unsubscribe,
 *  config read/write (admin-gated write), the System panel (version/update-available) and the live
 *  SSE event stream (per-subscriber tenancy gate). */
export function registerConfigRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d, accessibleProjects, eventDeps, skillService } = ctx;
  // MCP endpoint: the advisor agent connects here to control Elowen with native tools. Each request is
  // handled statelessly with the toolset bound to the caller's token, and every tool delegates to the
  // same `callElowenApi` core as the `elowen api` CLI verb — so a new REST endpoint needs zero edits here.
  app.all('/mcp', async c => {
    const token = c.get('token');
    return handleMcpRequest(c.req.raw, { url: `http://localhost:${ELOWEN_PORT}`, token });
  });

  // --- Web push: the browser's VAPID public key, plus per-user device subscribe/unsubscribe. The
  // public key is safe pre-auth (it's public); subscribe/unsubscribe are scoped to the authed user.
  app.get('/push/vapid-public-key', (c) => c.json({ publicKey: d.config.get().webPush.publicKey }));
  app.post('/push/subscribe', async (c) => {
    const u = c.get('user');
    if (!u) return c.json({ error: 'unauthorized' }, 401);
    const b = await parseBody(c, pushSubscribeSchema);
    d.pushSubscriptions?.upsert(u.id, { endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth } });
    return c.json({ ok: true }, 201);
  });
  app.post('/push/unsubscribe', async (c) => {
    const u = c.get('user');
    if (!u) return c.json({ error: 'unauthorized' }, 401);
    const b = await parseBody(c, pushUnsubscribeSchema);
    d.pushSubscriptions?.removeForUser(u.id, b.endpoint); // scoped: can only remove your own device
    return c.json({ ok: true });
  });

  app.get('/config', (c) => c.json(d.config.get()));
  app.put('/config', async (c) => {
    // Editing the daemon config is admin-only (the Administration surface); reads stay open so the
    // app can populate model pickers etc. During setup (no users yet) it's open so onboarding can
    // save providers/the API key before the first admin exists.
    if (d.users && d.users.count() > 0) { const u = c.get('user'); if (!u || !d.users.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403); }
    const patch = await c.req.json() as ConfigPatch;
    const updated = d.config.update(patch);
    // Apply a patched LSP toggle to the live manager too — it otherwise reads the flag only at boot,
    // and a config-only write would leave the runtime out of sync until the next restart.
    if (typeof patch.lspEnabled === 'boolean') {
      const { lspManager } = await import('../../brain/tools/lspTools.js');
      lspManager().setEnabled(patch.lspEnabled);
    }
    return c.json(updated);
  });

  // System panel: the running version, the latest published one, whether an update is available, and
  // the auto-update opt-in. Read-only and cheap (the registry lookup is cached), so any authed user
  // may see it (non-admins still can't trigger the update below).
  app.get('/system', async (c) => {
    const latest = await (d.latestVersion ?? defaultLatestVersion)();
    return c.json({
      version: ELOWEN_VERSION,
      latest,
      updateAvailable: latest ? isNewer(latest, ELOWEN_VERSION) : false,
      autoUpdate: d.config.get().autoUpdate,
      lastUpdatedAt: ELOWEN_INSTALLED_AT,
      diagnostics: readSystemDiagnostics(),
    });
  });

  // First-run readiness: one row per subsystem, so the onboarding UI can show at a glance what actually
  // works after `elowen setup`. Read-only, derived purely from config + the BrainService helper (ONE source
  // of truth for "chat is runnable"), never gated behind a running mission. Admin-only (mirrors the
  // admin /system/* routes below).
  app.get('/system/readiness', (c) => {
    if (d.users && d.users.count() > 0) { const u = c.get('user'); if (!u || !d.users.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403); }
    const cfg = d.config.get();
    const checks: Array<{ id: string; label: string; ok: boolean; detail: string; hint?: string }> = [];

    // chat — the embedded brain must resolve a model to answer at all.
    const model = d.brain?.resolvableModel() ?? null;
    checks.push({ id: 'chat', label: 'Chat', ok: model != null, detail: model ?? 'no provider',
      ...(model ? {} : { hint: 'Run `elowen setup` to connect an AI provider.' }) });

    // tasks — the embedded `elowen:` engine is always runnable; any other exec must name an installed CLI.
    const exec = cfg.defaults.exec;
    const elowenSpec = parseElowenExec(exec); // embedded engine: runnable iff the provider it names still exists
    const tasksOk = elowenSpec ? cfg.brain.providers.some((pr) => pr.id === elowenSpec.provider) : execCliInstalled(exec, cfg.providers);
    checks.push({ id: 'tasks', label: 'Tasks', ok: tasksOk, detail: exec || 'not set',
      ...(tasksOk ? {} : { hint: elowenSpec ? 'The provider its executor points at is gone — re-run `elowen setup`.' : 'The setup wizard points this at the built-in engine — re-run `elowen setup`.' }) });

    // missions — the planner/overseer need either the OpenAI-compatible relay or a configured pilot CLI.
    const relay = d.config.autopilotRelay();
    const missionsOk = relay != null || cfg.autopilot.pilotExec.length > 0;
    checks.push({ id: 'missions', label: 'Missions', ok: missionsOk,
      detail: relay ? 'relay configured' : (cfg.autopilot.pilotExec || 'not set'),
      ...(missionsOk ? {} : { hint: 'Missions need an OpenAI-compatible key or an installed agent CLI.' }) });

    // memory — optional; enabled when an embedding provider is referenced.
    const memoryConfigured = cfg.embedding.providerId.length > 0; // optional feature → always ok, like platforms
    checks.push({ id: 'memory', label: 'Memory', ok: true, detail: memoryConfigured ? (cfg.embedding.model || 'enabled') : 'disabled (optional)',
      ...(memoryConfigured ? {} : { hint: 'Optional — enable memory in `elowen setup` or Settings → Brain.' }) });

    // platforms — informational: which messaging plugins are enabled.
    const messaging = ['discord', 'whatsapp'].filter((p) => cfg.plugins.enabled.includes(p));
    checks.push({ id: 'platforms', label: 'Platforms', ok: true, detail: messaging.length ? messaging.join(', ') : 'none',
      hint: 'Connect Discord or WhatsApp in Settings → Plugins.' });

    // plugins — informational: the enabled tool plugins.
    checks.push({ id: 'plugins', label: 'Plugins', ok: true, detail: cfg.plugins.enabled.length ? cfg.plugins.enabled.join(', ') : 'none' });

    return c.json({ checks });
  });

  // Agent-workflow skill status + manual (re)install across the installed providers. Admin-only (mirrors
  // /system/update); the daemon also self-installs on startup, so this is the on-demand re-apply + verify.
  // No mission gate — writing a skill file doesn't disturb running agents (they read it at their next start).
  app.get('/system/skills', (c) => {
    if (d.users && d.users.count() > 0) { const u = c.get('user'); if (!u || !d.users.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403); }
    return c.json({ skills: skillService.status() });
  });
  app.post('/system/skills/install', (c) => {
    if (d.users && d.users.count() > 0) { const u = c.get('user'); if (!u || !d.users.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403); }
    return c.json({ results: skillService.installAll() });
  });

  // Trigger a manual in-place update. Admin-only (mirrors /config) and refused while a mission is live
  // — the update restarts the services, which would kill the running agent sessions.
  app.post('/system/update', (c) => {
    if (d.users && d.users.count() > 0) { const u = c.get('user'); if (!u || !d.users.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403); }
    if (d.missions.live().length > 0) return c.json({ error: 'mission_running' }, 409);
    (d.startUpdate ?? defaultStartUpdate)();
    return c.json({ started: true });
  });

  // Restart one of the two systemd units on demand. Admin-only (mirrors /system/update). The response
  // goes out BEFORE the restart fires: restarting elowen-daemon kills this very process, so the detached
  // `systemctl restart --no-block` spawn is deferred a beat and PID 1 owns the actual restart.
  app.post('/system/restart', async (c) => {
    if (d.users && d.users.count() > 0) { const u = c.get('user'); if (!u || !d.users.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403); }
    const b = await parseBody(c, systemRestartSchema);
    setTimeout(() => (d.startRestart ?? defaultStartRestart)(b.target), 100);
    return c.json({ ok: true });
  });

  app.get('/events', c => streamSSE(c, async stream => {
    // Per-subscriber tenancy gate: admin/open mode (null) streams everything; a tenant receives only
    // events in its projects. An event with no resolvable project is withheld from tenants — fail closed.
    const allowed = accessibleProjects(c);
    const visible = (e: ElowenEvent): boolean => {
      if (!allowed) return true;
      const pid = eventProjectId(e, eventDeps);
      return pid !== null && allowed.has(pid);
    };
    const off = d.bus.subscribe(e => { if (visible(e)) void stream.writeSSE({ data: JSON.stringify(e), event: e.type }); });
    c.req.raw.signal.addEventListener('abort', off);
    // Flush an immediate comment: a streamed response sends no HTTP headers until the first body byte,
    // so through the web BFF proxy the live channel would never connect on a quiet system. Comments
    // (lines starting with ':') are ignored by EventSource. The periodic ping doubles as a keep-alive
    // that stops reverse proxies from idle-closing the stream.
    await stream.write(': connected\n\n');
    while (!c.req.raw.signal.aborted) {
      await stream.sleep(30000);
      if (c.req.raw.signal.aborted) break;
      await stream.write(': ping\n\n');
    }
  }));
}
