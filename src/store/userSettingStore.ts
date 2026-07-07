import type { Db } from './db.js';
import { DEFAULT_ADVISOR_STYLE, isAdvisorStyle } from '../brain/personality.js';
import { sanitizeTerminalSettings, mergeTerminalSettings, type TerminalSettings } from './terminalSettings.js';
import { sanitizePermissionSettings, mergePermissionSettings, type PermissionAction, type PermissionScope, type PermissionSettings } from '../brain/toolPermissions.js';

/** Typed per-user CLI/brain settings. `model`/`modelProvider` empty → use the configured brain default.
 *  `autoCompactAt` is the context-window fill percentage at which the conversation is auto-summarized.
 *  `advisorStyle` picks the advisor's communication style (the `{{personality}}` prompt paragraph). */
export interface CliSettings { model: string; modelProvider: string; visionModel: string; visionModelProvider: string; thinkingLevel: string; autoCompact: boolean; autoCompactAt: number; advisorStyle: string; discordUserId: string; whatsappNumber: string; autoRecall: boolean; autoSave: boolean }
// autoRecall/autoSave default to true so upgrading users keep the prior always-on memory behaviour.
const CLI_DEFAULTS: CliSettings = { model: '', modelProvider: '', visionModel: '', visionModelProvider: '', thinkingLevel: '', autoCompact: false, autoCompactAt: 80, advisorStyle: DEFAULT_ADVISOR_STYLE, discordUserId: '', whatsappNumber: '', autoRecall: true, autoSave: true };

/** Reasoning-effort levels PI accepts (extended-thinking models). Empty = leave the model default. */
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
function isThinkingLevel(v: string): boolean { return (THINKING_LEVELS as readonly string[]).includes(v); }

/** Raised when a user tries to link a Discord snowflake another user has already claimed. The route
 *  maps it to a 409 with a Czech user message; the identity link stays with the original owner. */
export class DiscordIdConflictError extends Error {
  constructor(public readonly discordUserId: string) {
    super(`discord id ${discordUserId} is already linked to another user`);
    this.name = 'DiscordIdConflictError';
  }
}

/** Raised when a user tries to link a WhatsApp number another user has already claimed. Mirrors
 *  {@link DiscordIdConflictError}; the route maps it to a 409 with a Czech user message. */
export class WhatsAppNumberConflictError extends Error {
  constructor(public readonly whatsappNumber: string) {
    super(`whatsapp number ${whatsappNumber} is already linked to another user`);
    this.name = 'WhatsAppNumberConflictError';
  }
}

/** True for a better-sqlite3 UNIQUE-constraint violation — here, the partial index that keeps a Discord
 *  snowflake owned by a single user. Lets the store reject a squatter without a check-then-act race. */
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
      thinkingLevel: isThinkingLevel(all.thinkingLevel ?? '') ? (all.thinkingLevel as string) : CLI_DEFAULTS.thinkingLevel,
      autoCompact: all.autoCompact !== undefined ? all.autoCompact === 'true' : CLI_DEFAULTS.autoCompact,
      autoCompactAt: all.autoCompactAt !== undefined ? clampPercent(Number(all.autoCompactAt)) : CLI_DEFAULTS.autoCompactAt,
      advisorStyle: isAdvisorStyle(all.advisorStyle) ? all.advisorStyle : CLI_DEFAULTS.advisorStyle,
      discordUserId: all.discordUserId ?? CLI_DEFAULTS.discordUserId,
      whatsappNumber: all.whatsappNumber ?? CLI_DEFAULTS.whatsappNumber,
      autoRecall: all.autoRecall !== undefined ? all.autoRecall === 'true' : CLI_DEFAULTS.autoRecall,
      autoSave: all.autoSave !== undefined ? all.autoSave === 'true' : CLI_DEFAULTS.autoSave,
    };
  }

  /** Apply a partial CLI-settings patch (only the provided fields are written). Runs in a transaction so
   *  a rejected Discord link (see below) rolls the whole patch back instead of leaving a partial write.
   *  Throws {@link DiscordIdConflictError} when the requested Discord snowflake is already linked to a
   *  DIFFERENT user — enforced atomically by the partial UNIQUE index, so there is no check-then-act race. */
  setCliSettings(userId: number, patch: Partial<CliSettings>): void {
    this.db.transaction(() => {
      if (patch.model !== undefined) this.set(userId, 'model', patch.model);
      if (patch.modelProvider !== undefined) this.set(userId, 'modelProvider', patch.modelProvider);
      if (patch.visionModel !== undefined) this.set(userId, 'visionModel', patch.visionModel);
      if (patch.visionModelProvider !== undefined) this.set(userId, 'visionModelProvider', patch.visionModelProvider);
      // Empty clears the override (model default); anything else must be a known level.
      if (patch.thinkingLevel !== undefined) {
        if (patch.thinkingLevel === '') this.remove(userId, 'thinkingLevel');
        else if (isThinkingLevel(patch.thinkingLevel)) this.set(userId, 'thinkingLevel', patch.thinkingLevel);
      }
      if (patch.autoCompact !== undefined) this.set(userId, 'autoCompact', String(patch.autoCompact));
      if (patch.autoCompactAt !== undefined) this.set(userId, 'autoCompactAt', String(clampPercent(patch.autoCompactAt)));
      if (patch.autoRecall !== undefined) this.set(userId, 'autoRecall', String(patch.autoRecall));
      if (patch.autoSave !== undefined) this.set(userId, 'autoSave', String(patch.autoSave));
      if (patch.advisorStyle !== undefined && isAdvisorStyle(patch.advisorStyle)) this.set(userId, 'advisorStyle', patch.advisorStyle);
      // A Discord snowflake is digits-only; anything else (or empty) clears the link. A snowflake already
      // claimed by ANOTHER user is refused — otherwise a squatter could claim the operator's id and have
      // that account's Discord messages (and its memory namespace / admin flag) attributed to themselves.
      // The partial UNIQUE index on (value WHERE key='discordUserId') rejects the write; we surface that
      // as a typed conflict so the route can answer 409. Re-setting one's OWN id stays idempotent.
      if (patch.discordUserId !== undefined) {
        const v = String(patch.discordUserId).trim();
        if (!/^\d{5,25}$/.test(v)) this.remove(userId, 'discordUserId');
        else {
          try { this.set(userId, 'discordUserId', v); }
          catch (e) {
            if (isUniqueViolation(e)) throw new DiscordIdConflictError(v);
            throw e;
          }
        }
      }
      // A WhatsApp number links a phone (digits only, international form without +) to this account, same
      // squatter protection as Discord via a partial UNIQUE index on (value WHERE key='whatsappNumber').
      if (patch.whatsappNumber !== undefined) {
        const v = String(patch.whatsappNumber).replace(/[^\d]/g, '');
        if (!/^\d{6,15}$/.test(v)) this.remove(userId, 'whatsappNumber');
        else {
          try { this.set(userId, 'whatsappNumber', v); }
          catch (e) {
            if (isUniqueViolation(e)) throw new WhatsAppNumberConflictError(v);
            throw e;
          }
        }
      }
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

  /** Reverse lookup: which user claimed this setting value (e.g. a Discord id → the Orca account).
   *  Returns null when nobody has. For discordUserId the partial UNIQUE index guarantees at most one row. */
  userIdBySetting(key: string, value: string): number | null {
    const r = this.db.prepare('SELECT user_id FROM user_settings WHERE key = ? AND value = ? LIMIT 1')
      .get(key, value) as { user_id: number } | undefined;
    return r ? r.user_id : null;
  }
}
