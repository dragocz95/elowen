import type { Db } from './db.js';

/** One account's values for ONE plugin. Same shape as the instance-wide `plugins.config.<name>` slice —
 *  the difference is only whose values they are. */
export type UserPluginConfig = Record<string, unknown>;

/** Per-user, per-plugin settings for plugins that declare a `userConfigSchema`: each person's own API key,
 *  their identifier in an external system. One JSON blob per (user, plugin), so a save is atomic against
 *  the whole form and a plugin can change its schema without a migration.
 *
 *  The values never leave the daemon by accident: a route reads them only for the signed-in account, and a
 *  plugin only through `ctx.userConfig()`, which resolves the CURRENT identity — no caller can name a user. */
export class UserPluginConfigStore {
  constructor(private db: Db) {}

  /** An account's stored values for a plugin. A missing row, or one whose JSON no longer parses (hand-edited
   *  database, half-written blob), reads as "nothing configured" — the same state as a brand-new account,
   *  which every consumer already handles. */
  get(userId: number, plugin: string): UserPluginConfig {
    const r = this.db.prepare('SELECT data FROM user_plugin_config WHERE user_id = ? AND plugin = ?')
      .get(userId, plugin) as { data: string } | undefined;
    if (!r) return {};
    try {
      const parsed: unknown = JSON.parse(r.data);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as UserPluginConfig : {};
    } catch { return {}; }
  }

  /** Replace an account's values for a plugin wholesale. An empty object drops the row rather than storing
   *  `{}` — "configured nothing" and "no row" must not be two states that behave the same but read apart. */
  set(userId: number, plugin: string, data: UserPluginConfig): void {
    if (Object.keys(data).length === 0) { this.remove(userId, plugin); return; }
    this.db.prepare(
      `INSERT INTO user_plugin_config (user_id, plugin, data) VALUES (@user_id, @plugin, @data)
       ON CONFLICT(user_id, plugin) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`
    ).run({ user_id: userId, plugin, data: JSON.stringify(data) });
  }

  /** Apply a partial patch: read, merge key-by-key, persist. Transactional so two concurrent saves cannot
   *  interleave into a blob that holds neither one's values. A key set to `undefined` is REMOVED, which is
   *  how the form clears a field back to "not configured". */
  merge(userId: number, plugin: string, patch: UserPluginConfig): UserPluginConfig {
    return this.db.transaction(() => {
      const next: UserPluginConfig = { ...this.get(userId, plugin) };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      this.set(userId, plugin, next);
      return next;
    })();
  }

  remove(userId: number, plugin: string): void {
    this.db.prepare('DELETE FROM user_plugin_config WHERE user_id = ? AND plugin = ?').run(userId, plugin);
  }

  /** Drop everything an account stored for every plugin — called on user delete so no orphan values
   *  (including their secrets) linger. */
  removeForUser(userId: number): void {
    this.db.prepare('DELETE FROM user_plugin_config WHERE user_id = ?').run(userId);
  }
}
