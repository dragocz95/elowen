import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { discoverPlugins } from '../../../plugins/loader.js';
import { isPluginAllowedForUser } from '../../../shared/pluginAccess.js';
import type { PluginAccessUser } from '../../../shared/pluginAccess.js';
import type { PluginConfigField } from '../../../plugins/manifest.js';
import { CONSENT_REQUIRED_MUTATES } from '../../../plugins/api.js';
import { buildContributionReport, emptyContributionReport, pluginContributions } from '../../../plugins/contributionReport.js';
import { MarketplaceError } from '../../../plugins/marketplace.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context } from 'hono';
import type { ElowenApp, RouteContext } from '../../context.js';
import { registerBrainOAuthRoutes } from './oauth.js';

/** Apply a config patch to the stored values, by the ONE rule both config forms follow: a key the caller
 *  did not send is left alone, an explicit `null` clears a non-secret back to its default, and a secret
 *  arriving empty keeps whatever is stored (the forms round-trip secrets write-only, so "empty" means
 *  "unchanged", never "erase it"). Shared by the instance-wide config route and the per-account one —
 *  two copies of this would drift the first time one of them learned something the other did not. */
function applyConfigPatch(
  schema: PluginConfigField[],
  stored: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...stored };
  for (const f of schema) {
    const v = values[f.key];
    if (v === undefined) continue;
    if (f.type === 'secret' && (v === '' || v === null)) continue;
    if (v === null) { delete next[f.key]; continue; }
    next[f.key] = v;
  }
  return next;
}

/** What a config form may be shown: the stored NON-secret values, with unset fields pre-filled from their
 *  declared `default` so a fresh install shows sensible values (display-only — nothing is persisted until
 *  the user saves), plus only WHICH secrets are set. A secret value never leaves the daemon, for anybody.
 *  Shared by the instance-wide detail and the per-account one, next to `applyConfigPatch` which shares the
 *  write half: a second copy of either rule leaks the day one of them learns something the other did not. */
function maskedConfigView(
  schema: PluginConfigField[],
  stored: Record<string, unknown>,
): { config: Record<string, unknown>; secretsSet: string[] } {
  const secretKeys = new Set(schema.filter((f) => f.type === 'secret').map((f) => f.key));
  const config: Record<string, unknown> = {};
  for (const f of schema) {
    if (secretKeys.has(f.key)) continue;
    const val = stored[f.key] !== undefined ? stored[f.key] : f.default;
    if (val !== undefined) config[f.key] = val;
  }
  return { config, secretsSet: [...secretKeys].filter((k) => typeof stored[k] === 'string' && stored[k] !== '') };
}

/** Map a marketplace service error to its HTTP status; unknown errors become a 500. */
function marketplaceFail(c: Context, e: unknown) {
  const status: ContentfulStatusCode = e instanceof MarketplaceError ? (e.status as ContentfulStatusCode) : 500;
  return c.json({ error: e instanceof Error ? e.message : 'marketplace operation failed' }, status);
}

/** Answer a plugin write whose config change is already persisted, distinguishing whether the live
 *  registry swap happened. `swapped === false` means work was still running, so the runtime is briefly
 *  one generation behind the config and converges when a turn settles — a 202 with `pending: true`, so
 *  the UI reports "saved, applies shortly" rather than an error for a change that DID land. `undefined`
 *  means no brain was wired (a setup-time write), which needs no swap. */
function applied(c: Context, body: Record<string, unknown>, swapped: boolean | undefined) {
  if (swapped === false) return c.json({ ...body, pending: true }, 202);
  return c.json(body);
}

type McpControl = {
  listServers?: () => unknown[];
  reconnectServer?: (name: string) => Promise<unknown>;
  reconnectDisconnected?: () => Promise<unknown[]>;
};

/** Admin management of daemon plugins: list what's installed on disk (bundled + user dir) and flip a
 *  plugin on/off. Enabling updates `config.plugins.enabled` and hot-reloads the brain's registry, so the
 *  change applies to chat sessions immediately — no daemon restart. */
export function registerPluginRoutes(app: ElowenApp, ctx: RouteContext): void {
  // The plugin config/enable routes must be reachable during first-run onboarding, so they use the
  // setup-tolerant admin gate (the shared `notAdminUnlessSetup`, previously a private copy of it here).
  const { d, notAdminUnlessSetup: notAdmin } = ctx;

  /** One admin-only catalog across every enabled platform plugin. The target `value` is opaque and already
   *  carries its platform routing, so consumers never concatenate or inspect delivery ids themselves. */
  app.get('/plugins/destinations', async c => {
    if (ctx.notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const registry = await d.plugins?.get().catch(() => undefined);
    return c.json(await registry?.notificationDestinations() ?? []);
  });

  const listing = () => {
    const cfg = d.config.get().plugins;
    const enabled = new Set(cfg.enabled);
    const removed = new Set(cfg.removed);
    return discoverPlugins(d.pluginDirs ?? []).map((p) => ({
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      provides: p.manifest.provides ?? {},
      source: p.source,
      enabled: enabled.has(p.manifest.name),
      // A soft-removed bundled plugin: hidden from the installed list, restorable from "Available".
      removed: removed.has(p.manifest.name),
      configurable: (p.manifest.configSchema?.length ?? 0) > 0,
      // Whether this plugin is handed out PER USER (manifest `userGrantable`) — drives the grant picker
      // in the users panel. Read from the manifest so a disabled plugin is still offerable.
      userGrantable: p.manifest.userGrantable === true,
      // Coarse health for the marketplace card badge, derived from the log ring (default `ok` when
      // the buffer isn't wired — e.g. in tests that build deps by hand).
      health: d.pluginLogs?.health(p.manifest.name) ?? 'ok',
      i18n: p.i18n,
      // Whether the plugin ships a brand icon on disk — lets the UI render `<img>` vs. a fallback glyph.
      hasIcon: existsSync(resolve(p.dir, p.manifest.icon ?? 'icon.svg')),
    }));
  };
  const manifestOf = (name: string) => discoverPlugins(d.pluginDirs ?? []).find((p) => p.manifest.name === name)?.manifest;

  /** The powers this plugin claims that the operator has to agree to hand over, read from the manifest
   *  on disk — the only copy that will actually run. Empty for a plugin that claims nothing durable. */
  const consentRequiredFor = (name: string) => {
    const claimed = manifestOf(name)?.capabilities?.mutates ?? [];
    return CONSENT_REQUIRED_MUTATES.filter((g) => claimed.includes(g));
  };

  /** Which required grants the caller left unnamed. Consent is all-or-nothing on purpose: acknowledging
   *  one power must not carry the rest in with it. */
  const missingConsent = (needed: readonly string[], ack: unknown) => {
    const acked = new Set(Array.isArray(ack) ? ack.filter((g): g is string => typeof g === 'string') : []);
    return needed.filter((g) => !acked.has(g));
  };

  /** Enable + apply live, shared by the toggle and the marketplace install so both reach the runtime the
   *  same way (config write, then registry swap; a deferred swap answers 202, see `applied`). */
  const enablePlugin = async (c: Context, name: string) => {
    const cur = new Set(d.config.get().plugins.enabled);
    cur.add(name);
    d.config.update({ plugins: { enabled: [...cur] } });
    return applied(c, listing().find((p) => p.name === name) ?? { ok: true }, await d.brain?.reloadPlugins());
  };

  const mcpControl = async (): Promise<McpControl | null> => {
    const registry = await d.plugins?.get();
    const control = registry?.controls.get('mcp');
    return control && typeof control === 'object' ? control as McpControl : null;
  };

  // A plugin's own writable data dir under the shared root, or null when the root is unset or the name
  // is unsafe (path separator / traversal). Every data path — the summary and the destructive clear —
  // funnels through here so nothing can ever resolve outside `pluginDataRoot`.
  const pluginDataDir = (name: string): string | null => {
    if (!d.pluginDataRoot) return null;
    if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
    const root = resolve(d.pluginDataRoot);
    const dir = resolve(root, name);
    if (dir !== join(root, name) || !dir.startsWith(root + sep)) return null;
    return dir;
  };

  const notInstanceOwner = (c: Context): boolean => {
    const userId = c.get('user')?.id;
    const ownerId = d.users?.ownerId();
    return userId == null || ownerId === undefined || userId !== ownerId;
  };

  app.get('/plugins/mcp/servers', async (c) => {
    if (notInstanceOwner(c)) return c.json({ error: 'forbidden' }, 403);
    const control = await mcpControl();
    if (!control?.listServers) return c.json([]);
    return c.json(control.listServers());
  });

  app.post('/plugins/mcp/servers/:name/reconnect', async (c) => {
    if (notInstanceOwner(c)) return c.json({ error: 'forbidden' }, 403);
    const control = await mcpControl();
    if (!control?.reconnectServer) return c.json({ error: 'mcp plugin unavailable' }, 503);
    try { return c.json(await control.reconnectServer(c.req.param('name'))); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 409); }
  });

  app.post('/plugins/mcp/reconnect', async (c) => {
    if (notInstanceOwner(c)) return c.json({ error: 'forbidden' }, 403);
    const control = await mcpControl();
    if (!control?.reconnectDisconnected) return c.json({ error: 'mcp plugin unavailable' }, 503);
    try { return c.json(await control.reconnectDisconnected()); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 409); }
  });

  // Summary of a plugin's on-disk data (for the detail Data section): total files + bytes, recursively.
  // A missing dir (plugin never wrote anything) is a valid `exists:false`, not an error.
  const dataSummary = (name: string): { path: string; exists: boolean; files: number; bytes: number } => {
    const dir = pluginDataDir(name);
    if (!dir) return { path: '', exists: false, files: 0, bytes: 0 };
    if (!existsSync(dir)) return { path: dir, exists: false, files: 0, bytes: 0 };
    let files = 0;
    let bytes = 0;
    const walk = (p: string): void => {
      for (const ent of readdirSync(p, { withFileTypes: true })) {
        const full = join(p, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.isFile()) { files += 1; bytes += statSync(full).size; }
      }
    };
    walk(dir);
    return { path: dir, exists: true, files, bytes };
  };

  app.get('/plugins', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    return c.json(listing());
  });

  // Runtime introspection: the ACTUAL contributions of the merged, loaded plugin registry — each tool /
  // skill / platform / hook / prompt-fragment / turn-context tagged with the plugin that registered it.
  // Distinct from GET /plugins (declarative manifest `provides`): this reflects what ended up live after
  // load. Registered before `/plugins/:name` so the literal path isn't captured by the param route.
  app.get('/plugins/runtime', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const registry = await d.plugins?.get();
    return c.json(registry ? buildContributionReport(registry) : emptyContributionReport());
  });

  // ── Marketplace: browse the curated registry and install/update plugins from it. These literal paths
  // are registered before `/plugins/:name` so the param route doesn't capture them. All admin-gated;
  // degrade to 503 when the service isn't wired (older deps / hand-built test deps). ──
  app.get('/plugins/marketplace', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    if (!d.marketplace) return c.json({ error: 'marketplace unavailable' }, 503);
    return c.json(await d.marketplace.catalog(c.req.query('refresh') === '1'));
  });

  app.post('/plugins/marketplace/:name/install', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    if (!d.marketplace) return c.json({ error: 'marketplace unavailable' }, 503);
    const name = c.req.param('name');
    const body = (await c.req.json().catch(() => ({}))) as { enable?: unknown; acknowledgeGrants?: unknown };
    const wantEnabled = typeof body.enable === 'boolean' ? body.enable : true;
    try {
      // Install first, ALWAYS disabled: a plugin's manifest is only trustworthy once its validated copy
      // is on disk, and that manifest is what the grant check reads. Landing it inert also means a
      // refused enable leaves something the operator can inspect and switch on deliberately, rather than
      // a half-done install. Enabling then goes through the SAME gate as the toggle — one-click install
      // was the hole: it enabled by default and never asked.
      const outcome = await d.marketplace.install(name, { enable: false });
      // `deferred` means the files are installed and the runtime picks them up when the running work
      // settles — a 202, exactly like a deferred toggle. Reporting it as an error would deny an install
      // that DID land, and an install asked for from a conversation is deferred by construction.
      if (!wantEnabled) return applied(c, listing().find((p) => p.name === name) ?? { ok: true }, outcome !== 'deferred');
      const needed = consentRequiredFor(name);
      const missing = missingConsent(needed, body.acknowledgeGrants);
      if (missing.length) return c.json({ error: 'grants require consent', grants: needed, installed: true }, 409);
      return await enablePlugin(c, name);
    } catch (e) { return marketplaceFail(c, e); }
  });

  app.post('/plugins/marketplace/:name/update', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    if (!d.marketplace) return c.json({ error: 'marketplace unavailable' }, 503);
    const name = c.req.param('name');
    try {
      const outcome = await d.marketplace.update(name);
      return applied(c, listing().find((p) => p.name === name) ?? { ok: true }, outcome !== 'deferred');
    } catch (e) { return marketplaceFail(c, e); }
  });

  /** The caller's own values for one plugin, shaped like the instance-wide detail. */
  const userConfigView = (name: string, schema: PluginConfigField[], stored: Record<string, unknown>) => ({
    name,
    userConfigSchema: schema,
    ...maskedConfigView(schema, stored),
  });

  /** The plugins whose per-account fields THIS caller may fill in: enabled, declaring a `userConfigSchema`,
   *  and (for a `userGrantable` one) actually granted to them. A plugin they cannot reach must not even be
   *  listed — the form would write values nothing will ever read. */
  const userConfigurablePlugins = (user: PluginAccessUser | null | undefined) => {
    const enabled = new Set(d.config.get().plugins.enabled);
    return discoverPlugins(d.pluginDirs ?? [])
      .filter((p) => enabled.has(p.manifest.name)
        && (p.manifest.userConfigSchema?.length ?? 0) > 0
        && isPluginAllowedForUser(user, p.manifest));
  };

  // The signed-in account's OWN per-plugin values. NOT admin-gated, and that is the point: a non-admin
  // must be able to enter their own credentials. The account is taken from the session — no request can
  // name a user — so this can only ever read the caller's own values.
  app.get('/plugins/user-config', (c) => {
    const user = c.get('user');
    const store = d.userPluginConfig;
    // No account (setup mode / no user store) means there is nobody to hold values FOR. Empty, not an
    // error: the section simply has nothing to show yet.
    if (!user || !store) return c.json([]);
    return c.json(userConfigurablePlugins(user).map((p) => ({
      ...userConfigView(p.manifest.name, p.manifest.userConfigSchema ?? [], store.get(user.id, p.manifest.name)),
      description: p.manifest.description,
      i18n: p.i18n,
    })));
  });

  // Save the caller's own values for one plugin. Same field semantics as the instance-wide config route:
  // an empty/absent secret keeps the stored one (the form round-trips secrets write-only) and an explicit
  // `null` clears a non-secret back to unset. No plugin reload — `ctx.userConfig()` reads live.
  app.patch('/plugins/:name/user-config', async (c) => {
    const user = c.get('user');
    const store = d.userPluginConfig;
    if (!user || !store) return c.json({ error: 'forbidden' }, 403);
    const name = c.req.param('name');
    // Refuse through the SAME predicate the listing uses, so a plugin that is disabled, declares no
    // per-account fields, or was never granted to this account cannot be written to by URL.
    const plugin = userConfigurablePlugins(user).find((p) => p.manifest.name === name);
    if (!plugin) return c.json({ error: 'unknown plugin' }, 404);
    const b = (await c.req.json().catch(() => null)) as { values?: Record<string, unknown> } | null;
    if (!b || typeof b.values !== 'object' || b.values === null) return c.json({ error: 'values must be an object' }, 400);
    const schema = plugin.manifest.userConfigSchema ?? [];
    store.set(user.id, name, applyConfigPatch(schema, store.get(user.id, name), b.values));
    return c.json(userConfigView(name, schema, store.get(user.id, name)));
  });

  // Detail for the per-plugin settings section: the declared config fields + current values. Secret
  // values never leave the daemon — the UI gets only which secret keys are set.
  app.get('/plugins/:name', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const name = c.req.param('name');
    const manifest = manifestOf(name);
    if (!manifest) return c.json({ error: 'unknown plugin' }, 404);
    const item = listing().find((p) => p.name === name);
    const schema = manifest.configSchema ?? [];
    return c.json({
      ...item,
      configSchema: schema,
      ...maskedConfigView(schema, d.config.pluginConfig(name)),
      // Declared capabilities (deny-by-default `{}` when the manifest omits them) so the UI can render the
      // plugin's permission/risk section — what it may mutate, read, and whether it reaches the network.
      capabilities: manifest.capabilities ?? {},
      data: dataSummary(name),
    });
  });

  // The plugin's brand icon (SVG), served straight from its folder. Not admin-gated — a brand glyph
  // carries no secrets and loads via a plain `<img>` (through the BFF proxy). Path-confined to the
  // plugin's own dir so a crafted manifest `icon` can't traverse out.
  app.get('/plugins/:name/icon', (c) => {
    const name = c.req.param('name');
    const p = discoverPlugins(d.pluginDirs ?? []).find((x) => x.manifest.name === name);
    if (!p) return c.json({ error: 'unknown plugin' }, 404);
    const base = resolve(p.dir);
    const iconPath = resolve(base, p.manifest.icon ?? 'icon.svg');
    if (iconPath !== base && !iconPath.startsWith(base + sep)) return c.json({ error: 'bad icon path' }, 400);
    if (!existsSync(iconPath)) return c.json({ error: 'no icon' }, 404);
    return c.body(readFileSync(iconPath, 'utf8'), 200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  });

  // The plugin's OWN runtime contributions (tools + hooks + the rest), filtered from the merged
  // registry. Powers the detail Tools and Hooks sections. Falls back to an empty report when the
  // registry provider isn't wired (tests build deps by hand) so it never 500s.
  app.get('/plugins/:name/contributions', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const name = c.req.param('name');
    if (!manifestOf(name)) return c.json({ error: 'unknown plugin' }, 404);
    const registry = await d.plugins?.get();
    return c.json(registry ? pluginContributions(registry, name) : emptyContributionReport());
  });

  // The plugin's recent log tail + coarse health, from the bounded log ring. Empty/`ok` when the
  // buffer isn't wired.
  app.get('/plugins/:name/logs', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const name = c.req.param('name');
    if (!manifestOf(name)) return c.json({ error: 'unknown plugin' }, 404);
    return c.json({
      entries: d.pluginLogs?.forPlugin(name) ?? [],
      health: d.pluginLogs?.health(name) ?? 'ok',
    });
  });

  // The plugin's recent mutating-hook execution records (newest-first), from the bounded hook-audit ring.
  // Empty when the buffer isn't wired (tests build deps by hand). Powers the detail Hooks-activity view:
  // per hook run, whether its context patch was accepted ('ok'), denied by the capability gate
  // ('rejected'), or failed open ('threw'/'timeout').
  app.get('/plugins/:name/hook-executions', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const name = c.req.param('name');
    if (!manifestOf(name)) return c.json({ error: 'unknown plugin' }, 404);
    return c.json({ entries: d.hookAudit?.forPlugin(name) ?? [] });
  });

  // Destructive: wipe the CONTENTS of the plugin's own data dir (never the dir itself, never anything
  // outside `pluginDataRoot`). `pluginDataDir` refuses any name with a separator/traversal, so a
  // crafted `:name` can't escape the root.
  app.post('/plugins/:name/data/clear', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const name = c.req.param('name');
    const dir = pluginDataDir(name);
    if (!dir) return c.json({ error: 'invalid plugin name' }, 400);
    if (!manifestOf(name)) return c.json({ error: 'unknown plugin' }, 404);
    if (existsSync(dir)) {
      for (const ent of readdirSync(dir)) rmSync(join(dir, ent), { recursive: true, force: true });
    }
    return c.json({ ok: true });
  });

  // Save a plugin's config values. A secret field arriving empty/absent keeps the stored value (the UI
  // round-trips secrets write-only). Applies live via the brain's plugin hot-reload.
  app.patch('/plugins/:name/config', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const name = c.req.param('name');
    const manifest = manifestOf(name);
    if (!manifest) return c.json({ error: 'unknown plugin' }, 404);
    const b = (await c.req.json().catch(() => null)) as { values?: Record<string, unknown> } | null;
    if (!b || typeof b.values !== 'object' || b.values === null) return c.json({ error: 'values must be an object' }, 400);
    const stored = applyConfigPatch(manifest.configSchema ?? [], d.config.pluginConfig(name), b.values);
    d.config.update({ plugins: { config: { [name]: stored as Record<string, never> } } });
    return applied(c, { ok: true }, await d.brain?.reloadPlugins());
  });

  app.patch('/plugins/:name', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const name = c.req.param('name');
    if (!listing().some((p) => p.name === name)) return c.json({ error: 'unknown plugin' }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { enabled?: unknown; acknowledgeGrants?: unknown };
    if (typeof b.enabled !== 'boolean') return c.json({ error: 'enabled must be a boolean' }, 400);
    // Turning a plugin ON is the moment its declared capabilities become real, so it is the moment to
    // ask. Turning it OFF takes powers away and needs no consent.
    if (b.enabled) {
      const needed = consentRequiredFor(name);
      if (missingConsent(needed, b.acknowledgeGrants).length) return c.json({ error: 'grants require consent', grants: needed }, 409);
      return await enablePlugin(c, name);
    }
    const cur = new Set(d.config.get().plugins.enabled);
    cur.delete(name);
    d.config.update({ plugins: { enabled: [...cur] } });
    // Apply live: drop the brain's memoized registry and restart running sessions with the new set.
    return applied(c, listing().find((p) => p.name === name) ?? { ok: true }, await d.brain?.reloadPlugins());
  });

  // Remove a plugin. A user-source (marketplace) plugin is uninstalled outright — folder AND data
  // deleted. A bundled plugin lives in the npm-owned dir and must NOT be deleted from disk, so it's
  // "soft-removed" instead: dropped from enabled and recorded in `plugins.removed` so it's hidden from
  // the installed list and stops loading — fully restorable from the Available tab. Either way the
  // change hot-reloads so the UI, plugin state and logs update immediately.
  app.delete('/plugins/:name', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const name = c.req.param('name');
    const disc = discoverPlugins(d.pluginDirs ?? []).find((p) => p.manifest.name === name);
    if (!disc) return c.json({ error: 'unknown plugin' }, 404);
    if (disc.source === 'user') {
      if (!d.marketplace) return c.json({ error: 'marketplace unavailable' }, 503);
      try {
        await d.marketplace.uninstall(name);
        return c.json({ ok: true });
      } catch (e) { return marketplaceFail(c, e); }
    }
    // Bundled → soft-remove (hide + stop loading, keep files). Reversible via POST /plugins/:name/restore.
    const cfg = d.config.get().plugins;
    const removed = cfg.removed.includes(name) ? cfg.removed : [...cfg.removed, name];
    d.config.update({ plugins: { enabled: cfg.enabled.filter((n) => n !== name), removed } });
    return applied(c, { ok: true, removed: true }, await d.brain?.reloadPlugins());
  });

  // Restore a soft-removed bundled plugin: drop it from `plugins.removed` so it reappears in the
  // installed list (disabled — the operator re-enables it if wanted), then hot-reload.
  app.post('/plugins/:name/restore', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const name = c.req.param('name');
    if (!manifestOf(name)) return c.json({ error: 'unknown plugin' }, 404);
    const cfg = d.config.get().plugins;
    let swapped: boolean | undefined;
    if (cfg.removed.includes(name)) {
      d.config.update({ plugins: { removed: cfg.removed.filter((n) => n !== name) } });
      swapped = await d.brain?.reloadPlugins();
    }
    return applied(c, listing().find((p) => p.name === name) ?? { ok: true }, swapped);
  });

  registerBrainOAuthRoutes(app, ctx);
}
