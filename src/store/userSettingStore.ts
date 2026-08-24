import type { Db } from './db.js';
import { DEFAULT_ADVISOR_STYLE, isAdvisorStyle } from '../brain/personality.js';
import { sanitizeTerminalSettings, mergeTerminalSettings, type TerminalSettings } from './terminalSettings.js';
import { sanitizePermissionSettings, mergePermissionSettings, type PermissionAction, type PermissionScope, type PermissionSettings } from '../brain/toolPermissions.js';
import { sanitizeNavSettings, mergeNavSettings, type NavSettings } from './navSettings.js';
import { isCanonicalThinkingLevel } from '../brain/modelCapabilities.js';
import { PLATFORM_IDENTITIES, platformIdentity, type PlatformIdentityDescriptor, type PlatformLinkKey } from '../shared/platformIdentity.js';

/** Typed per-user CLI/brain settings. `model`/`modelProvider` empty → use the configured brain default.
 *  `autoCompactAt` is the context-window fill percentage at which the conversation is auto-summarized.
 *  `advisorStyle` picks the advisor's communication style (the `{{personality}}` prompt paragraph).
 *  The platform link fields are DERIVED from the identity descriptors, so a new platform gets its
 *  setting field, its validation and its account-view input from one declaration. */
export interface CliSettings extends Record<PlatformLinkKey, string> { model: string; modelProvider: string; visionModel: string; visionModelProvider: string; compactModel: string; compactModelProvider: string; thinkingLevel: string; autoCompact: boolean; autoCompactAt: number; autoCompactAtByModel: Record<string, number>; advisorStyle: string; personalityBody: string; autoRecall: boolean; autoLiveRecall: boolean; autoSave: boolean }
export interface ProjectModelPreference { provider: string; model: string }
// autoRecall/autoLiveRecall default to true so upgrading users keep the prior always-on memory behaviour.
// autoCompact is on because the alternative is a conversation that dies at the context limit instead of
// summarizing itself — the first wall a new user hits. autoSave is off because an automatic curator
// writing memories nobody asked for is harder to undo than a memory that was never saved.
// thinkingLevel stays EMPTY on purpose, meaning "whatever the model does by default". Empty is persisted
// by REMOVING the key, so a non-empty default would make that choice unreachable — and the account UI
// resets the level to empty whenever the active model does not offer it, which would then loop against a
// default that model cannot honour. The level belongs per model, not in the fallback.
const emptyLinks = Object.fromEntries(PLATFORM_IDENTITIES.map((d) => [d.linkSettingKey, ''])) as Record<PlatformLinkKey, string>;
const CLI_DEFAULTS: CliSettings = { model: '', modelProvider: '', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '', autoCompact: true, autoCompactAt: 80, autoCompactAtByModel: {}, advisorStyle: DEFAULT_ADVISOR_STYLE, personalityBody: '', ...emptyLinks, autoRecall: true, autoLiveRecall: true, autoSave: false };

/** The defaults a caller with no settings store falls back to. Exported so nobody has to re-list the
 *  fields — a hand-written copy is exactly how `telegramUserId` went missing from the account view. */
export function cliSettingsDefaults(): CliSettings {
  return { ...CLI_DEFAULTS, autoCompactAtByModel: {} };
}

/** Raised when a user tries to link a platform identity another user has already claimed. ONE class for
 *  every platform, carrying the descriptor's key and its user-facing message, so the route answers 409
 *  without a per-platform branch. The identity link stays with the original owner. */
export class PlatformLinkConflictError extends Error {
  constructor(public readonly platform: string, public readonly linkSettingKey: string, public readonly value: string, public readonly userMessage: string) {
    super(`${platform} identity ${value} is already linked to another user`);
    this.name = 'PlatformLinkConflictError';
  }
}

/** True for a better-sqlite3 UNIQUE-constraint violation — here, the partial index that keeps a platform
 *  identity owned by a single user. Lets the store reject a squatter without a check-then-act race. */
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err
    && (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/** Keep the auto-compact threshold in a sane band — too low would thrash (compact every turn), too high
 *  risks overflowing before it triggers. Non-numbers fall back to the default. */
function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return CLI_DEFAULTS.autoCompactAt;
  return Math.min(95, Math.max(30, Math.round(n)));
}

/** Clean a per-model auto-compact threshold map (key `providerId/model` → percent): keep only entries with
 *  a non-empty key and a finite number, each clamped into the same 30–95 band as the global threshold.
 *  Shared by the reader (post-JSON.parse) and the writer so stored and incoming maps validate identically. */
function cleanThresholdMap(parsed: unknown): Record<string, number> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).flatMap(([key, value]) => {
    const n = Number(value);
    return key && Number.isFinite(n) ? [[key, clampPercent(n)]] : [];
  }));
}

function autoCompactThresholds(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try { return cleanThresholdMap(JSON.parse(raw)); } catch { return {}; }
}

function projectModelPreferences(raw: string | null): Record<string, ProjectModelPreference> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([root, value]) => {
      if (!root || !value || typeof value !== 'object') return [];
      const { provider, model } = value as { provider?: unknown; model?: unknown };
      return typeof provider === 'string' && provider && typeof model === 'string' && model
        ? [[root, { provider, model }]]
        : [];
    }));
  } catch { return {}; }
}

/** Per-user key/value settings. A row exists only for a value the user has explicitly set — absence means
 *  "use the default". Keyed by (user_id, key). Generic, but ships a typed CLI-settings accessor. */
export class UserSettingStore {
  constructor(private db: Db) {}

  get(userId: number, key: string): string | null {
    const r = this.db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
      .get(userId, key) as { value: string } | undefined;
    return r ? r.value : null;
  }

  getAll(userId: number): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?')
      .all(userId) as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  set(userId: number, key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO user_settings (user_id, key, value) VALUES (@user_id, @key, @value)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).run({ user_id: userId, key, value });
  }

  remove(userId: number, key: string): void {
    this.db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key);
  }

  /** Drop all of a user's settings — called on user delete so no orphan rows linger. */
  removeForUser(userId: number): void {
    this.db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(userId);
  }

  /** The user's CLI/brain settings, with defaults filled in. */
  cliSettings(userId: number): CliSettings {
    const all = this.getAll(userId);
    return {
      model: all.model ?? CLI_DEFAULTS.model,
      modelProvider: all.modelProvider ?? CLI_DEFAULTS.modelProvider,
      visionModel: all.visionModel ?? CLI_DEFAULTS.visionModel,
      visionModelProvider: all.visionModelProvider ?? CLI_DEFAULTS.visionModelProvider,
      compactModel: all.compactModel ?? CLI_DEFAULTS.compactModel,
      compactModelProvider: all.compactModelProvider ?? CLI_DEFAULTS.compactModelProvider,
      thinkingLevel: isCanonicalThinkingLevel(all.thinkingLevel ?? '') ? (all.thinkingLevel as string) : CLI_DEFAULTS.thinkingLevel,
      autoCompact: all.autoCompact !== undefined ? all.autoCompact === 'true' : CLI_DEFAULTS.autoCompact,
      autoCompactAt: all.autoCompactAt !== undefined ? clampPercent(Number(all.autoCompactAt)) : CLI_DEFAULTS.autoCompactAt,
      autoCompactAtByModel: autoCompactThresholds(all.autoCompactAtByModel ?? null),
      advisorStyle: isAdvisorStyle(all.advisorStyle) ? all.advisorStyle : CLI_DEFAULTS.advisorStyle,
      personalityBody: all.personalityBody ?? CLI_DEFAULTS.personalityBody,
      ...(Object.fromEntries(PLATFORM_IDENTITIES.map((d) => [d.linkSettingKey, all[d.linkSettingKey] ?? ''])) as Record<PlatformLinkKey, string>),
      autoRecall: all.autoRecall !== undefined ? all.autoRecall === 'true' : CLI_DEFAULTS.autoRecall,
      autoLiveRecall: all.autoLiveRecall !== undefined ? all.autoLiveRecall === 'true' : CLI_DEFAULTS.autoLiveRecall,
      autoSave: all.autoSave !== undefined ? all.autoSave === 'true' : CLI_DEFAULTS.autoSave,
    };
  }

  /** Apply a partial CLI-settings patch (only the provided fields are written). Runs in a transaction so
   *  a rejected platform link (see below) rolls the whole patch back instead of leaving a partial write.
   *  Throws {@link PlatformLinkConflictError} when a requested platform identity is already linked to a
   *  DIFFERENT user — enforced atomically by the partial UNIQUE index, so there is no check-then-act race. */
  setCliSettings(userId: number, patch: Partial<CliSettings>): void {
    this.db.transaction(() => {
      if (patch.model !== undefined) this.set(userId, 'model', patch.model);
      if (patch.modelProvider !== undefined) this.set(userId, 'modelProvider', patch.modelProvider);
      if (patch.visionModel !== undefined) this.set(userId, 'visionModel', patch.visionModel);
      if (patch.visionModelProvider !== undefined) this.set(userId, 'visionModelProvider', patch.visionModelProvider);
      if (patch.compactModel !== undefined) this.set(userId, 'compactModel', patch.compactModel);
      if (patch.compactModelProvider !== undefined) this.set(userId, 'compactModelProvider', patch.compactModelProvider);
      // Empty clears the override (model default); anything else must be a known level.
      if (patch.thinkingLevel !== undefined) {
        if (patch.thinkingLevel === '') this.remove(userId, 'thinkingLevel');
        else if (isCanonicalThinkingLevel(patch.thinkingLevel)) this.set(userId, 'thinkingLevel', patch.thinkingLevel);
      }
      if (patch.autoCompact !== undefined) this.set(userId, 'autoCompact', String(patch.autoCompact));
      if (patch.autoCompactAt !== undefined) this.set(userId, 'autoCompactAt', String(clampPercent(patch.autoCompactAt)));
      // The per-model threshold map replaces the stored one wholesale (cleaned + clamped); an empty map
      // clears every override so all models fall back to the global threshold.
      if (patch.autoCompactAtByModel !== undefined) this.set(userId, 'autoCompactAtByModel', JSON.stringify(cleanThresholdMap(patch.autoCompactAtByModel)));
      if (patch.autoRecall !== undefined) this.set(userId, 'autoRecall', String(patch.autoRecall));
      if (patch.autoLiveRecall !== undefined) this.set(userId, 'autoLiveRecall', String(patch.autoLiveRecall));
      if (patch.autoSave !== undefined) this.set(userId, 'autoSave', String(patch.autoSave));
      if (patch.advisorStyle !== undefined && isAdvisorStyle(patch.advisorStyle)) this.set(userId, 'advisorStyle', patch.advisorStyle);
      // Global agent instructions. The persisted key stays `personalityBody` for downgrade compatibility;
      // the API exposes the semantic `userInstructions` name. Empty is a valid clear operation.
      if (patch.personalityBody !== undefined) this.set(userId, 'personalityBody', patch.personalityBody);
      // Platform links, one loop over the identity descriptors. This patch is the account holder EDITING
      // their own fields, so a value that does not normalise into a plausible identity (empty included)
      // is them clearing the link.
      for (const descriptor of PLATFORM_IDENTITIES) {
        const raw = patch[descriptor.linkSettingKey];
        if (raw !== undefined) this.writePlatformLink(userId, descriptor, raw, 'clear');
      }
    })();
  }

  /** Persist ONE platform link. An identity already claimed by ANOTHER user is refused — otherwise a
   *  squatter could claim the operator's id and have that account's messages (and its memory namespace
   *  and admin flag) attributed to themselves. The descriptor's partial UNIQUE index rejects the write
   *  atomically, so there is no check-then-act race; we surface it as a typed conflict the route can
   *  answer 409 to. Re-setting one's OWN id stays idempotent.
   *
   *  `onInvalid` is the whole difference between the two callers. A user submitting a field they emptied
   *  or mistyped means "unlink me" — but an INBOUND sender id nobody recognises means only that: an
   *  unparseable identifier is not consent to destroy a working link. A single legacy `8:orgid:…` Teams
   *  MRI arriving used to wipe a perfectly good stored GUID and lock the account out of its own channel. */
  private writePlatformLink(userId: number, descriptor: PlatformIdentityDescriptor, raw: string, onInvalid: 'clear' | 'keep'): void {
    const value = descriptor.normalize(String(raw));
    if (!descriptor.validate(value)) {
      if (onInvalid === 'clear') this.remove(userId, descriptor.linkSettingKey);
      return;
    }
    try { this.set(userId, descriptor.linkSettingKey, value); }
    catch (e) {
      if (isUniqueViolation(e)) throw new PlatformLinkConflictError(descriptor.platform, descriptor.linkSettingKey, value, descriptor.conflictMessage);
      throw e;
    }
  }

  /** Link a platform sender id to an account, by platform rather than by setting field — what the
   *  inbound identity resolver needs when it bootstraps a link it has just established. Unknown
   *  platforms are a no-op: an identity model we do not have cannot be persisted into one we do, and an
   *  id whose shape we do not recognise is likewise a no-op rather than an erase. */
  setPlatformLink(userId: number, platform: string, rawValue: string): void {
    const descriptor = platformIdentity(platform);
    if (!descriptor) return;
    this.db.transaction(() => { this.writePlatformLink(userId, descriptor, rawValue, 'keep'); })();
  }

  /** A user's explicitly selected provider/model for one canonical Git project root. The JSON map is
   *  deliberately opaque to routes: only the brain lifecycle derives a root from an authorized cwd. */
  projectModelPreference(userId: number, projectRoot: string): ProjectModelPreference | undefined {
    const selection = projectModelPreferences(this.get(userId, 'projectModelPreferences'))[projectRoot];
    return selection ? { ...selection } : undefined;
  }

  setProjectModelPreference(userId: number, projectRoot: string, selection: ProjectModelPreference): void {
    const provider = selection.provider.trim();
    const model = selection.model.trim();
    if (!projectRoot || !provider || !model) return;
    this.db.transaction(() => {
      const next = projectModelPreferences(this.get(userId, 'projectModelPreferences'));
      next[projectRoot] = { provider, model };
      this.set(userId, 'projectModelPreferences', JSON.stringify(next));
    })();
  }

  /** The user's web-terminal appearance settings, defaults filled in. The stored value is an untrusted
   *  JSON blob, so a corrupt/partial/absent row degrades cleanly to the full defaults. */
  terminalSettings(userId: number): TerminalSettings {
    const raw = this.get(userId, 'terminal');
    if (!raw) return sanitizeTerminalSettings({});
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { return sanitizeTerminalSettings({}); }
    return sanitizeTerminalSettings(parsed);
  }

  /** Apply a partial terminal-settings patch: read current, merge (palette key-by-key), re-validate, and
   *  persist the whole blob. Runs in a transaction so the read-modify-write can't interleave. */
  setTerminalSettings(userId: number, patch: Partial<TerminalSettings>): TerminalSettings {
    return this.db.transaction(() => {
      const next = mergeTerminalSettings(this.terminalSettings(userId), patch);
      this.set(userId, 'terminal', JSON.stringify(next));
      return next;
    })();
  }

  /** The user's granular tool-permission settings (rules + persisted YOLO default), defaults filled in.
   *  The stored value is an untrusted JSON blob (key `permissions`), so a corrupt/partial/absent row
   *  degrades cleanly to empty rules + YOLO off (the built-in default ruleset applies regardless —
   *  see brain/toolPermissions.ts). */
  permissionSettings(userId: number): PermissionSettings {
    const raw = this.get(userId, 'permissions');
    if (!raw) return sanitizePermissionSettings({});
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { return sanitizePermissionSettings({}); }
    return sanitizePermissionSettings(parsed);
  }

  /** Apply a partial permissions patch (each present field replaces wholesale — rule-map key order is
   *  meaningful), re-validate, persist the whole blob. Transactional read-modify-write. */
  setPermissionSettings(userId: number, patch: unknown): PermissionSettings {
    return this.db.transaction(() => {
      const next = mergePermissionSettings(this.permissionSettings(userId), patch);
      this.set(userId, 'permissions', JSON.stringify(next));
      return next;
    })();
  }

  /** Persist one "Always allow" pick from an approval prompt: upsert `pattern → allow` into the given
   *  scope's rule map, moved to the END (delete-then-set) so last-match-wins resolution honours the
   *  user's newest decision even over an earlier conflicting rule. */
  addPermissionAllowRule(userId: number, scope: PermissionScope, pattern: string): PermissionSettings {
    return this.db.transaction(() => {
      const cur = this.permissionSettings(userId);
      const map: Record<string, PermissionAction> = { ...cur[scope] };
      delete map[pattern];
      map[pattern] = 'allow';
      const next: PermissionSettings = { ...cur, [scope]: map };
      this.set(userId, 'permissions', JSON.stringify(next));
      return next;
    })();
  }

  /** The user's primary-navigation layout (hidden entries + preferred order), defaults filled in. The
   *  stored value is an untrusted JSON blob (key `nav`), so a corrupt/partial/absent row degrades to the
   *  registry's own navigation. */
  navSettings(userId: number): NavSettings {
    const raw = this.get(userId, 'nav');
    if (!raw) return sanitizeNavSettings({});
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { return sanitizeNavSettings({}); }
    return sanitizeNavSettings(parsed);
  }

  /** Apply a navigation-layout patch (each present list replaces the stored one wholesale — position is
   *  the meaning), re-validate, persist the whole blob. Transactional read-modify-write. */
  setNavSettings(userId: number, patch: unknown): NavSettings {
    return this.db.transaction(() => {
      const next = mergeNavSettings(this.navSettings(userId), patch);
      this.set(userId, 'nav', JSON.stringify(next));
      return next;
    })();
  }

  /** Reverse lookup: which user claimed this setting value (e.g. a Discord id → the Elowen account).
   *  Returns null when nobody has. For discordUserId the partial UNIQUE index guarantees at most one row. */
  userIdBySetting(key: string, value: string): number | null {
    const r = this.db.prepare('SELECT user_id FROM user_settings WHERE key = ? AND value = ? LIMIT 1')
      .get(key, value) as { user_id: number } | undefined;
    return r ? r.user_id : null;
  }
}
