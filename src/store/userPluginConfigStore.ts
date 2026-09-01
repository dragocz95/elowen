import type { Db } from './db.js';

/** One account's values for ONE plugin. Same shape as the instance-wide `plugins.config.<name>` slice —
 * the difference is only whose values they are. */
export type UserPluginConfig = Record<string, unknown>;

export class UserPluginConfigRevisionConflict extends Error {
  constructor(public readonly currentRevision: number) {
    super('user plugin config changed since the supplied revision');
    this.name = 'UserPluginConfigRevisionConflict';
  }
}

export interface UserPluginConfigSnapshot {
  config: UserPluginConfig;
  revision: number;
}

/** Per-user, per-plugin settings for plugins that declare a `userConfigSchema`: each person's own API key,
 * their identifier in an external system. One JSON blob per (user, plugin), so a save is atomic against
 * the whole form and a plugin can change its schema without a migration.
 *
 * The values never leave the daemon by accident: a route reads them only for the signed-in account, and a
 * plugin only through `ctx.userConfig()`, which resolves the CURRENT identity — no caller can name a user. */
export class UserPluginConfigStore {
  constructor(private db: Db) {}

  snapshot(userId: number, plugin: string): UserPluginConfigSnapshot {
    const r = this.db.prepare('SELECT data, revision FROM user_plugin_config WHERE user_id = ? AND plugin = ?')
      .get(userId, plugin) as { data: string; revision?: number } | undefined;
    if (!r) return { config: {}, revision: 0 };
    try {
      const parsed: unknown = JSON.parse(r.data);
      return {
        config: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as UserPluginConfig : {},
        revision: Number.isInteger(r.revision) && (r.revision ?? 0) >= 0 ? r.revision! : 0,
      };
    } catch { return { config: {}, revision: Number.isInteger(r.revision) && (r.revision ?? 0) >= 0 ? r.revision! : 0 }; }
  }

  /** An account's stored values for a plugin. A missing row, or one whose JSON no longer parses (hand-edited
   * database, half-written blob), reads as "nothing configured" — the same state as a brand-new account. */
  get(userId: number, plugin: string): UserPluginConfig {
    return this.snapshot(userId, plugin).config;
  }

  /** Replace an account's values for a plugin wholesale. A row is retained for an empty object so its
   * revision remains a durable CAS token across clear-and-retry cycles. */
  set(userId: number, plugin: string, data: UserPluginConfig, expectedRevision?: number): number {
    return this.db.transaction(() => {
      const current = this.snapshot(userId, plugin);
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        throw new UserPluginConfigRevisionConflict(current.revision);
      }
      const revision = current.revision + 1;
      this.db.prepare(
        `INSERT INTO user_plugin_config (user_id, plugin, data, revision) VALUES (@user_id, @plugin, @data, @revision)
         ON CONFLICT(user_id, plugin) DO UPDATE SET data = excluded.data, revision = excluded.revision, updated_at = datetime('now')`
      ).run({ user_id: userId, plugin, data: JSON.stringify(data), revision });
      return revision;
    })();
  }

  remove(userId: number, plugin: string): void {
    this.db.prepare('DELETE FROM user_plugin_config WHERE user_id = ? AND plugin = ?').run(userId, plugin);
  }

  /** Drop everything an account stored for every plugin — called on user delete so no orphan values
   * (including their secrets) linger. */
  removeForUser(userId: number): void {
    this.db.prepare('DELETE FROM user_plugin_config WHERE user_id = ?').run(userId);
  }
}
