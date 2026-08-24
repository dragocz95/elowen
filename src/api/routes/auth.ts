import { join } from 'node:path';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseBody } from '../validation.js';
import { loginSchema, profilePatchSchema, passwordChangeSchema, userPermissionsSchema, projectAssignSchema, promptSaveSchema, userCreateSchema } from '../schemas/auth.js';
import { editablePrompts, isEditablePrompt, isAppendOnlyPrompt } from '../../prompts/catalog.js';
import { isExecAllowedForUser, isConfiguredBrainExec } from '../../shared/execs.js';
import { brainProviderIds } from '../../store/configStore.js';
import { grantablePluginNames } from '../../shared/pluginAccess.js';
import { discoverPlugins } from '../../plugins/loader.js';
import { BUILTIN_TOOL_ICONS, builtinToolMetas } from '../../brain/tools/index.js';
import { isPluginAllowedForUser } from '../../shared/pluginAccess.js';
import { makeToolIconResolver } from '../../brain/toolIcons.js';
import { toolPermitted } from '../../plugins/policyContext.js';
import { ADVISOR_STYLES, DEFAULT_ADVISOR_STYLE } from '../../brain/personality.js';
import { rawTemplate } from '../../prompts/index.js';
import { DiscordIdConflictError, WhatsAppNumberConflictError, TelegramIdConflictError, TeamsIdConflictError } from '../../store/userSettingStore.js';
import { sanitizeTerminalSettings, type TerminalSettings } from '../../store/terminalSettings.js';
import { sanitizePermissionSettings } from '../../brain/toolPermissions.js';
import { sanitizeNavSettings } from '../../store/navSettings.js';
import { EmailConflictError, UsernameConflictError } from '../../store/userStore.js';
import type { User } from '../../store/userStore.js';
import { clientOrigin } from '../clientIp.js';
import type { ElowenApp, RouteContext } from '../context.js';
import { logger } from '../../shared/logger.js';

const log = logger('auth');

/** Auth + user-management routes: login (rate-limited), session lifecycle, self-service profile /
 *  password / avatar, admin user CRUD and user↔project assignments. No-op without a user store. */
export function registerAuthRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d } = ctx;
  if (!d.users) return;
  const users = d.users;

  app.post('/auth/login', async (c) => {
    // Keyed on the origin VALUE, trusted or not: an unverifiable claim must still be rate-limited, and
    // bucketing every unproxied hit under one key is the conservative direction for a loopback client.
    const ip = clientOrigin(c, d.config.get().security.trustProxy).value;
    if (ctx.loginRateLimiter.limited(ip, d.clock.now())) return c.json({ error: 'too many login attempts, try again later' }, 429);
    // A missing/invalid body fails the schema → onError maps it to a 400, never an unhandled 500.
    const body = await parseBody(c, loginSchema);
    const user = users.verify(body.username, body.password);
    if (!user) return c.json({ error: 'invalid credentials' }, 401);
    ctx.loginRateLimiter.clear(ip); // a valid login clears the counter so an earlier typo streak can't lock the user out
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
      // The preferred default must be one the user is actually allowed to run — asked through the SHARED
      // rule, not a second copy of it. The copy that used to live here had drifted from
      // isExecAllowedForUser in two ways: it had no admin bypass, and it applied the global allow-list to
      // `elowen:` brain execs, which are bounded by the configured providers instead. So a model the
      // brain picker offered could not be saved as the default here.
      if (!isExecAllowedForUser(u, d.config.get().allowedExecs, b.default_exec, brainProviderIds(d.config))) {
        return c.json({ error: 'exec not allowed' }, 400);
      }
    }
    try {
      return c.json(users.setProfile(u.id, { name: b.name, email: b.email, default_exec: b.default_exec }));
    } catch (error) {
      if (error instanceof EmailConflictError) {
        console.warn(`profile: user ${u.id} tried to claim an e-mail already used by another account`);
        return c.json({ error: 'Tento e-mail už používá jiný uživatel.' }, 409);
      }
      throw error;
    }
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
    return c.json(editablePrompts().map((p) => ({
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
  // Per-user CLI/brain settings (model override + auto-compact) — self-service, consumed by `elowen chat`.
  // `serverDefault` tells the UI what "empty model" resolves to: the first dedicated brain provider's
  // first model, else the autopilot relay model (the brain's legacy fallback).
  const serverDefaultModel = () => {
    const cfg = d.config.get();
    return cfg.brain.providers[0]?.models[0] || cfg.autopilot.model;
  };
  app.get('/auth/me/cli-settings', (c) => {
    const u = c.get('user');
    const s = d.userSettings?.cliSettings(u.id) ?? { model: '', modelProvider: '', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '', autoCompact: false, autoCompactAt: 80, autoCompactAtByModel: {}, advisorStyle: DEFAULT_ADVISOR_STYLE, personalityBody: '', discordUserId: '', whatsappNumber: '', telegramUserId: '', msteamsUserId: '', autoRecall: true, autoLiveRecall: true, autoSave: true };
    return c.json({ ...s, userInstructions: s.personalityBody, serverDefault: serverDefaultModel() });
  });
  app.patch('/auth/me/cli-settings', async (c) => {
    if (!d.userSettings) return c.json({ error: 'settings unavailable' }, 400);
    const u = c.get('user');
    const b = (await c.req.json().catch(() => ({}))) as { model?: unknown; modelProvider?: unknown; visionModel?: unknown; visionModelProvider?: unknown; compactModel?: unknown; compactModelProvider?: unknown; thinkingLevel?: unknown; autoCompact?: unknown; autoCompactAt?: unknown; autoCompactAtByModel?: unknown; advisorStyle?: unknown; userInstructions?: unknown; personalityBody?: unknown; discordUserId?: unknown; whatsappNumber?: unknown; telegramUserId?: unknown; msteamsUserId?: unknown; autoRecall?: unknown; autoLiveRecall?: unknown; autoSave?: unknown };
    const patch: { model?: string; modelProvider?: string; visionModel?: string; visionModelProvider?: string; compactModel?: string; compactModelProvider?: string; thinkingLevel?: string; autoCompact?: boolean; autoCompactAt?: number; autoCompactAtByModel?: Record<string, number>; advisorStyle?: string; personalityBody?: string; discordUserId?: string; whatsappNumber?: string; telegramUserId?: string; msteamsUserId?: string; autoRecall?: boolean; autoLiveRecall?: boolean; autoSave?: boolean } = {};
    if (typeof b.model === 'string') patch.model = b.model.trim();
    if (typeof b.modelProvider === 'string') patch.modelProvider = b.modelProvider.trim();
    if (typeof b.visionModel === 'string') patch.visionModel = b.visionModel.trim();
    if (typeof b.visionModelProvider === 'string') patch.visionModelProvider = b.visionModelProvider.trim();
    if (typeof b.compactModel === 'string') patch.compactModel = b.compactModel.trim();
    if (typeof b.compactModelProvider === 'string') patch.compactModelProvider = b.compactModelProvider.trim();
    if (typeof b.thinkingLevel === 'string') patch.thinkingLevel = b.thinkingLevel.trim(); // store validates the level

    if (typeof b.autoCompact === 'boolean') patch.autoCompact = b.autoCompact;
    if (typeof b.autoCompactAt === 'number') patch.autoCompactAt = b.autoCompactAt;
    // Per-model threshold map (key `providerId/model` → percent). The store cleans/clamps every entry, so
    // the route only gates on it being a plain object; a non-object (or array) is ignored.
    if (b.autoCompactAtByModel && typeof b.autoCompactAtByModel === 'object' && !Array.isArray(b.autoCompactAtByModel)) patch.autoCompactAtByModel = b.autoCompactAtByModel as Record<string, number>;
    if (typeof b.autoRecall === 'boolean') patch.autoRecall = b.autoRecall;
    if (typeof b.autoLiveRecall === 'boolean') patch.autoLiveRecall = b.autoLiveRecall;
    if (typeof b.autoSave === 'boolean') patch.autoSave = b.autoSave;
    if (typeof b.discordUserId === 'string') patch.discordUserId = b.discordUserId.trim(); // store validates the snowflake shape
    if (typeof b.whatsappNumber === 'string') patch.whatsappNumber = b.whatsappNumber.trim(); // store normalizes to digits
    if (typeof b.telegramUserId === 'string') patch.telegramUserId = b.telegramUserId.trim(); // store validates the numeric-id shape
    if (typeof b.msteamsUserId === 'string') patch.msteamsUserId = b.msteamsUserId.trim(); // store validates the GUID / `29:…` shape
    // Communication style: only accept a known style; anything else is silently ignored.
    if (typeof b.advisorStyle === 'string' && ADVISOR_STYLES.includes(b.advisorStyle as never)) patch.advisorStyle = b.advisorStyle;
    // Global account instructions appended to the system prompt on every platform. `personalityBody` is a
    // compatibility alias for older clients and the persisted DB key; the semantic API name wins on conflict.
    const userInstructions = typeof b.userInstructions === 'string'
      ? b.userInstructions
      : typeof b.personalityBody === 'string' ? b.personalityBody : undefined;
    if (userInstructions !== undefined) patch.personalityBody = userInstructions.slice(0, 100_000);
    // A complete provider+model pick must be on the caller's allow-list (clearing is always fine). The
    // pick is already structured here, so it is judged as an ExecRef: the gate decides on `program`
    // instead of on a prefix this route would first have had to write into a string.
    const brainRef = (provider: string, model: string) => ({ program: 'elowen' as const, provider, model });
    const providers = brainProviderIds(d.config);
    if (patch.model && patch.modelProvider
      && !isExecAllowedForUser(u, d.config.get().allowedExecs, brainRef(patch.modelProvider, patch.model), providers)) {
      return c.json({ error: 'model not allowed' }, 400);
    }
    if (patch.visionModel && patch.visionModelProvider
      && !isExecAllowedForUser(u, d.config.get().allowedExecs, brainRef(patch.visionModelProvider, patch.visionModel), providers)) {
      return c.json({ error: 'model not allowed' }, 400);
    }
    if (patch.compactModel && patch.compactModelProvider
      && !isExecAllowedForUser(u, d.config.get().allowedExecs, brainRef(patch.compactModelProvider, patch.compactModel), providers)) {
      return c.json({ error: 'model not allowed' }, 400);
    }
    try {
      d.userSettings.setCliSettings(u.id, patch);
    } catch (e) {
      // A Discord snowflake may belong to only one Elowen account — reject a squatter cleanly instead of
      // redirecting the first owner's identity/memory namespace.
      if (e instanceof DiscordIdConflictError) {
        console.warn(`cli-settings: user ${u.id} tried to link Discord id already claimed by another user`);
        return c.json({ error: 'Toto Discord ID už má propojené jiný uživatel.' }, 409);
      }
      if (e instanceof WhatsAppNumberConflictError) {
        console.warn(`cli-settings: user ${u.id} tried to link WhatsApp number already claimed by another user`);
        return c.json({ error: 'Toto WhatsApp číslo už má propojené jiný uživatel.' }, 409);
      }
      if (e instanceof TelegramIdConflictError) {
        console.warn(`cli-settings: user ${u.id} tried to link Telegram id already claimed by another user`);
        return c.json({ error: 'Toto Telegram ID už má propojené jiný uživatel.' }, 409);
      }
      if (e instanceof TeamsIdConflictError) {
        console.warn(`cli-settings: user ${u.id} tried to link Teams id already claimed by another user`);
        return c.json({ error: 'Tuto identitu Microsoft Teams už má propojenou jiný uživatel.' }, 409);
      }
      throw e;
    }
    // The auto-compact threshold applies to the RUNNING conversations right away — the respawn below only
    // covers this user's active chat, so without this a change would silently miss their other live
    // conversations and every channel session they own (Discord), which is where it matters most.
    d.brain?.applyAutoCompactSettings(u.id);
    // Apply live in the BACKGROUND: a running brain respawns with the new settings (history rehydrates
    // from SQLite) so a model/persona change takes effect immediately instead of on the next chat restart.
    // Changed user instructions feed the system prompt on EVERY platform, so they also drop the shared
    // channel sessions (Discord) via applyUserInstructionsChange — which itself restarts owner chat, so we
    // don't also call restart. An unrelated save keeps the lighter owner-chat-only restart.
    //
    // The persist above is what this save confirms, so the response must NOT block on the respawn: restart
    // waits for any in-flight turn to settle before disposing the session, so an owner mid-turn (or a stuck
    // turn retrying against a flaky model relay) would otherwise stall the PATCH for minutes and leave the
    // web "saving" indicator hung. Fire-and-forget with error logging; both re-apply paths are serialized
    // in the brain, so overlapping saves queue safely.
    // A conversation normally keeps the model it was running on across a respawn (see ensureLive). That
    // pin must NOT survive the save that changes the model setting itself, or the page would report one
    // model while the chat kept using another — so this restart says so explicitly.
    const modelChanged = patch.model !== undefined || patch.modelProvider !== undefined;
    const reapply = patch.personalityBody !== undefined
      ? d.brain?.applyUserInstructionsChange(u.id)
      : d.brain?.restart(u.id, { reapplyModelPreference: modelChanged });
    void Promise.resolve(reapply).catch((e) => console.warn(`cli-settings: live re-apply for user ${u.id} failed: ${e instanceof Error ? e.message : String(e)}`));
    const saved = d.userSettings.cliSettings(u.id);
    return c.json({ ...saved, userInstructions: saved.personalityBody, serverDefault: serverDefaultModel() });
  });
  // Per-user web-terminal appearance (xterm palette/font/cursor) — self-service, kept separate from
  // cli-settings so it neither trips the model allow-list nor restarts the brain. The store validates
  // and clamps every field, so the route just forwards the (untrusted) body.
  app.get('/auth/me/terminal-settings', (c) => {
    const u = c.get('user');
    return c.json(d.userSettings ? d.userSettings.terminalSettings(u.id) : sanitizeTerminalSettings({}));
  });
  app.patch('/auth/me/terminal-settings', async (c) => {
    if (!d.userSettings) return c.json({ error: 'settings unavailable' }, 400);
    const u = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as Partial<TerminalSettings>;
    return c.json(d.userSettings.setTerminalSettings(u.id, body));
  });
  // Per-user granular tool permissions (allow/ask/deny rules + the persisted YOLO default) —
  // self-service, each caller edits only their own. The store sanitizes the untrusted body (unknown
  // actions/keys dropped, rule-map insertion order preserved — it decides precedence); a present
  // `tools`/`bash` map replaces the stored one wholesale. Read fresh by every brain turn, so a change
  // applies immediately without a session restart.
  app.get('/auth/me/permissions', (c) => {
    const u = c.get('user');
    return c.json(d.userSettings ? d.userSettings.permissionSettings(u.id) : sanitizePermissionSettings({}));
  });
  app.patch('/auth/me/permissions', async (c) => {
    if (!d.userSettings) return c.json({ error: 'settings unavailable' }, 400);
    const u = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as unknown;
    return c.json(d.userSettings.setPermissionSettings(u.id, body));
  });
  // Per-user layout of the primary navigation (hidden entries + preferred order) — self-service, each
  // caller edits only their own. Ids are opaque to the daemon: the store bounds and deduplicates them,
  // the web resolves them against the entries it can actually see. Kept out of cli-settings so a menu
  // tweak neither touches the model allow-list nor restarts the brain.
  app.get('/auth/me/nav-settings', (c) => {
    const u = c.get('user');
    return c.json(d.userSettings ? d.userSettings.navSettings(u.id) : sanitizeNavSettings({}));
  });
  app.patch('/auth/me/nav-settings', async (c) => {
    if (!d.userSettings) return c.json({ error: 'settings unavailable' }, 400);
    const u = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as unknown;
    return c.json(d.userSettings.setNavSettings(u.id, body));
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
  /** The ONE admin check the account-administration routes below share. It reads the admin bit through
   *  `users`, the same store every other API gate now reads, so this file cannot drift from them — the
   *  project-assignment routes used to ask `userProjects` instead, a second implementation of one fact. */
  const denyNonAdmin = (c: { get: (k: 'user') => User | undefined }): boolean => {
    const u = c.get('user');
    return !u || !users.isAdmin(u.id);
  };

  app.get('/users', (c) => {
    // Admin-only directory, but stay open during setup (no users yet) so onboarding can read it.
    if (users.count() > 0) {
      if (denyNonAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    }
    return c.json(users.list());
  });
  app.post('/users', async (c) => {
    const b = await parseBody(c, userCreateSchema); // 400 on empty/malformed body or a sub-8-char password
    // Allow creation during setup (no users yet), otherwise admin only
    if (users.count() > 0) {
      if (denyNonAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    }
    try { return c.json(users.create(b.username, b.password), 201); }
    catch (e) {
      // Only a duplicate username is a 409; any other failure is a real error, not "taken".
      if (e instanceof Error && /UNIQUE/i.test(e.message)) return c.json({ error: 'username taken' }, 409);
      throw e;
    }
  });
  app.delete('/users/:id', async (c) => {
    // Admin-only — mirrors POST/PATCH /users. Without this a non-admin could delete other users
    // and cascade-wipe their settings/personality/memory.
    if (denyNonAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid user id' }, 400); // a non-numeric id must 400, not silently no-op
    if (users.count() <= 1) return c.json({ error: 'cannot delete the last user' }, 400);
    // Never delete the admin: it would lock out assignment management and (on restart) silently
    // re-elect another user as admin. The flag must be transferred deliberately first.
    if (users.isAdmin(id)) return c.json({ error: 'cannot delete the admin' }, 400);
    // Teardown order is load-bearing: kill what is RUNNING first, drop the user's data next, and remove
    // the user row LAST.
    //   • The advisor is a full agent CLI in its own tmux (`elowen-advisor-<id>`) holding shell access.
    //     Nothing else ever reaps it, so leaving it up keeps a deleted account's agent running.
    //     advisor.stop() also needs the user row (it clears advisor_autostart).
    //   • Brain-session teardown resolves each conversation's `brain_terminals` binding to kill its
    //     `elowen chat` tmux and revoke that terminal's token. users.delete() wipes `brain_terminals`,
    //     so running it first leaves the binding unresolvable and the terminal alive.
    // Deleting the user row last also makes a failed cleanup safely retryable: every step below is
    // idempotent, and while the row still exists the admin can simply repeat the request.
    await d.advisor?.stop(id);
    // Dispose any live conversations (+ their terminals/processes) for the user, then hard-delete ALL of
    // their brain data and push devices. Without this a deleted user's private transcripts and browser
    // subscriptions survive.
    d.brain?.deleteAllManagedSessions(id);
    d.userSettings?.removeForUser(id); // drop the user's CLI/brain settings (incl. personalityBody) so no orphan rows linger
    d.memoryStore?.removeForUser(id); // hard-delete the user's memories (+cascade embeddings) and audit events
    d.memoryCategoryStore?.removeForUser(id); // drop the user's memory categories so no orphan rows linger
    d.brainStore?.removeForUser(id);
    d.pushSubscriptions?.removeAllForUser(id);
    // Per-user state a PLUGIN owns sits outside this store (its data-dir folders, its JSON schedules),
    // so the core cascade above cannot reach it — each plugin drops its own through the seam. Runs while
    // the user row still exists (a handler may need to read it), and one failing plugin must not strand
    // the rest of the teardown: the delete stays retryable either way.
    const pluginRegistry = await d.plugins?.get().catch(() => undefined);
    for (const h of pluginRegistry?.userRemovedHandlers ?? []) {
      try { await h.fn(id); }
      catch (e) { log.warn(`plugin ${h.plugin} failed to drop data for user ${id}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    users.delete(id);
    return c.json({ ok: true });
  });

  // Admin edits another user's permissions: role (is_admin) and per-user model allow-list.
  app.patch('/users/:id', async (c) => {
    if (denyNonAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const id = Number(c.req.param('id'));
    const target = users.get(id);
    if (!target) return c.json({ error: 'user not found' }, 404);
    const b = await parseBody(c, userPermissionsSchema);
    // Identity first: a taken username aborts the whole patch with a 409 before anything else is written,
    // so a rejected rename can never leave the other fields half-applied.
    if (typeof b.username === 'string' && b.username.trim() !== target.username) {
      try { users.setUsername(id, b.username); }
      catch (e) {
        if (e instanceof UsernameConflictError) return c.json({ error: 'username taken' }, 409);
        throw e;
      }
    }
    if (typeof b.name === 'string') users.setProfile(id, { name: b.name.trim() });
    if (typeof b.is_admin === 'boolean') {
      // Refuse to demote the last admin — it would lock out role/assignment management.
      if (!b.is_admin && target.is_admin && users.adminCount() <= 1) return c.json({ error: 'cannot demote the last admin' }, 400);
      users.setAdmin(id, b.is_admin);
    }
    if (Array.isArray(b.allowed_execs)) {
      // Can't grant beyond what the daemon globally allows; keep only known execs (dedup). Brain execs
      // are bounded by the configured providers, not KNOWN_EXECS, so they're granted directly — asked
      // through the shared program test, not a prefix comparison of my own.
      const globalAllowed = new Set(d.config.get().allowedExecs);
      const providers = brainProviderIds(d.config);
      // A brain exec is granted directly, but only when its provider is actually configured: the bare
      // `provider/model` spelling means any typo now parses as a brain exec, and `isElowenExec` alone
      // would wave it past the global bound.
      users.setAllowedExecs(id, [...new Set(b.allowed_execs.filter((e) => typeof e === 'string' && (isConfiguredBrainExec(e, providers) || globalAllowed.has(e))))]);
    }
    if (Array.isArray(b.disabled_tools)) {
      users.setDisabledTools(id, b.disabled_tools.filter((t) => typeof t === 'string'));
    }
    // The positive grant. Names are NOT clamped to a catalogue: a tool may legitimately be granted while
    // its plugin is disabled or its MCP server is offline, and dropping it here would silently revoke the
    // grant the moment an admin toggles that plugin off and on again — the same trap `granted_plugins`
    // documents just below. An unknown name simply never matches anything.
    if (Array.isArray(b.allowed_tools)) {
      users.setAllowedTools(id, b.allowed_tools.filter((t) => typeof t === 'string'));
    }
    if (Array.isArray(b.granted_plugins)) {
      // Clamp to plugins that actually declare `userGrantable`, read from the manifests ON DISK rather
      // than from the live registry: a DISABLED plugin has no registry entry, and dropping its grant
      // here would silently revoke every user the moment an admin toggles that plugin off and on again.
      const grantable = new Set(grantablePluginNames(discoverPlugins(d.pluginDirs ?? []).map((p) => p.manifest)));
      users.setGrantedPlugins(id, b.granted_plugins.filter((p) => typeof p === 'string' && grantable.has(p)));
    }
    return c.json(users.get(id));
  });

  // Admin: the tools a user can actually reach, for the users-panel pills. One pass over the live plugin
  // registry + the built-in tool catalog — no N+1. State is DERIVED (there's no stored per-user tool
  // grant): Elowen* control-plane is operator/admin-only; Memory* is inherited by every interactive
  // session (per-user scoped); plugin tools ride along for the user's sessions (path-level access is
  // still enforced at execute). `icon` is the manifest/built-in emoji, or null → the client's fallback.
  app.get('/users/:id/tools', async (c) => {
    if (denyNonAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const id = Number(c.req.param('id'));
    const target = users.get(id);
    if (!target) return c.json({ error: 'user not found' }, 404);
    const registry = await d.plugins?.get();
    const iconMap = new Map(Object.entries(BUILTIN_TOOL_ICONS));
    for (const [k, v] of registry?.toolIcons ?? []) iconMap.set(k, v);
    const iconOf = makeToolIconResolver(iconMap);
    // Per-user deny-list: a plugin tool the admin switched off for this user's own brain sessions.
    const disabled = new Set(target.disabled_tools);
    // The positive grant, mirroring toolAuthorityForUser: an admin bypasses it entirely, so `null` here
    // reads as "no grant restriction". Everyone else is measured with the SAME predicate the turn path
    // enforces, which is what makes a pattern grant readable: the pre-migration `*` marker and a family
    // grant like `mcp__*` both cover their members, where an exact `Set.has` drew tools that actually run
    // as disabled.
    const grant = target.is_admin ? null : new Set(target.allowed_tools);
    type ToolState = 'allowed' | 'inherited' | 'unavailable' | 'disabled';
    const pills: { name: string; label: string; icon: string | null; plugin: string | null; group: 'memory' | 'image' | 'plugin'; state: ToolState; toggleable: boolean }[] = [];
    // What is left of the built-ins is memory and image: per-user, composed for every interactive
    // session, and inherited rather than granted. The control plane that used to be listed here as an
    // admin-only `elowen` group rides its plugins now and appears below with the other plugin tools.
    for (const m of builtinToolMetas()) {
      pills.push({ name: m.name, label: m.label, icon: iconOf(m.name) ?? null, plugin: null, group: m.group, state: 'inherited', toggleable: false });
    }
    // Mirror what PluginRegistry.toolsFor composes for THIS account: an instance-wide tool, or a personal
    // one this account owns. Another account's personal tool (a personal MCP server's bridged tools) must
    // not be listed here at all — it can never reach this user's session, and listing it also duplicated
    // any name a personal tool deliberately shadows.
    const chosen = new Map<string, { tool: { name: string; label?: string }; personal: boolean }>();
    for (let i = 0; i < (registry?.tools.length ?? 0); i++) {
      const tool = registry!.tools[i]!;
      const ownerUserId = registry!.toolOwnerUsers[i] ?? null;
      if (ownerUserId !== null && ownerUserId !== id) continue;
      const personal = ownerUserId !== null;
      const prior = chosen.get(tool.name);
      if (!prior || (personal && !prior.personal)) chosen.set(tool.name, { tool, personal });
    }
    for (const { tool: t } of chosen.values()) {
      // Three independent inputs decide a plugin tool, and the account must be able to see all of them:
      //
      // `disabled` is the admin's explicit no from the older deny-list, reported FIRST even when the
      // plugin grant is missing. It has to be: this list is the editor for that choice, and hiding an
      // existing "no" behind a missing plugin grant would quietly re-enable the tool the moment the
      // grant came back.
      //
      // `unavailable` is the plugin grant: the plugin was never granted to this account, so the tool
      // cannot reach their session whatever the tool lists say. Nothing to toggle there — granting the
      // plugin in the panel next door is what changes it.
      //
      // Last comes the tool grant itself. Absent from it means the same thing to the admin as a deny —
      // an unchecked box they can check — which is exactly what the PATCH this list drives writes back.
      const plugin = registry?.toolOwner.get(t.name) ?? null;
      const granted = !plugin || isPluginAllowedForUser(target, { name: plugin, userGrantable: registry?.userGrantable.has(plugin) });
      const state: ToolState = disabled.has(t.name) ? 'disabled'
        : !granted ? 'unavailable'
          : grant !== null && !toolPermitted(t.name, { allow: grant }) ? 'disabled' : 'allowed';
      pills.push({ name: t.name, label: t.label ?? t.name, icon: iconOf(t.name) ?? null, plugin, group: 'plugin', state, toggleable: state !== 'unavailable' });
    }
    // Allowed first, then inherited, then disabled/unavailable; alphabetical within each band.
    const rank: Record<ToolState, number> = { allowed: 0, inherited: 1, disabled: 2, unavailable: 3 };
    pills.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
    return c.json(pills);
  });

  // Admin: compact per-user overview stats for the users panel (memory count, brain-session count, and
  // the model used in the most sessions over the whole history). Cheap aggregates on indexed columns.
  app.get('/users/:id/stats', (c) => {
    if (denyNonAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const id = Number(c.req.param('id'));
    if (!users.get(id)) return c.json({ error: 'user not found' }, 404);
    const memoryCount = d.memoryStore?.count(id) ?? 0;
    const { sessionCount, topModel } = d.brainStore?.userStats(id) ?? { sessionCount: 0, topModel: null };
    return c.json({ memoryCount, sessionCount, topModel });
  });

  // Admin "sign in as" — issue a full-scope token for another user so an admin can see exactly what
  // that user sees (support/debugging). Admin-only; the web BFF swaps the session cookie to this token
  // and stashes the admin's own token so it can restore. The returned token is a normal token (revoked
  // when the admin ends the impersonation via logout).
  app.post('/users/:id/impersonate', (c) => {
    if (denyNonAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const actor = c.get('user')!; // present: denyNonAdmin above rejects a request without one
    const id = Number(c.req.param('id'));
    if (id === actor.id) return c.json({ error: 'cannot impersonate yourself' }, 400);
    const target = users.get(id);
    if (!target) return c.json({ error: 'user not found' }, 404);
    const token = users.issueToken(id);
    log.warn(`admin ${actor.username} (#${actor.id}) is now impersonating ${target.username} (#${id})`);
    return c.json({ token, user: target, tokenTtlDays: d.config.get().security.tokenTtlDays });
  });

  // User ↔ project assignments. Only the bootstrap admin may view/manage them.
  if (d.userProjects) {
    const up = d.userProjects;
    app.get('/users/:id/projects', (c) => {
      if (denyNonAdmin(c)) return c.json({ error: 'forbidden' }, 403);
      return c.json(up.forUser(Number(c.req.param('id'))));
    });
    app.post('/users/:id/projects', async (c) => {
      if (denyNonAdmin(c)) return c.json({ error: 'forbidden' }, 403);
      const { projectId } = await parseBody(c, projectAssignSchema);
      const userId = Number(c.req.param('id'));
      const pid = Number(projectId);
      // Both sides must exist BEFORE the grant is written. `user_projects` has no foreign keys and
      // `projects.id` is a plain rowid (no AUTOINCREMENT, unlike `users`), so a row pointing at an id
      // that does not exist yet is not inert: whichever project is created next can receive that id and
      // silently inherit the grant. Home-project tolerance mirrors resolveTarget — a legacy
      // single-project daemon may have no `projects` row for it.
      if (!users.get(userId)) return c.json({ error: 'user not found' }, 404);
      if (pid !== d.project.id && !d.projects?.get(pid)) return c.json({ error: 'project not found' }, 404);
      up.assign(userId, pid);
      return c.json({ ok: true });
    });
    app.delete('/users/:id/projects/:pid', (c) => {
      if (denyNonAdmin(c)) return c.json({ error: 'forbidden' }, 403);
      up.unassign(Number(c.req.param('id')), Number(c.req.param('pid')));
      return c.json({ ok: true });
    });
  }
}
