import type { Db } from './db.js';

export interface Note { id: number; scope: string; target: string; author: string; body: string; created_at: string }

/** Inter-agent handoff notes — free-form context one agent leaves for the next agent working the same
 *  scope (a mission/epic by default). Generic `(scope, target)` keying mirrors the events table. */
export class NoteStore {
  constructor(private db: Db) {}

  add(input: { scope: string; target: string; author?: string; body: string }): Note {
    const r = this.db.prepare(
      'INSERT INTO notes (scope, target, author, body) VALUES (@scope, @target, @author, @body)'
    ).run({ scope: input.scope, target: input.target, author: input.author ?? '', body: input.body });
    return this.db.prepare('SELECT * FROM notes WHERE id = ?').get(r.lastInsertRowid) as Note;
  }

  /** Notes for a scope/target, oldest-first so they read as a chronological handoff log. */
  list(scope: string, target: string): Note[] {
    return this.db.prepare('SELECT * FROM notes WHERE scope = ? AND target = ? ORDER BY id ASC').all(scope, target) as Note[];
  }

  /** Purge a target's notes (e.g. on epic delete) so a removed mission leaves no orphan notes. */
  deleteForTarget(scope: string, target: string): void {
    this.db.prepare('DELETE FROM notes WHERE scope = ? AND target = ?').run(scope, target);
  }
}
