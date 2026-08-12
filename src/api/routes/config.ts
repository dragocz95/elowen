import { streamSSE } from 'hono/streaming';
import { accessSync, constants, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, delimiter } from 'node:path';
import { resolveBrand } from '../../shared/brand.js';
import { THEME_ASSET_FILES, ASSET_MAX_BYTES, activeThemeName, type ThemeAssetFile } from '../../store/themeStore.js';
import { isNewer } from '../../cli/version.js';
import { handleMcpRequest } from '../../mcp/server.js';
import { eventProjectId } from '../eventProject.js';
import { ELOWEN_VERSION, ELOWEN_INSTALLED_AT, ELOWEN_PORT, defaultLatestVersion, defaultStartUpdate, defaultStartRestart } from '../version.js';
import { parseBody, queryInt } from '../validation.js';
import { LOG_DIR, logger } from '../../shared/logger.js';
import { listLogFiles, readLogFile, deleteLogFile, deleteAllLogFiles, DEFAULT_LOG_TAIL_LINES, MAX_LOG_TAIL_LINES } from '../../integrations/logFiles.js';
import { pushSubscribeSchema, pushUnsubscribeSchema, systemRestartSchema, configPatchSchema } from '../schemas/config.js';
import { resolveExecutor } from '../../shared/execRouting.js';
import { DEFAULT_BINS, BARE_PLAIN_PROGRAM, parseElowenExec } from '../../shared/execs.js';
import type { ElowenEvent } from '../sse.js';
import type { ElowenApp, RouteContext } from '../context.js';
import { readSystemDiagnostics } from '../systemDiagnostics.js';
import { webhookProxyStatus } from '../webhookProxy.js';
import { BUILTIN_TOOL_DEFER_LOADING, BUILTIN_TOOL_PLAN_SAFE, builtinToolMetas } from '../../brain/tools/index.js';
import { buildExitPlanModeTool } from '../../brain/tools/exitPlanMode.js';
import {
  isDeferrable,
  resolveToolDeferralDecisions,
  type ToolDeferralCandidate,
  type ToolDeferralReason,
} from '../../brain/toolSearch/deferralPolicy.js';
import type { PluginRegistry } from '../../plugins/registry.js';
import type { RuntimeConfig, ToolLoadingMode } from '../../shared/wireContract.js';

export interface ToolDeferralGroup {
  sourceId: string;
  label: string;
  kind: 'plugin' | 'builtin';
  override: ToolLoadingMode | null;
  tools: Array<{
    name: string;
    label: string;
    description?: string;
    eligible: boolean;
    lockedReason: 'never-defer' | 'plan-safe' | null;
    defaultMode: ToolLoadingMode;
    override: ToolLoadingMode | null;
    effective: ToolLoadingMode;
    reason: ToolDeferralReason;
  }>;
}

type CatalogTool = { name: string; label: string; description?: string };

function matchesPattern(name: string, pattern: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

function humanLabel(name: string): string {
  const spaced = name.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Build the UI catalog from the live registry, but resolve every effective mode through the same policy
 *  function session composition uses. Security locks therefore remain server-owned and cannot drift in web. */
export function buildToolDeferralCatalog(registry: PluginRegistry | undefined, runtime: RuntimeConfig): ToolDeferralGroup[] {
  const bySource = new Map<string, { label: string; kind: 'plugin' | 'builtin'; tools: CatalogTool[] }>();
  const add = (sourceId: string, label: string, kind: 'plugin' | 'builtin', tool: CatalogTool): void => {
    const group = bySource.get(sourceId) ?? { label, kind, tools: [] };
    if (!group.tools.some((item) => item.name === tool.name)) group.tools.push(tool);
    bySource.set(sourceId, group);
  };

  for (const tool of registry?.tools ?? []) {
    const owner = registry?.toolOwner.get(tool.name);
    const description = typeof tool.description === 'string' ? tool.description : undefined;
    add(owner ? `plugin:${owner}` : 'builtin', owner ? humanLabel(owner) : 'Built-in', owner ? 'plugin' : 'builtin', {
      name: tool.name,
      label: tool.label ?? tool.name,
      ...(description ? { description } : {}),
    });
  }

  for (const tool of builtinToolMetas()) add('builtin', 'Built-in', 'builtin', tool);
  const exitPlanMode = buildExitPlanModeTool();
  add('builtin', 'Built-in', 'builtin', {
    name: exitPlanMode.name,
    label: exitPlanMode.label ?? exitPlanMode.name,
    ...(typeof exitPlanMode.description === 'string' ? { description: exitPlanMode.description } : {}),
  });
  // Exact core-default names whose live definition may be absent in this process (a PI/provider integration
  // or a marketplace plugin — image-gen/image-edit — that isn't installed here). Keep them configurable, but
  // ONLY as a 'builtin' fallback when the registry doesn't already know their owning plugin. When the plugin
  // IS installed the tool is already grouped under its `plugin:<owner>` source above; adding it here too
  // would duplicate it across two groups and diverge from the runtime, which owns loading via the same list
  // yet keeps the override namespace on the owner (see capabilities.toolDeferralCandidates).
  for (const pattern of BUILTIN_TOOL_DEFER_LOADING) {
    if (!pattern.endsWith('*') && !registry?.toolOwner.has(pattern)) {
      add('builtin', 'Built-in', 'builtin', { name: pattern, label: humanLabel(pattern) });
    }
  }

  const sourceEntries = [...bySource.entries()].sort(([a], [b]) => {
    if (a === 'builtin') return 1;
    if (b === 'builtin') return -1;
    return a.localeCompare(b);
  });
  for (const [, group] of sourceEntries) group.tools.sort((a, b) => a.name.localeCompare(b.name));

  const candidates: ToolDeferralCandidate[] = sourceEntries.flatMap(([sourceId, group]) => group.tools.map((tool) => ({
    name: tool.name,
    sourceId,
    planSafe: sourceId === 'builtin' ? BUILTIN_TOOL_PLAN_SAFE.includes(tool.name) : (registry?.toolPlanSafe.has(tool.name) ?? false),
    // Mirror the runtime default exactly (capabilities.toolDeferralCandidates): a name is deferred-by-default
    // if its manifest opted in OR it's a core BUILTIN_TOOL_DEFER_LOADING name — regardless of whether the
    // owner is a plugin. That's what keeps a plugin-owned image tool showing 'deferred' here as it runs.
    defaultDeferred: (registry?.toolDeferLoading.has(tool.name) ?? false)
      || BUILTIN_TOOL_DEFER_LOADING.some((pattern) => matchesPattern(tool.name, pattern)),
  })));
  const decisions = new Map(resolveToolDeferralDecisions(candidates, runtime.toolDeferralOverrides, {
    enabled: runtime.toolDeferralEnabled,
    threshold: runtime.limits.toolDeferThreshold,
  }).map((decision) => [decision.name, decision]));
  const candidateByName = new Map(candidates.map((candidate) => [candidate.name, candidate]));

  return sourceEntries.map(([sourceId, group]) => ({
    sourceId,
    label: group.label,
    kind: group.kind,
    override: runtime.toolDeferralOverrides.sources[sourceId] ?? null,
    tools: group.tools.map((tool) => {
      const candidate = candidateByName.get(tool.name)!;
      const decision = decisions.get(tool.name)!;
      const lockedReason = !isDeferrable(tool.name) ? 'never-defer' : candidate.planSafe ? 'plan-safe' : null;
      return {
        ...tool,
        eligible: lockedReason === null,
        lockedReason,
        defaultMode: candidate.defaultDeferred ? 'deferred' : 'immediate',
        override: runtime.toolDeferralOverrides.tools[sourceId]?.[tool.name] ?? null,
        effective: decision.effective,
        reason: decision.reason,
      };
    }),
  }));
}

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
  const { d, accessibleProjects, eventDeps, notAdminUnlessSetup, notAdmin } = ctx;
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

  // --- White-label brand. The public payload is what the web shell (including the pre-auth login
  // screen) renders itself from: validated presentation data only, never secrets. Served even with no
  // theme active so the client never has to branch on existence — it then carries the built-in brand.
  const publicThemePayload = (): {
    brand: { agentName: string; productName: string };
    colors: Record<string, string>;
    fonts: { sans?: string; mono?: string };
    text: Record<string, Record<string, string>>;
    assets: Partial<Record<'logo' | 'icon' | 'icon192' | 'icon512', string>>;
    v: string;
  } => {
    const active = activeThemeName();
    const theme = active ? d.themes?.get(active) ?? null : null;
    const brand = resolveBrand(d.config.get(), theme?.manifest.brand ?? null, active);
    const assetKey: Record<ThemeAssetFile, 'logo' | 'icon' | 'icon192' | 'icon512'> = {
      'logo.png': 'logo', 'icon.png': 'icon', 'icon-192.png': 'icon192', 'icon-512.png': 'icon512',
    };
    const assets: Partial<Record<'logo' | 'icon' | 'icon192' | 'icon512', string>> = {};
    for (const file of theme?.assets ?? []) {
      assets[assetKey[file]] = `/public/theme/assets/${file}?v=${theme!.version}`;
    }
    return {
      brand: { agentName: brand.agentName, productName: brand.productName },
      colors: theme?.manifest.colors ?? {},
      fonts: theme?.manifest.fonts ?? {},
      text: theme?.manifest.text ?? {},
      assets,
      v: theme ? theme.version : 'builtin',
    };
  };
  // The only unauthenticated route touching both the config DB and the filesystem, so it must not be
  // free to hammer: a short shared max-age plus an ETag (hash of the exact payload — `v` alone would
  // miss a persona rename with no theme active) lets browsers and any fronting proxy absorb repeats.
  app.get('/public/theme', (c) => {
    const payload = publicThemePayload();
    const etag = `"${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)}"`;
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, { etag });
    return c.json(payload, 200, { etag, 'cache-control': 'public, max-age=60' });
  });
  // Unauthenticated route serving up-to-2 MiB files: the bytes are cached in memory keyed by the asset's
  // mtime so a request flood cannot grind the event loop with repeated disk reads. Bounded by the fixed
  // whitelist (4 entries max); a swapped file changes the mtime and naturally evicts its stale bytes.
  const assetBytesCache = new Map<string, { mtimeMs: number; bytes: Uint8Array<ArrayBuffer> }>();
  app.get('/public/theme/assets/:file', (c) => {
    const active = activeThemeName();
    const file = c.req.param('file');
    // Whitelist check before any filesystem access; only the ACTIVE theme's assets are ever served, so
    // this route enumerates nothing and a stale URL after a theme switch turns into a plain 404.
    if (!active || !(THEME_ASSET_FILES as readonly string[]).includes(file)) return c.json({ error: 'not found' }, 404);
    // The response below is `immutable` for a year, which is only honest if a versioned URL can never
    // change meaning. A `?v=` from a DIFFERENT theme generation (stale tab after a switch, shared cache
    // replay) must therefore 404 instead of silently binding the old URL to the new theme's bytes.
    const requestedV = c.req.query('v');
    if (requestedV !== undefined && requestedV !== d.themes?.get(active)?.version) return c.json({ error: 'not found' }, 404);
    const asset = d.themes?.resolveAsset(active, file);
    if (!asset) return c.json({ error: 'not found' }, 404);
    try {
      const key = `${active}/${file}`;
      let cached = assetBytesCache.get(key);
      if (!cached || cached.mtimeMs !== asset.mtimeMs) {
        const bytes = new Uint8Array(readFileSync(asset.path));
        // Re-check AFTER the read: the stat-time size limit is advisory (TOCTOU) — a file grown between
        // stat and read would otherwise be buffered, cached and served whole.
        if (bytes.byteLength > ASSET_MAX_BYTES) return c.json({ error: 'not found' }, 404);
        cached = { mtimeMs: asset.mtimeMs, bytes };
        if (assetBytesCache.size > 8) assetBytesCache.clear(); // theme switch left stale keys behind
        assetBytesCache.set(key, cached);
      }
      // `immutable` is safe because every served URL carries the theme-version query param — new bytes
      // arrive under a new URL. `nosniff` because the bytes are operator-supplied.
      return c.body(cached.bytes, 200, {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      });
    } catch { return c.json({ error: 'not found' }, 404); }
  });
  app.get('/config', (c) => c.json(d.config.get()));
  app.get('/config/tool-deferral', async (c) => {
    if (notAdminUnlessSetup(c)) return c.json({ error: 'forbidden' }, 403);
    const registry = await d.plugins?.get();
    return c.json(buildToolDeferralCatalog(registry, d.config.get().runtime));
  });
  // Live brand re-apply, collapsed to at most one running + one trailing sweep: every qualifying save
  // needs the change APPLIED, but N rapid saves do not need N instance-wide restarts — the trailing run
  // re-reads the fresh config and covers them all. Matters because a full sweep re-warms every session's
  // prompt cache, and in setup mode (no users yet) the PUT is reachable unauthenticated, so an unbounded
  // queue would be a cheap DoS. Failures go through the logger so they reach the /system/logs files.
  let brandChangeRunning = false;
  let brandChangeQueued = false;
  const queueBrandChange = (): void => {
    if (brandChangeRunning) { brandChangeQueued = true; return; }
    brandChangeRunning = true;
    void (async () => {
      try {
        do { brandChangeQueued = false; await d.brain?.applyBrandChange(); } while (brandChangeQueued);
      } catch (e) {
        logger('config').warn(`live brand re-apply failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally { brandChangeRunning = false; }
    })();
  };
  app.put('/config', async (c) => {
    // Editing the daemon config is admin-only (the Administration surface); reads stay open so the
    // app can populate model pickers etc. During setup (no users yet) it's open so onboarding can
    // save providers/the API key before the first admin exists.
    if (notAdminUnlessSetup(c)) return c.json({ error: 'forbidden' }, 403);
    const patch = await parseBody(c, configPatchSchema);
    const before = d.config.get();
    const updated = d.config.update(patch);
    // Apply a patched LSP toggle to the live manager too — it otherwise reads the flag only at boot,
    // and a config-only write would leave the runtime out of sync until the next restart.
    if (typeof patch.lspEnabled === 'boolean') {
      const { lspManager } = await import('../../brain/tools/lspTools.js');
      lspManager().setEnabled(patch.lspEnabled);
    }
    // A persona rename sits at the very top of every live system prompt. Respawn live sessions so the
    // chat does not keep speaking as the old name while the UI shows the new one. Fire-and-forget for
    // the same reason cli-settings does it: restart waits for in-flight turns, and the save response
    // must not hang on that. (A theme switch needs no sweep: ELOWEN_THEME only changes with a restart.)
    if (updated.brain.agentName !== before.brain.agentName) queueBrandChange();
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
  app.get('/system/readiness', async (c) => {
    if (notAdminUnlessSetup(c)) return c.json({ error: 'forbidden' }, 403);
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

    // Plugin-contributed rows slot in here (where the extracted 'missions' check used to sit): the
    // agents plugin reports missions readiness while enabled; a disabled plugin's checks disappear
    // with it — which is itself the honest first-run answer. A throwing check is dropped, never a 500.
    const registry = await d.plugins?.get();
    for (const { fn } of registry?.readinessChecks ?? []) {
      try {
        const check = await fn();
        if (check) checks.push(check);
      } catch { /* a broken plugin check must not take down the readiness report */ }
    }

    // memory — optional; enabled when an embedding provider is referenced.
    const memoryConfigured = cfg.embedding.providerId.length > 0; // optional feature → always ok, like platforms
    checks.push({ id: 'memory', label: 'Memory', ok: true, detail: memoryConfigured ? (cfg.embedding.model || 'enabled') : 'disabled (optional)',
      ...(memoryConfigured ? {} : { hint: 'Optional — enable memory in `elowen setup` or Settings → Brain.' }) });

    // platforms — informational: which messaging plugins are enabled.
    const messaging = ['discord', 'msteams', 'whatsapp', 'telegram'].filter((p) => cfg.plugins.enabled.includes(p));
    checks.push({ id: 'platforms', label: 'Platforms', ok: true, detail: messaging.length ? messaging.join(', ') : 'none',
      hint: 'Connect Discord, Microsoft Teams, WhatsApp or Telegram in Settings → Plugins.' });

    // webhooks — only when an enabled plugin exposes an inbound webhook (/hooks/*): a vhost provisioned
    // before the route existed never gets it from `elowen update` (the updater runs as the service user
    // and cannot touch /etc), so verify the managed proxy actually forwards /hooks/ and hand out the fix.
    if (registry && registry.httpRoutes.size > 0) {
      const proxy = webhookProxyStatus();
      if (proxy) {
        checks.push({ id: 'webhooks', label: 'Webhooks', ok: proxy.routesHooks,
          detail: proxy.routesHooks ? `${proxy.path} routes /hooks/` : `${proxy.path} does not route /hooks/`,
          ...(proxy.routesHooks ? {} : { hint: 'Add a /hooks/ location proxying to the daemon port (see the Deployment guide), or re-run `sudo elowen setup` to regenerate the vhost.' }) });
      }
    }

    // plugins — informational: the enabled tool plugins.
    checks.push({ id: 'plugins', label: 'Plugins', ok: true, detail: cfg.plugins.enabled.length ? cfg.plugins.enabled.join(', ') : 'none' });

    return c.json({ checks });
  });

  // Trigger a manual in-place update. Admin-only (mirrors /config) and refused while a mission is live
  // — the update restarts the services, which would kill the running agent sessions.
  app.post('/system/update', (c) => {
    if (notAdminUnlessSetup(c)) return c.json({ error: 'forbidden' }, 403);
    if (d.missions.live().length > 0) return c.json({ error: 'mission_running' }, 409);
    (d.startUpdate ?? defaultStartUpdate)();
    return c.json({ started: true });
  });

  // Restart one of the two systemd units on demand. Admin-only (mirrors /system/update). The response
  // goes out BEFORE the restart fires: restarting elowen-daemon kills this very process, so the detached
  // `systemctl restart --no-block` spawn is deferred a beat and PID 1 owns the actual restart.
  app.post('/system/restart', async (c) => {
    if (notAdminUnlessSetup(c)) return c.json({ error: 'forbidden' }, 403);
    const b = await parseBody(c, systemRestartSchema);
    setTimeout(() => (d.startRestart ?? defaultStartRestart)(b.target), 100);
    return c.json({ ok: true });
  });

  // The daily log files (daemon + web) behind Settings → Data → Logs. Admin-only via `notAdmin`, NOT the
  // setup-tolerant gate the routes above use: logs carry live operational detail, so they must not be
  // readable during first-run onboarding when no admin exists yet.
  app.get('/system/logs', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    return c.json({ dir: LOG_DIR, files: listLogFiles() });
  });

  app.get('/system/logs/:name', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const lines = queryInt(c.req.query('lines'), { min: 1, max: MAX_LOG_TAIL_LINES, fallback: DEFAULT_LOG_TAIL_LINES });
    const result = readLogFile(c.req.param('name'), lines);
    if (result.ok) return c.json(result.content);
    if (result.reason === 'invalid') return c.json({ error: 'invalid log file' }, 400);
    if (result.reason === 'too-large') return c.json({ error: 'log file too large' }, 413);
    return c.json({ error: 'log file not found' }, 404);
  });

  app.delete('/system/logs/:name', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const result = deleteLogFile(c.req.param('name'));
    if (result.ok) return c.json({ deleted: 1 });
    return c.json({ error: result.reason === 'invalid' ? 'invalid log file' : 'log file not found' }, result.reason === 'invalid' ? 400 : 404);
  });

  app.delete('/system/logs', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    return c.json({ deleted: deleteAllLogFiles() });
  });

  app.get('/events', c => streamSSE(c, async stream => {
    // Per-subscriber tenancy gate: admin/open mode (null) streams everything; a tenant receives only
    // events in its projects. An event with no resolvable project is withheld from tenants — fail closed.
    const allowed = accessibleProjects(c);
    // Absent when auth is disabled entirely (open mode) — there is exactly one identity then, and the
    // gate below already streams everything, so a memory nudge is not scoped either.
    const subscriber = c.get('user');
    const visible = (e: ElowenEvent): boolean => {
      // A memory nudge belongs to exactly one user, and memories are private per user — so it is scoped by
      // owner rather than by project, and an admin does not get another user's. Checked before the project
      // gate, which would withhold it from every tenant (a memory event resolves to no project).
      if (e.type === 'memory') return !subscriber || e.userId === subscriber.id;
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
