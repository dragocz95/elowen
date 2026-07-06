import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { discoverPlugins } from '../../plugins/loader.js';
import { buildContributionReport, emptyContributionReport, pluginContributions } from '../../plugins/contributionReport.js';
import { MarketplaceError } from '../../plugins/marketplace.js';
import { OAUTH_BUILTIN } from '../../brain/providers.js';
import { oauthBuiltinCatalog } from '../../brain/models.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context } from 'hono';
import type { OrcaApp, RouteContext } from '../context.js';

/** Map a marketplace service error to its HTTP status; unknown errors become a 500. */
function marketplaceFail(c: Context, e: unknown) {
  const status: ContentfulStatusCode = e instanceof MarketplaceError ? (e.status as ContentfulStatusCode) : 500;
  return c.json({ error: e instanceof Error ? e.message : 'marketplace operation failed' }, status);
}

/** Whether a recurring cron-job schedule spec is valid. Mirrors `parseSchedule` in
 *  plugins/cronjob/index.mjs (the daemon can't import the plugin's untyped ESM entry):
 *  "every <N>m" / "every <N>h" (≥ 1), "daily HH:MM", "weekly <mon..sun> HH:MM". */
function isValidCronSchedule(spec: string): boolean {
  const s = spec.trim();
  const every = /^every\s+(\d+)\s*(m|h)$/i.exec(s);
  if (every) return Number(every[1]) >= 1;
  return /^daily\s+([01]?\d|2[0-3]):([0-5]\d)$/i.test(s)
    || /^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+([01]?\d|2[0-3]):([0-5]\d)$/i.test(s);
}

/** One text-capable Discord destination for the cron-job channel picker. */
type DiscordChannelOption = { id: string; name: string; type: 'channel' | 'thread'; parentName?: string };

/** Admin management of daemon plugins: list what's installed on disk (bundled + user dir) and flip a
 *  plugin on/off. Enabling updates `config.plugins.enabled` and hot-reloads the brain's registry, so the
 *  change applies to chat sessions immediately — no daemon restart. */
export function registerPluginRoutes(app: OrcaApp, ctx: RouteContext): void {
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
      // Whether the plugin ships a hero illustration (illustration.png) shown big on its detail page.
      hasIllustration: existsSync(resolve(p.dir, 'illustration.png')),
    }));
  };
  const manifestOf = (name: string) => discoverPlugins(d.pluginDirs ?? []).find((p) => p.manifest.name === name)?.manifest;

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
    const config: Record<string, unknown> = {};
    for (const f of schema) { if (!secretKeys.has(f.key) && stored[f.key] !== undefined) config[f.key] = stored[f.key]; }
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

  // The plugin's hero illustration (transparent PNG), shown big on its detail page. Same trust/confinement
  // as the icon route: not admin-gated (no secrets), path-confined to the plugin's own dir.
  app.get('/plugins/:name/illustration', (c) => {
    const name = c.req.param('name');
    const p = discoverPlugins(d.pluginDirs ?? []).find((x) => x.manifest.name === name);
    if (!p) return c.json({ error: 'unknown plugin' }, 404);
    const base = resolve(p.dir);
    const imgPath = resolve(base, 'illustration.png');
    if (imgPath !== base && !imgPath.startsWith(base + sep)) return c.json({ error: 'bad path' }, 400);
    if (!existsSync(imgPath)) return c.json({ error: 'no illustration' }, 404);
    return c.body(readFileSync(imgPath), 200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' });
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

  // ── Cron jobs (cronjob plugin): the raw jobs.json array, managed as one list. The plugin's
  // scheduler re-reads the file from disk every tick (30 s), so REST edits apply live — no restart. ──
  const cronJobsFile = (): string | null => (d.pluginDataRoot ? join(d.pluginDataRoot, 'cronjob', 'jobs.json') : null);

  app.get('/plugins/cronjob/jobs', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const file = cronJobsFile();
    if (!file || !existsSync(file)) return c.json([]);
    try { return c.json(JSON.parse(readFileSync(file, 'utf-8'))); }
    catch { return c.json([]); } // corrupted file → the same "empty" the plugin's own store reports
  });

  // Replace the whole jobs array (the UI edits the full list). Every job needs id/name/schedule/prompt;
  // a recurring schedule must parse, a one-shot job carries a parseable `runAt` instead.
  app.put('/plugins/cronjob/jobs', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const file = cronJobsFile();
    if (!file) return c.json({ error: 'plugin data dir unavailable' }, 503);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown>[] | null;
    if (!Array.isArray(body)) return c.json({ error: 'body must be an array of jobs' }, 400);
    for (const j of body) {
      for (const k of ['id', 'name', 'schedule', 'prompt'] as const) {
        if (typeof j?.[k] !== 'string' || (j[k] as string).trim() === '') return c.json({ error: `each job needs a non-empty "${k}"` }, 400);
      }
      const oneShot = j.runAt !== undefined;
      if (oneShot ? typeof j.runAt !== 'string' || Number.isNaN(Date.parse(j.runAt)) : !isValidCronSchedule(j.schedule as string)) {
        return c.json({ error: `invalid schedule "${String(j.schedule)}" — use "every 15m", "every 2h", "daily 07:30" or "weekly sun 20:00"` }, 400);
      }
      // Optional cheap guard command — must be a string when present (empty = no guard).
      if (j.check !== undefined && typeof j.check !== 'string') {
        return c.json({ error: 'check must be omitted or a string' }, 400);
      }
      // Optional plain delivery flag — suppresses the "⏰ job name" header on delivered results.
      if (j.plain !== undefined && typeof j.plain !== 'boolean') {
        return c.json({ error: 'plain must be omitted or a boolean' }, 400);
      }
      // Optional per-job model: either absent, or an object carrying non-empty provider + model strings.
      if (j.model !== undefined) {
        const m = j.model as { provider?: unknown; model?: unknown } | null;
        if (typeof m !== 'object' || m === null || typeof m.provider !== 'string' || typeof m.model !== 'string' || !m.provider.trim() || !m.model.trim()) {
          return c.json({ error: 'model must be omitted or an object with non-empty provider and model' }, 400);
        }
      }
    }
    // Runtime fields (lastRun/lastResult) belong to the SCHEDULER, not the client: the UI edits a
    // snapshot, and writing its stale lastRun back would make an interval job due again on the next
    // tick — an enabled "every 5m" job would fire instantly after every save. Merge them from disk,
    // and arm a job that just flipped to enabled (or arrived new as enabled) from NOW, so it waits
    // for its next natural slot instead of firing immediately.
    let onDisk: Record<string, unknown>[] = [];
    try { onDisk = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>[]) : []; }
    catch { onDisk = []; }
    const prevById = new Map(onDisk.map((j) => [j.id, j]));
    const now = new Date().toISOString();
    // Persist only known fields — the client edits a whole-list snapshot, so a whitelist keeps it from
    // smuggling arbitrary keys into jobs.json that the scheduler would later read.
    const FIELDS = ['id', 'name', 'schedule', 'prompt', 'check', 'hours', 'notifyChannelId', 'plain', 'model', 'enabled', 'runAt', 'createdAt'] as const;
    const merged = body.map((j) => {
      const edit: Record<string, unknown> = {};
      for (const k of FIELDS) if (j[k] !== undefined) edit[k] = j[k];
      const prev = prevById.get(j.id);
      // One-shot (runAt) jobs are excluded from arming: they fire exactly once while lastRun is EMPTY.
      const enabling = !j.runAt && edit.enabled !== false && (!prev || prev.enabled === false);
      return {
        ...edit,
        ...(prev?.lastResult !== undefined ? { lastResult: prev.lastResult } : {}),
        ...(enabling ? { lastRun: now } : prev?.lastRun !== undefined ? { lastRun: prev.lastRun } : {}),
      };
    });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(merged, null, 2));
    return c.json({ ok: true });
  });

  // ── Skills (skills plugin): bundled .md skills ship inside the plugin folder, user skills live in
  // the plugin's writable data dir (where the create_skill tool writes). Managed one file per skill;
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
  // Same cheap frontmatter probe the plugin's list_skills tool uses — full YAML parsing is overkill
  // for one known single-line field.
  const skillDescription = (file: string): string => {
    try { return /description:\s*(.+)/.exec(readFileSync(file, 'utf-8').slice(0, 400))?.[1]?.trim() ?? ''; }
    catch { return ''; }
  };

  app.get('/plugins/skills/list', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const out: { name: string; description: string; source: 'bundled' | 'user' }[] = [];
    for (const { dir, source } of [
      { dir: bundledSkillsDir(), source: 'bundled' as const },
      { dir: userSkillsDir(), source: 'user' as const },
    ]) {
      if (!dir || !existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
        out.push({ name: f.replace(/\.md$/, ''), description: skillDescription(join(dir, f)), source });
      }
    }
    return c.json(out);
  });

  // Create (or overwrite) a user skill — the same file format the plugin's create_skill tool writes.
  // A name shadowing a bundled skill is refused: the plugin registers both copies and the duplicate
  // would silently fight over the system prompt.
  app.post('/plugins/skills', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const userDir = userSkillsDir();
    if (!userDir) return c.json({ error: 'plugin data dir unavailable' }, 503);
    const b = (await c.req.json().catch(() => null)) as { name?: unknown; description?: unknown; content?: unknown } | null;
    const name = typeof b?.name === 'string' ? b.name.trim() : '';
    const description = typeof b?.description === 'string' ? b.description.trim() : '';
    const content = typeof b?.content === 'string' ? b.content : '';
    if (!SKILL_NAME_RE.test(name)) return c.json({ error: 'name must be kebab-case (a-z, 0-9, dashes), max 64 chars' }, 400);
    if (description === '' || content.trim() === '') return c.json({ error: 'description and content must be non-empty' }, 400);
    const bundled = bundledSkillsDir();
    if (bundled && existsSync(join(bundled, `${name}.md`))) return c.json({ error: `a bundled skill named "${name}" already exists` }, 400);
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, `${name}.md`), `---\nname: ${name}\ndescription: ${description.replaceAll('\n', ' ')}\n---\n\n${content}\n`, 'utf-8');
    await d.brain?.reloadPlugins(); // skills feed the brain's system prompt — apply live
    return c.json({ ok: true }, 201);
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
