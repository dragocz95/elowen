/** Per-account read state: the newest release version this account has already been shown.
 *
 *  A table rather than `ctx.userConfig()`: that seam holds the account's own values for the manifest's
 *  `userConfigSchema` and renders them as a form in Account. "How far did this person read" is internal
 *  state, not a setting somebody should see a field for. */
import { compareVersions } from './entries.mjs';

export function initSeenStore(ctx) {
  const db = ctx.db();
  db.migrate([{
    version: 1,
    up(m) {
      m.exec(`
        CREATE TABLE IF NOT EXISTS p_changelog_seen (
          user_id INTEGER PRIMARY KEY,
          last_seen_version TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  }]);

  return {
    /** The newest version this account has seen, or null for an account that has never opened the page —
     *  and for a request carrying no account at all (open mode), where there is nobody to remember. */
    lastSeen(userId) {
      if (userId === null) return null;
      const row = db.prepare('SELECT last_seen_version FROM p_changelog_seen WHERE user_id = ?').get(userId);
      return row && typeof row.last_seen_version === 'string' ? row.last_seen_version : null;
    },
    /** Move the marker FORWARD only. A stale tab reporting an older version must not un-read what the
     *  account has already been shown. */
    markSeen(userId, version) {
      if (userId === null) return;
      const current = this.lastSeen(userId);
      if (current !== null && compareVersions(version, current) >= 0) return;
      db.prepare(`
        INSERT INTO p_changelog_seen (user_id, last_seen_version, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET last_seen_version = excluded.last_seen_version, updated_at = CURRENT_TIMESTAMP
      `).run(userId, version);
    },
    /** Drop the row of a deleted account (ctx.registerUserRemoved). */
    forgetUser(userId) {
      db.prepare('DELETE FROM p_changelog_seen WHERE user_id = ?').run(userId);
    },
  };
}
