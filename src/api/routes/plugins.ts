import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { discoverPlugins } from '../../plugins/loader.js';
import { buildContributionReport, emptyContributionReport, pluginContributions } from '../../plugins/contributionReport.js';
import { MarketplaceError } from '../../plugins/marketplace.js';
import { isValidSchedule } from '../../shared/cronSchedule.js';
import { OAUTH_BUILTIN } from '../../brain/providers.js';
import { oauthBuiltinCatalog } from '../../brain/models.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context } from 'hono';
import type { ElowenApp, RouteContext } from '../context.js';

/** Map a marketplace service error to its HTTP status; unknown errors become a 500. */
function marketplaceFail(c: Context, e: unknown) {
  const status: ContentfulStatusCode = e instanceof MarketplaceError ? (e.status as ContentfulStatusCode) : 500;
  return c.json({ error: e instanceof Error ? e.message : 'marketplace operation failed' }, status);
}

/** One text-capable Discord destination for the cron-job channel picker. */
type DiscordChannelOption = { id: string; name: string; type: 'channel' | 'thread'; parentName?: string };
type McpControl = {
  listServers?: () => unknown[];
  reconnectServer?: (name: string) => Promise<unknown>;
  reconnectDisconnected?: () => Promise<unknown[]>;
};

/** Admin management of daemon plugins: list what's installed on disk (bundled + user dir) and flip a
 *  plugin on/off. Enabling updates `config.plugins.enabled` and hot-reloads the brain's registry, so the
 *  change applies to chat sessions immediately — no daemon restart. */
export function registerPluginRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d } = ctx;
  const notAdmin = (c: { get: (k: 'user') => { id: number } | undefined }): boolean => {
    if (!d.users || d.users.count() === 0) return false; // open/single-user mode → no gating
    const u = c.get('user');
    return !u || !d.users.isAdmin(u.id);
  };
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
      // Coarse health for the marketplace card badge, derived from the log ring (default `ok` when
      // the buffer isn't wired — e.g. in tests that build deps by hand).
      health: d.pluginLogs?.health(p.manifest.name) ?? 'ok',
      i18n: p.i18n,
      // Whether the plugin ships a brand icon on disk — lets the UI render `<img>` vs. a fallback glyph.
      hasIcon: existsSync(resolve(p.dir, p.manifest.icon ?? 'icon.svg')),
    }));
  };
  const manifestOf = (name: string) => discoverPlugins(d.pluginDirs ?? []).find((p) => p.manifest.name === name)?.manifest;

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

  app.get('/plugins/mcp/servers', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const control = await mcpControl();
    if (!control?.listServers) return c.json([]);
    return c.json(control.listServers());
  });

  app.post('/plugins/mcp/servers/:name/reconnect', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const control = await mcpControl();
    if (!control?.reconnectServer) return c.json({ error: 'mcp plugin unavailable' }, 503);
    try { return c.json(await control.reconnectServer(c.req.param('name'))); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 409); }
  });

  app.post('/plugins/mcp/reconnect', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
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
    const body = (await c.req.json().catch(() => ({}))) as { enable?: unknown };
    try {
      await d.marketplace.install(name, typeof body.enable === 'boolean' ? { enable: body.enable } : {});
      return c.json(listing().find((p) => p.name === name) ?? { ok: true });
    } catch (e) { return marketplaceFail(c, e); }
  });

  app.post('/plugins/marketplace/:name/update', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    if (!d.marketplace) return c.json({ error: 'marketplace unavailable' }, 503);
    const name = c.req.param('name');
    try {
      await d.marketplace.update(name);
      return c.json(listing().find((p) => p.name === name) ?? { ok: true });
    } catch (e) { return marketplaceFail(c, e); }
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
    const stored = d.config.pluginConfig(name);
    const secretKeys = new Set(schema.filter((f) => f.type === 'secret').map((f) => f.key));
    // Pre-fill unset fields from their declared `default` so a fresh install shows sensible values (the
    // defaults mirror each plugin's runtime fallback, so this is display-only — nothing is persisted
    // until the user saves). Secrets never carry a default and never leave the daemon.
    const config: Record<string, unknown> = {};
    for (const f of schema) {
      if (secretKeys.has(f.key)) continue;
      const val = stored[f.key] !== undefined ? stored[f.key] : f.default;
      if (val !== undefined) config[f.key] = val;
    }
    return c.json({
      ...item,
      configSchema: schema,
      config,
      secretsSet: [...secretKeys].filter((k) => typeof stored[k] === 'string' && stored[k] !== ''),
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
    const schema = manifest.configSchema ?? [];
    const stored = { ...d.config.pluginConfig(name) };
    for (const f of schema) {
      const v = b.values[f.key];
      if (v === undefined) continue;
      if (f.type === 'secret' && (v === '' || v === null)) continue; // keep the stored secret
      // `null` is an explicit clear for non-secret overrides. Omitting a key still means "leave it
      // alone", while clearing a number in the UI can now return it to the manifest/host default.
      if (v === null) { delete stored[f.key]; continue; }
      stored[f.key] = v;
    }
    d.config.update({ plugins: { config: { [name]: stored as Record<string, never> } } });
    await d.brain?.reloadPlugins();
    return c.json({ ok: true });
  });

  app.patch('/plugins/:name', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const name = c.req.param('name');
    if (!listing().some((p) => p.name === name)) return c.json({ error: 'unknown plugin' }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof b.enabled !== 'boolean') return c.json({ error: 'enabled must be a boolean' }, 400);
    const cur = new Set(d.config.get().plugins.enabled);
    if (b.enabled) cur.add(name); else cur.delete(name);
    d.config.update({ plugins: { enabled: [...cur] } });
    // Apply live: drop the brain's memoized registry and restart running sessions with the new set.
    await d.brain?.reloadPlugins();
    return c.json(listing().find((p) => p.name === name));
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
    await d.brain?.reloadPlugins();
    return c.json({ ok: true, removed: true });
  });

  // Restore a soft-removed bundled plugin: drop it from `plugins.removed` so it reappears in the
  // installed list (disabled — the operator re-enables it if wanted), then hot-reload.
  app.post('/plugins/:name/restore', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const name = c.req.param('name');
    if (!manifestOf(name)) return c.json({ error: 'unknown plugin' }, 404);
    const cfg = d.config.get().plugins;
    if (cfg.removed.includes(name)) {
      d.config.update({ plugins: { removed: cfg.removed.filter((n) => n !== name) } });
      await d.brain?.reloadPlugins();
    }
    return c.json(listing().find((p) => p.name === name) ?? { ok: true });
  });

  // ── Cron jobs (cronjob plugin): jobs.json is a SHARED list — the scheduler stamps runs into it, the
  // brain's CronAdd/CronRemove tools write it, and this UI edits it. So a write here names exactly ONE
  // job and the file is read-modify-written around it. It must never take the whole array from the
  // client: a page that loaded its snapshot before someone else added a job would delete that job on the
  // next save, and a browser tab left open for a day is enough to lose one. The plugin's scheduler
  // re-reads the file every tick (30 s), so an edit applies live — no restart. ──
  const cronJobsFile = (): string | null => (d.pluginDataRoot ? join(d.pluginDataRoot, 'cronjob', 'jobs.json') : null);
  /** The jobs on disk. THROWS when the file is there but unreadable — a caller about to write the list
   *  back must abort, not rebuild it from an empty base: the plugin's own store rewrites jobs.json with a
   *  plain (non-atomic) writeFileSync, so a read that lands mid-write must never be mistaken for "there
   *  are no jobs". Only the read-only GET may treat that as empty. */
  const readCronJobs = (file: string): Record<string, unknown>[] => {
    if (!existsSync(file)) return [];
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    if (!Array.isArray(parsed)) throw new Error('jobs.json is not an array');
    return parsed as Record<string, unknown>[];
  };
  /** The fields a client owns. Everything else a job carries on disk is the SCHEDULER's (lastRun,
   *  lastSlot, lastResult) and is merged back from the file — writing a stale lastRun back would make an
   *  interval job due again on the next tick, and a dropped lastSlot would re-fire a slot already run. */
  const CRON_FIELDS = ['id', 'name', 'schedule', 'prompt', 'check', 'hours', 'notifyChannelId', 'plain', 'model', 'enabled', 'runAt', 'createdAt'] as const;
  /** Why this job is not storable, or null when it is. */
  const cronJobError = (j: Record<string, unknown>): string | null => {
    for (const k of ['id', 'name', 'schedule', 'prompt'] as const) {
      if (typeof j[k] !== 'string' || (j[k] as string).trim() === '') return `a job needs a non-empty "${k}"`;
    }
    const oneShot = j.runAt !== undefined;
    if (oneShot ? typeof j.runAt !== 'string' || Number.isNaN(Date.parse(j.runAt)) : !isValidSchedule(j.schedule as string)) {
      return `invalid schedule "${String(j.schedule)}" — use "every 15m", "every 2h", "daily 07:30", "weekly sun 20:00" or a 5-field cron expression`;
    }
    // Optional cheap guard command — must be a string when present (empty = no guard).
    if (j.check !== undefined && typeof j.check !== 'string') return 'check must be omitted or a string';
    // Optional plain delivery flag — suppresses the "⏰ job name" header on delivered results.
    if (j.plain !== undefined && typeof j.plain !== 'boolean') return 'plain must be omitted or a boolean';
    // Optional per-job model: either absent, or an object carrying non-empty provider + model strings.
    if (j.model !== undefined) {
      const m = j.model as { provider?: unknown; model?: unknown } | null;
      if (typeof m !== 'object' || m === null || typeof m.provider !== 'string' || typeof m.model !== 'string' || !m.provider.trim() || !m.model.trim()) {
        return 'model must be omitted or an object with non-empty provider and model';
      }
    }
    return null;
  };

  app.get('/plugins/cronjob/jobs', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const file = cronJobsFile();
    if (!file) return c.json([]);
    try { return c.json(readCronJobs(file)); }
    catch { return c.json([]); } // a read-only view may show an unreadable file as empty; a write may not
  });

  // Upsert ONE job, leaving every other job on disk exactly as it is.
  app.put('/plugins/cronjob/jobs/:id', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const file = cronJobsFile();
    if (!file) return c.json({ error: 'plugin data dir unavailable' }, 503);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'body must be a job object' }, 400);
    // The URL names the job — a body id can't redirect the write onto another one.
    const job: Record<string, unknown> = { ...body, id: c.req.param('id') };
    const error = cronJobError(job);
    if (error) return c.json({ error }, 400);

    let jobs: Record<string, unknown>[];
    try { jobs = readCronJobs(file); }
    catch { return c.json({ error: 'jobs file is unreadable — refusing to write over it' }, 500); }
    const prev = jobs.find((j) => j.id === job.id);
    const edit: Record<string, unknown> = {};
    for (const k of CRON_FIELDS) if (job[k] !== undefined) edit[k] = job[k];
    const runtime: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(prev ?? {})) if (!(CRON_FIELDS as readonly string[]).includes(k)) runtime[k] = v;
    // A job that just flipped to enabled (or arrived new as enabled) is armed from NOW, so it waits for
    // its next natural slot instead of firing immediately. Arming means BOTH halves of the scheduler's run
    // state: `lastSlot` decides a daily/weekly job on slot identity alone, so leaving Monday's slot behind
    // on a job re-enabled on Thursday would fire it on the spot. One-shot (runAt) jobs are excluded — they
    // fire exactly once, while lastRun is empty.
    const enabling = !job.runAt && edit.enabled !== false && (!prev || prev.enabled === false);
    if (enabling) delete runtime.lastSlot;
    const saved = { ...edit, ...runtime, ...(enabling ? { lastRun: new Date().toISOString() } : {}) };

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(prev ? jobs.map((j) => (j.id === job.id ? saved : j)) : [...jobs, saved], null, 2));
    return c.json({ ok: true });
  });

  // Idempotent: deleting a job that is already gone is a success, not a 404. A client racing its own
  // in-flight save (or another tab) must be able to say "this job should not exist" without having to know
  // whether it currently does.
  app.delete('/plugins/cronjob/jobs/:id', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const file = cronJobsFile();
    if (!file) return c.json({ error: 'plugin data dir unavailable' }, 503);
    let jobs: Record<string, unknown>[];
    try { jobs = readCronJobs(file); }
    catch { return c.json({ error: 'jobs file is unreadable — refusing to write over it' }, 500); }
    const rest = jobs.filter((j) => j.id !== c.req.param('id'));
    if (rest.length !== jobs.length) writeFileSync(file, JSON.stringify(rest, null, 2));
    return c.json({ ok: true });
  });

  // ── Skills (skills plugin): bundled .md skills ship inside the plugin folder, user skills live in
  // the plugin's writable data dir (where the CreateSkill tool writes). Managed one file per skill;
  // a successful write/delete hot-reloads the plugins so new conversations pick the change up. ──
  const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/; // mirrors NAME_RE in plugins/skills/index.mjs
  const userSkillsDir = (): string | null => (d.pluginDataRoot ? join(d.pluginDataRoot, 'skills') : null);
  // The loader only ever loads the FIRST `skills` plugin folder across the scan roots — mirror that.
  const bundledSkillsDir = (): string | null => {
    for (const dir of d.pluginDirs ?? []) {
      const pluginDir = join(dir, 'skills');
      if (existsSync(pluginDir)) return join(pluginDir, 'skills');
    }
    return null;
  };
  // Same cheap frontmatter probe the plugin's ListSkills tool uses — full YAML parsing is overkill
  // for one known single-line field.
  const skillDescription = (file: string): string => {
    try { return /description:\s*(.+)/.exec(readFileSync(file, 'utf-8').slice(0, 400))?.[1]?.trim() ?? ''; }
    catch { return ''; }
  };
  // PI's `disable-model-invocation: true` frontmatter flag: the skill is excluded from progressive
  // disclosure (not advertised to the model) but still invocable explicitly via `/skill:name`.
  const skillDisableModelInvocation = (file: string): boolean => {
    try { return /^disable-model-invocation:\s*true\b/im.test(readFileSync(file, 'utf-8').slice(0, 400)); }
    catch { return false; }
  };
  // Render the skill .md file body — frontmatter (with the optional flag) followed by the content.
  const buildSkillBody = (name: string, description: string, content: string, disableModelInvocation: boolean): string => {
    const fm = [`name: ${name}`, `description: ${description.replaceAll('\n', ' ')}`];
    if (disableModelInvocation) fm.push('disable-model-invocation: true');
    return `---\n${fm.join('\n')}\n---\n\n${content}\n`;
  };
  // Parse an existing user skill back into its editable parts, so a PATCH can update just one field.
  const readSkillFile = (file: string): { description: string; content: string; disableModelInvocation: boolean } => {
    const raw = readFileSync(file, 'utf-8');
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
    const front = m?.[1] ?? '';
    const body = (m ? raw.slice(m[0].length) : raw).replace(/^\n+/, '').replace(/\n+$/, '');
    return {
      description: /description:\s*(.+)/.exec(front)?.[1]?.trim() ?? '',
      content: body,
      disableModelInvocation: /^disable-model-invocation:\s*true\b/im.test(front),
    };
  };

  app.get('/plugins/skills/list', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const out: { name: string; description: string; source: 'bundled' | 'user'; scope: string; location: string; active: boolean; canDelete: boolean; disableModelInvocation: boolean; content?: string; missingRequirement?: string }[] = [];
    for (const { dir, source } of [
      { dir: bundledSkillsDir(), source: 'bundled' as const },
      { dir: userSkillsDir(), source: 'user' as const },
    ]) {
      if (!dir || !existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
        const file = join(dir, f);
        // User skills carry their body so the web editor can prefill an edit; bundled skills are
        // read-only, so their (larger) content is left off the list payload.
        const parsed = source === 'user' ? readSkillFile(file) : null;
        out.push({
          name: f.replace(/\.md$/, ''),
          description: parsed?.description ?? skillDescription(file),
          source,
          scope: source === 'bundled' ? 'bundled/system' : 'user-defined',
          location: file,
          active: d.config.get().plugins.enabled.includes('skills'),
          canDelete: source === 'user',
          disableModelInvocation: parsed?.disableModelInvocation ?? skillDisableModelInvocation(file),
          ...(parsed ? { content: parsed.content } : {}),
        });
      }
    }
    return c.json(out);
  });

  // Create (or overwrite) a user skill — the same file format the plugin's CreateSkill tool writes.
  // A name shadowing a bundled skill is refused: the plugin registers both copies and the duplicate
  // would silently fight over the system prompt.
  app.post('/plugins/skills', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const userDir = userSkillsDir();
    if (!userDir) return c.json({ error: 'plugin data dir unavailable' }, 503);
    const b = (await c.req.json().catch(() => null)) as { name?: unknown; description?: unknown; content?: unknown; disableModelInvocation?: unknown } | null;
    const name = typeof b?.name === 'string' ? b.name.trim() : '';
    const description = typeof b?.description === 'string' ? b.description.trim() : '';
    const content = typeof b?.content === 'string' ? b.content : '';
    const disableModelInvocation = b?.disableModelInvocation === true;
    if (!SKILL_NAME_RE.test(name)) return c.json({ error: 'name must be kebab-case (a-z, 0-9, dashes), max 64 chars' }, 400);
    if (description === '' || content.trim() === '') return c.json({ error: 'description and content must be non-empty' }, 400);
    const bundled = bundledSkillsDir();
    if (bundled && existsSync(join(bundled, `${name}.md`))) return c.json({ error: `a bundled skill named "${name}" already exists` }, 400);
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, `${name}.md`), buildSkillBody(name, description, content, disableModelInvocation), 'utf-8');
    await d.brain?.reloadPlugins(); // skills feed the brain's system prompt — apply live
    return c.json({ ok: true }, 201);
  });

  // Edit a user skill (bundled skills are read-only). Partial: any of description/content/the
  // disable-model-invocation flag may be omitted to keep its current value. The flag toggle lets an
  // operator hide a skill from progressive disclosure while leaving `/skill:name` invocation intact.
  app.patch('/plugins/skills/:name', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const name = c.req.param('name');
    if (!SKILL_NAME_RE.test(name)) return c.json({ error: 'invalid skill name' }, 400);
    const bundled = bundledSkillsDir();
    if (bundled && existsSync(join(bundled, `${name}.md`))) return c.json({ error: 'bundled skills cannot be edited' }, 400);
    const userDir = userSkillsDir();
    const file = userDir ? join(userDir, `${name}.md`) : null;
    if (!file || !existsSync(file)) return c.json({ error: 'unknown skill' }, 404);
    const b = (await c.req.json().catch(() => null)) as { description?: unknown; content?: unknown; disableModelInvocation?: unknown } | null;
    const cur = readSkillFile(file);
    const description = typeof b?.description === 'string' ? b.description.trim() : cur.description;
    const content = typeof b?.content === 'string' ? b.content : cur.content;
    const disableModelInvocation = typeof b?.disableModelInvocation === 'boolean' ? b.disableModelInvocation : cur.disableModelInvocation;
    if (description === '' || content.trim() === '') return c.json({ error: 'description and content must be non-empty' }, 400);
    writeFileSync(file, buildSkillBody(name, description, content, disableModelInvocation), 'utf-8');
    await d.brain?.reloadPlugins();
    return c.json({ ok: true });
  });

  app.delete('/plugins/skills/:name', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const name = c.req.param('name');
    if (!SKILL_NAME_RE.test(name)) return c.json({ error: 'invalid skill name' }, 400);
    const bundled = bundledSkillsDir();
    if (bundled && existsSync(join(bundled, `${name}.md`))) return c.json({ error: 'bundled skills cannot be deleted' }, 400);
    const userDir = userSkillsDir();
    const file = userDir ? join(userDir, `${name}.md`) : null;
    if (!file || !existsSync(file)) return c.json({ error: 'unknown skill' }, 404);
    unlinkSync(file);
    await d.brain?.reloadPlugins();
    return c.json({ ok: true });
  });

  // ── Discord destinations (discord plugin): text channels + active threads of the configured guild,
  // for the cron-job channel picker. The bot token never leaves (or logs from) the daemon; a missing
  // config or an upstream failure degrades to an empty list. Cached briefly — the picker refetches
  // per detail view and Discord rate-limits the guild routes. ──
  let channelCache: { at: number; data: DiscordChannelOption[] } | null = null;

  app.get('/plugins/discord/channels', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const cfg = d.config.pluginConfig('discord');
    const token = typeof cfg.botToken === 'string' ? cfg.botToken : '';
    const guildId = typeof cfg.guildId === 'string' ? cfg.guildId.trim() : '';
    if (!token || !guildId) return c.json([]);
    if (channelCache && Date.now() - channelCache.at < 60_000) return c.json(channelCache.data);
    try {
      const headers = { authorization: `Bot ${token}` };
      const base = `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}`;
      const [chRes, thRes] = await Promise.all([
        fetch(`${base}/channels`, { headers }),
        fetch(`${base}/threads/active`, { headers }),
      ]);
      if (!chRes.ok) return c.json([]);
      const channels = (await chRes.json()) as { id: string; name: string; type: number }[];
      const nameById = new Map(channels.map((ch) => [ch.id, ch.name]));
      const typeById = new Map(channels.map((ch) => [ch.id, ch.type]));
      // Text-capable only: type 0 = guild text channel, 11/12 = public/private thread.
      const out: DiscordChannelOption[] = channels.filter((ch) => ch.type === 0).map((ch) => ({ id: ch.id, name: ch.name, type: 'channel' as const }));
      if (thRes.ok) {
        const { threads } = (await thRes.json()) as { threads?: { id: string; name: string; type: number; parent_id?: string }[] };
        for (const th of threads ?? []) {
          if (th.type !== 11 && th.type !== 12) continue;
          // Skip forum/media posts: they're type-11 threads too, but their parent is a forum (15) or
          // media (16) channel — the picker wants real text-channel threads, not forum posts.
          const parentType = typeById.get(th.parent_id ?? '');
          if (parentType === 15 || parentType === 16) continue;
          out.push({ id: th.id, name: th.name, type: 'thread', parentName: nameById.get(th.parent_id ?? '') });
        }
      }
      channelCache = { at: Date.now(), data: out };
      return c.json(out);
    } catch { return c.json([]); } // network failure → empty picker, never a leaked error detail
  });

  // ── WhatsApp pairing (whatsapp plugin): surface the live pairing QR/code so the settings "Pair"
  // modal can render it, and let the button force a fresh pairing attempt. Reaches the SAME live adapter
  // instance the orchestrator connected, through the plugin registry (d.plugins). The QR never leaves as
  // anything but a rendered image; the raw socket credentials stay inside the plugin. ──
  type WhatsAppPairing = { qrImage: string | null; code: string | null; connected: boolean };
  const whatsappAdapter = async (): Promise<{ getPairing?(): WhatsAppPairing; startPairing?(): Promise<{ connected: boolean }>; unpair?(): Promise<{ connected: boolean }> } | undefined> => {
    const registry = await d.plugins?.get();
    return registry?.platforms.find((p) => p.name === 'whatsapp') as never;
  };

  app.get('/plugins/whatsapp/pairing', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const adapter = await whatsappAdapter();
    if (!adapter?.getPairing) return c.json({ error: 'whatsapp plugin not enabled' }, 503);
    return c.json(adapter.getPairing());
  });

  app.post('/plugins/whatsapp/pair', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const adapter = await whatsappAdapter();
    if (!adapter?.startPairing) return c.json({ error: 'whatsapp plugin not enabled' }, 503);
    return c.json(await adapter.startPairing());
  });

  app.post('/plugins/whatsapp/unpair', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const adapter = await whatsappAdapter();
    if (!adapter?.unpair) return c.json({ error: 'whatsapp plugin not enabled' }, 503);
    return c.json(await adapter.unpair());
  });

  // ── Brain provider OAuth (admin): connect an Anthropic / GitHub Copilot / OpenAI account. ──
  // The UI starts a flow, shows authUrl (+ userCode for device flows), polls status, and posts the
  // pasted code when the flow asks for input. Tokens persist in the brain's AuthStorage.
  const oauthProviderOf = (type: string): string | undefined => OAUTH_BUILTIN[type];

  app.get('/brain/oauth/status', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    if (!d.brainOauth) return c.json({});
    const out: Record<string, boolean> = {};
    for (const [type, builtin] of Object.entries(OAUTH_BUILTIN)) out[type] = d.brainOauth.connected(builtin);
    return c.json(out);
  });

  // The account's full built-in catalog — what the settings model picker offers for selection.
  app.get('/brain/oauth/:type/catalog', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const type = c.req.param('type');
    if (!oauthProviderOf(type)) return c.json({ error: 'unknown oauth provider' }, 404);
    return c.json({ models: oauthBuiltinCatalog(type) });
  });

  app.post('/brain/oauth/:type/start', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    if (!d.brainOauth) return c.json({ error: 'oauth unavailable' }, 503);
    const builtin = oauthProviderOf(c.req.param('type'));
    if (!builtin) return c.json({ error: 'unknown oauth provider' }, 404);
    return c.json(d.brainOauth.start(builtin, { method: c.req.query('method') }), 201);
  });

  app.get('/brain/oauth/flow/:id', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const flow = d.brainOauth?.get(c.req.param('id'));
    return flow ? c.json(flow) : c.json({ error: 'unknown flow' }, 404);
  });

  app.post('/brain/oauth/flow/:id/input', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const b = (await c.req.json().catch(() => ({}))) as { value?: unknown };
    if (typeof b.value !== 'string' || !b.value.trim()) return c.json({ error: 'value must be a non-empty string' }, 400);
    if (!d.brainOauth?.submitInput(c.req.param('id'), b.value.trim())) return c.json({ error: 'flow is not waiting for input' }, 409);
    return c.json({ ok: true });
  });

  app.delete('/brain/oauth/:type', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    if (!d.brainOauth) return c.json({ error: 'oauth unavailable' }, 503);
    const builtin = oauthProviderOf(c.req.param('type'));
    if (!builtin) return c.json({ error: 'unknown oauth provider' }, 404);
    d.brainOauth.disconnect(builtin);
    return c.json({ ok: true });
  });
}
