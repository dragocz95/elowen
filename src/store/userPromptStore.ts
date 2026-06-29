import type { Db } from './db.js';

/** Per-user prompt overrides. A row exists only when a user has edited a template away from its `.md`
 *  default — absence means "use the default", so a fresh user automatically gets the shipped prompts.
 *  Keyed by (user_id, name); the name is a prompt-catalog template name (see prompts/catalog). */
export class UserPromptStore {
  constructor(private db: Db) {}

  /** The user's override for a template, or null when none (caller falls back to the file default). */
  get(userId: number, name: string): string | null {
    const r = this.db.prepare('SELECT content FROM user_prompts WHERE user_id = ? AND name = ?')
      .get(userId, name) as { content: string } | undefined;
    return r ? r.content : null;
  }

  /** All of the user's overrides as a name→content map (for the account API, one query). */
  getAll(userId: number): Record<string, string> {
    const rows = this.db.prepare('SELECT name, content FROM user_prompts WHERE user_id = ?')
      .all(userId) as { name: string; content: string }[];
    return Object.fromEntries(rows.map((r) => [r.name, r.content]));
  }

  /** Insert or replace a user's override for a template. */
  set(userId: number, name: string, content: string): void {
    this.db.prepare(
      `INSERT INTO user_prompts (user_id, name, content) VALUES (@user_id, @name, @content)
       ON CONFLICT(user_id, name) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`
    ).run({ user_id: userId, name, content });
  }

  /** Drop a single override → the template reverts to its `.md` default for this user. */
  remove(userId: number, name: string): void {
    this.db.prepare('DELETE FROM user_prompts WHERE user_id = ? AND name = ?').run(userId, name);
  }

  /** Drop all of a user's overrides — called when the user is deleted so no orphan rows linger. */
  removeForUser(userId: number): void {
    this.db.prepare('DELETE FROM user_prompts WHERE user_id = ?').run(userId);
  }
}
