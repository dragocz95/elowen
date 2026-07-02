import type { Db } from './db.js';
import { DEFAULT_ADVISOR_STYLE, isAdvisorStyle } from '../brain/personality.js';

/** Typed per-user CLI/brain settings. `model`/`modelProvider` empty → use the configured brain default.
 *  `autoCompactAt` is the context-window fill percentage at which the conversation is auto-summarized.
 *  `advisorStyle` picks the advisor's communication style (the `{{personality}}` prompt paragraph). */
export interface CliSettings { model: string; modelProvider: string; visionModel: string; visionModelProvider: string; thinkingLevel: string; autoCompact: boolean; autoCompactAt: number; advisorStyle: string; discordUserId: string }
const CLI_DEFAULTS: CliSettings = { model: '', modelProvider: '', visionModel: '', visionModelProvider: '', thinkingLevel: '', autoCompact: false, autoCompactAt: 80, advisorStyle: DEFAULT_ADVISOR_STYLE, discordUserId: '' };

/** Reasoning-effort levels PI accepts (extended-thinking models). Empty = leave the model default. */
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
function isThinkingLevel(v: string): boolean { return (THINKING_LEVELS as readonly string[]).includes(v); }

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
    };
  }

  /** Apply a partial CLI-settings patch (only the provided fields are written). */
  setCliSettings(userId: number, patch: Partial<CliSettings>): void {
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
    if (patch.advisorStyle !== undefined && isAdvisorStyle(patch.advisorStyle)) this.set(userId, 'advisorStyle', patch.advisorStyle);
    // A Discord snowflake is digits-only; anything else (or empty) clears the link. A snowflake already
    // claimed by ANOTHER user is refused — otherwise a squatter could claim the operator's id and have
    // that account's Discord messages (and its memory namespace / admin flag) attributed to themselves.
    if (patch.discordUserId !== undefined) {
      const v = String(patch.discordUserId).trim();
      if (!/^\d{5,25}$/.test(v)) { this.remove(userId, 'discordUserId'); return; }
      const claimant = this.userIdBySetting('discordUserId', v);
      if (claimant === null || claimant === userId) this.set(userId, 'discordUserId', v);
      // else: already claimed by someone else → silently ignore (the link stays with the first owner).
    }
  }

  /** Reverse lookup: which user claimed this setting value (e.g. a Discord id → the Orca account).
   *  Returns null when nobody has. First writer wins on duplicates (deterministic by user id). */
  userIdBySetting(key: string, value: string): number | null {
    const r = this.db.prepare('SELECT user_id FROM user_settings WHERE key = ? AND value = ? ORDER BY user_id LIMIT 1')
      .get(key, value) as { user_id: number } | undefined;
    return r ? r.user_id : null;
  }
}
