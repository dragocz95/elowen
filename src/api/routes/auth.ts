import { join } from 'node:path';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseBody } from '../validation.js';
import { loginSchema, profilePatchSchema, passwordChangeSchema, userPermissionsSchema, projectAssignSchema, promptSaveSchema } from '../schemas/auth.js';
import { EDITABLE_PROMPTS, isEditablePrompt, isAppendOnlyPrompt } from '../../prompts/catalog.js';
import { rawTemplate } from '../../prompts/index.js';
import type { User } from '../../store/userStore.js';
import type { OrcaApp, RouteContext } from '../context.js';

/** Auth + user-management routes: login (rate-limited), session lifecycle, self-service profile /
 *  password / avatar, admin user CRUD and user↔project assignments. No-op without a user store. */
export function registerAuthRoutes(app: OrcaApp, ctx: RouteContext): void {
  const { d } = ctx;
  if (!d.users) return;
  const users = d.users;

  // Brute-force guard for the only unauthenticated, credential-checking endpoint: a fixed window per
  // client IP. Prefer x-real-ip (set by our nginx) over the client-spoofable x-forwarded-for. In-memory
  // per-process is enough for the single-daemon deployment; entries self-expire and are swept when the
  // map grows large so distinct-IP traffic can't leak memory.
  const LOGIN_MAX = 10, LOGIN_WINDOW_MS = 5 * 60_000;
  const loginHits = new Map<string, { count: number; resetAt: number }>();
  const loginLimited = (ip: string, now: number): boolean => {
    if (loginHits.size > 5000) for (const [k, v] of loginHits) if (now >= v.resetAt) loginHits.delete(k);
    const h = loginHits.get(ip);
    if (!h || now >= h.resetAt) { loginHits.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS }); return false; }
    h.count++;
    return h.count > LOGIN_MAX;
  };
  app.post('/auth/login', async (c) => {
    const ip = c.req.header('x-real-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (loginLimited(ip, d.clock.now())) return c.json({ error: 'too many login attempts, try again later' }, 429);
    // A missing/invalid body fails the schema → onError maps it to a 400, never an unhandled 500.
    const body = await parseBody(c, loginSchema);
    const user = users.verify(body.username, body.password);
    if (!user) return c.json({ error: 'invalid credentials' }, 401);
    loginHits.delete(ip); // a valid login clears the counter so an earlier typo streak can't lock the user out
    const token = users.issueToken(user.id);
    void d.advisor?.ensureOnLogin(user.id); // fire-and-forget: bring the user's advisor back up; never block login
    // Surface the token's TTL so the web BFF can persist the session cookie for exactly as long as the
    // daemon will accept the token — otherwise it falls back to a session cookie the browser drops early.
    return c.json({ token, user, tokenTtlDays: d.config.get().security.tokenTtlDays });
  });
  app.post('/auth/logout', (c) => { const t = c.get('token'); if (t) users.revokeToken(t); return c.json({ ok: true }); });
  app.get('/auth/me', (c) => c.json({ user: c.get('user') }));
  // Self-service profile: name / email / preferred default executor. A user edits only their own.
  app.patch('/auth/me', async (c) => {
    const u = c.get('user');
    const b = await parseBody(c, profilePatchSchema);
    if (typeof b.default_exec === 'string' && b.default_exec) {
      // The preferred default must be one the user is actually allowed to run.
      const globalOk = d.config.get().allowedExecs.includes(b.default_exec);
      const personalOk = u.allowed_execs.length === 0 || u.allowed_execs.includes(b.default_exec);
      if (!globalOk || !personalOk) return c.json({ error: 'exec not allowed' }, 400);
    }
    return c.json(users.setProfile(u.id, { name: b.name, email: b.email, default_exec: b.default_exec }));
  });
  // Self-service password change: verify the current password, then swap in the new one. A wrong
  // current password is rejected (401) so it can't be used to set a password without knowing it.
  app.post('/auth/me/password', async (c) => {
    const u = c.get('user');
    const b = await parseBody(c, passwordChangeSchema);
    // 403, not 401: the caller IS authenticated — this action is refused because the supplied current
    // password is wrong. A 401 would make the web client treat it as session expiry and log the user
    // out for a simple typo (req() clears the token on 401), and drop the explanatory body with it.
    if (!users.changePassword(u.id, b.currentPassword, b.newPassword)) {
      return c.json({ error: 'current password is incorrect' }, 403);
    }
    return c.json({ ok: true });
  });
  // Self-service prompt overrides: each user edits their own agent prompts (workers/pilot/overseer/
  // advisor/decision). The catalog is the allow-list of editable templates; `default` (the shipped
  // `.md`) ships alongside the override so the UI can render diff/reset without a second fetch. Absence
  // of an override row means "use the default" — so a fresh user automatically gets the shipped prompts.
  app.get('/auth/me/prompts', (c) => {
    const u = c.get('user');
    const overrides = d.userPrompts?.getAll(u.id) ?? {};
    return c.json(EDITABLE_PROMPTS.map((p) => ({
      name: p.name, group: p.group, vars: p.vars, jsonContract: p.jsonContract,
      appendOnly: p.appendOnly === true,
      // Append-only templates are system-managed: the shipped text stays server-side (the user only
      // writes their extra instructions), so don't ship the default to the browser.
      default: p.appendOnly ? '' : rawTemplate(p.name), override: overrides[p.name] ?? null,
    })));
  });
  app.put('/auth/me/prompts/:name', async (c) => {
    if (!d.userPrompts) return c.json({ error: 'prompts unavailable' }, 400);
    const name = c.req.param('name');
    if (!isEditablePrompt(name)) return c.json({ error: 'unknown prompt' }, 400);
    const b = await parseBody(c, promptSaveSchema);
    // Append-only templates take a short instructions block, not a whole prompt document.
    if (isAppendOnlyPrompt(name) && b.content.length > 4000) return c.json({ error: 'too long (max 4000 chars)' }, 400);
    d.userPrompts.set(c.get('user').id, name, b.content);
    return c.json({ ok: true });
  });
  app.delete('/auth/me/prompts/:name', (c) => {
    if (!d.userPrompts) return c.json({ error: 'prompts unavailable' }, 400);
    const name = c.req.param('name');
    if (!isEditablePrompt(name)) return c.json({ error: 'unknown prompt' }, 400);
    d.userPrompts.remove(c.get('user').id, name);
    return c.json({ ok: true });
  });
  // Per-user CLI/brain settings (model override + auto-compact) — self-service, consumed by `orca chat`.
  // `serverDefault` tells the UI what "empty model" resolves to: the first dedicated brain provider's
  // first model, else the autopilot relay model (the brain's legacy fallback).
  const serverDefaultModel = () => {
    const cfg = d.config.get();
    return cfg.brain.providers[0]?.models[0] || cfg.autopilot.model;
  };
  app.get('/auth/me/cli-settings', (c) => {
    const u = c.get('user');
    const s = d.userSettings?.cliSettings(u.id) ?? { model: '', autoCompact: false, autoCompactAt: 80 };
    return c.json({ ...s, serverDefault: serverDefaultModel() });
  });
  app.patch('/auth/me/cli-settings', async (c) => {
    if (!d.userSettings) return c.json({ error: 'settings unavailable' }, 400);
    const u = c.get('user');
    const b = (await c.req.json().catch(() => ({}))) as { model?: unknown; modelProvider?: unknown; autoCompact?: unknown; autoCompactAt?: unknown };
    const patch: { model?: string; modelProvider?: string; autoCompact?: boolean; autoCompactAt?: number } = {};
    if (typeof b.model === 'string') patch.model = b.model.trim();
    if (typeof b.modelProvider === 'string') patch.modelProvider = b.modelProvider.trim();
    if (typeof b.autoCompact === 'boolean') patch.autoCompact = b.autoCompact;
    if (typeof b.autoCompactAt === 'number') patch.autoCompactAt = b.autoCompactAt;
    d.userSettings.setCliSettings(u.id, patch);
    // Apply live: a running brain restarts with the new settings (history rehydrates from SQLite),
    // so a model change takes effect immediately instead of on the next daemon/chat restart.
    await d.brain?.restart(u.id);
    return c.json({ ...d.userSettings.cliSettings(u.id), serverDefault: serverDefaultModel() });
  });
  // Avatar upload (multipart). Validated by type + size; stored as <userId>.<ext> under avatarsDir.
  const AVATAR_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  const AVATAR_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  app.post('/auth/me/avatar', async (c) => {
    if (!d.avatarsDir) return c.json({ error: 'avatars unavailable' }, 400);
    const u = c.get('user');
    const form = await c.req.formData();
    const file = form.get('avatar');
    if (!(file instanceof File)) return c.json({ error: 'avatar file required' }, 400);
    const ext = AVATAR_EXT[file.type];
    if (!ext) return c.json({ error: 'unsupported image type' }, 415);
    if (file.size > 2 * 1024 * 1024) return c.json({ error: 'image too large (max 2MB)' }, 413);
    mkdirSync(d.avatarsDir, { recursive: true });
    // Drop any prior avatar of a different extension so a user never keeps two files.
    for (const e of Object.values(AVATAR_EXT)) { if (e !== ext) { const f = join(d.avatarsDir, `${u.id}.${e}`); if (existsSync(f)) { try { unlinkSync(f); } catch { /* best-effort */ } } } }
    const filename = `${u.id}.${ext}`;
    writeFileSync(join(d.avatarsDir, filename), Buffer.from(await file.arrayBuffer()));
    return c.json(users.setAvatar(u.id, filename));
  });
  // Short-lived signed URL for a user's avatar. An <img> can't set an Authorization header, so the
  // old approach put the long-lived session token in the query string (leaked into logs/referrer/
  // history — finding W2). Instead, an AUTHENTICATED caller mints a signed link here; the link
  // carries only an HMAC over (id, exp) that expires in minutes, so a leaked URL is near-worthless.
  const AVATAR_URL_TTL_MS = 5 * 60 * 1000;
  const signAvatar = (id: number, exp: number): string =>
    createHmac('sha256', d.avatarSecret!).update(`${id}.${exp}`).digest('hex');
  const avatarSigValid = (id: number, exp: number, sig: string): boolean => {
    if (!d.avatarSecret || !Number.isFinite(exp) || exp < Date.now()) return false;
    const expected = Buffer.from(signAvatar(id, exp), 'hex');
    const got = Buffer.from(sig, 'hex');
    return expected.length === got.length && timingSafeEqual(expected, got);
  };
  app.get('/users/:id/avatar/url', (c) => {
    if (!d.avatarsDir || !d.avatarSecret) return c.json({ error: 'avatars unavailable' }, 400);
    const id = Number(c.req.param('id'));
    const target = users.get(id);
    if (!target || !target.avatar) return c.json({ error: 'not found' }, 404);
    const exp = Date.now() + AVATAR_URL_TTL_MS;
    return c.json({ url: `/users/${id}/avatar?exp=${exp}&sig=${signAvatar(id, exp)}` });
  });
  // Serve a user's avatar bytes. Reachable as an <img> src via a short-lived `exp`+`sig` signature
  // (minted above); the bearer path still works for direct API use.
  app.get('/users/:id/avatar', (c) => {
    if (!d.avatarsDir) return c.json({ error: 'not found' }, 404);
    const id = Number(c.req.param('id'));
    const exp = Number(c.req.query('exp'));
    const sig = c.req.query('sig');
    // Allow either a valid signature (the <img> path) or the authenticated session (bearer/token,
    // which the auth middleware already validated for any non-signed request that reached here).
    if (sig != null) { if (!avatarSigValid(id, exp, sig)) return c.json({ error: 'forbidden' }, 403); }
    const target = users.get(id);
    if (!target || !target.avatar) return c.json({ error: 'not found' }, 404);
    const path = join(d.avatarsDir, target.avatar);
    if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
    const ext = target.avatar.split('.').pop() ?? '';
    const body = new Uint8Array(readFileSync(path)).buffer;
    return c.body(body, 200, { 'content-type': AVATAR_MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  });
  app.get('/users', (c) => c.json(users.list()));
  app.post('/users', async (c) => {
    const { username, password } = await c.req.json();
    // Allow creation during setup (no users yet), otherwise admin only
    if (users.count() > 0) {
      const actor = c.get('user');
      if (!actor || !users.isAdmin(actor.id)) return c.json({ error: 'forbidden' }, 403);
    }
    try { return c.json(users.create(username, password), 201); }
    catch { return c.json({ error: 'username taken' }, 409); }
  });
  app.delete('/users/:id', (c) => {
    if (users.count() <= 1) return c.json({ error: 'cannot delete the last user' }, 400);
    // Never delete the admin: it would lock out assignment management and (on restart) silently
    // re-elect another user as admin. The flag must be transferred deliberately first.
    if (users.isAdmin(Number(c.req.param('id')))) return c.json({ error: 'cannot delete the admin' }, 400);
    const id = Number(c.req.param('id'));
    users.delete(id);
    d.userSettings?.removeForUser(id); // drop the user's CLI/brain settings so no orphan rows linger
    return c.json({ ok: true });
  });

  // Admin edits another user's permissions: role (is_admin) and per-user model allow-list.
  app.patch('/users/:id', async (c) => {
    const actor = c.get('user');
    if (!actor || !users.isAdmin(actor.id)) return c.json({ error: 'forbidden' }, 403);
    const id = Number(c.req.param('id'));
    const target = users.get(id);
    if (!target) return c.json({ error: 'user not found' }, 404);
    const b = await parseBody(c, userPermissionsSchema);
    if (typeof b.is_admin === 'boolean') {
      // Refuse to demote the last admin — it would lock out role/assignment management.
      if (!b.is_admin && target.is_admin && users.adminCount() <= 1) return c.json({ error: 'cannot demote the last admin' }, 400);
      users.setAdmin(id, b.is_admin);
    }
    if (Array.isArray(b.allowed_execs)) {
      // Can't grant beyond what the daemon globally allows; keep only known execs (dedup).
      const globalAllowed = new Set(d.config.get().allowedExecs);
      users.setAllowedExecs(id, [...new Set(b.allowed_execs.filter((e) => typeof e === 'string' && globalAllowed.has(e)))]);
    }
    return c.json(users.get(id));
  });

  // User ↔ project assignments. Only the bootstrap admin may view/manage them.
  if (d.userProjects) {
    const up = d.userProjects;
    const adminOnly = (c: { get: (k: 'user') => User }) => up.isAdmin(c.get('user').id);
    app.get('/users/:id/projects', (c) => {
      if (!adminOnly(c)) return c.json({ error: 'forbidden' }, 403);
      return c.json(up.forUser(Number(c.req.param('id'))));
    });
    app.post('/users/:id/projects', async (c) => {
      if (!adminOnly(c)) return c.json({ error: 'forbidden' }, 403);
      const { projectId } = await parseBody(c, projectAssignSchema);
      up.assign(Number(c.req.param('id')), Number(projectId));
      return c.json({ ok: true });
    });
    app.delete('/users/:id/projects/:pid', (c) => {
      if (!adminOnly(c)) return c.json({ error: 'forbidden' }, 403);
      up.unassign(Number(c.req.param('id')), Number(c.req.param('pid')));
      return c.json({ ok: true });
    });
  }
}
