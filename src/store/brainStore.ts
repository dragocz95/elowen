import type { Db } from './db.js';

export interface BrainSessionRow {
  id: string; user_id: number; title: string; model: string; created_at: string; updated_at: string;
}
export interface BrainMessageRow {
  id: string; session_id: string; parent_id: string | null; role: string; content: string; created_at: string;
}

/** Persistence for the embedded brain's conversations — the SOLE authoritative store (design D1).
 *  The PI agent session runs in-memory; every settled turn is projected here, and history is
 *  rehydrated from here on start. Exactly one writer (BrainService), so no dual-write drift. */
export class BrainStore {
  constructor(private db: Db) {}

  createSession(input: { id: string; userId: number; title?: string; model: string }): BrainSessionRow {
    this.db.prepare(
      `INSERT INTO brain_sessions (id, user_id, title, model) VALUES (@id, @user_id, @title, @model)`
    ).run({ id: input.id, user_id: input.userId, title: input.title ?? '', model: input.model });
    return this.getSession(input.id)!;
  }

  getSession(id: string): BrainSessionRow | undefined {
    return this.db.prepare('SELECT * FROM brain_sessions WHERE id = ?').get(id) as BrainSessionRow | undefined;
  }

  listSessions(userId: number): BrainSessionRow[] {
    return this.db.prepare('SELECT * FROM brain_sessions WHERE user_id = ? ORDER BY updated_at DESC, rowid ASC')
      .all(userId) as BrainSessionRow[];
  }

  appendMessage(input: { id: string; sessionId: string; parentId: string | null; role: string; content: unknown }): BrainMessageRow {
    this.db.prepare(
      `INSERT INTO brain_messages (id, session_id, parent_id, role, content)
       VALUES (@id, @session_id, @parent_id, @role, @content)`
    ).run({
      id: input.id, session_id: input.sessionId, parent_id: input.parentId,
      role: input.role, content: JSON.stringify(input.content),
    });
    return this.db.prepare('SELECT * FROM brain_messages WHERE id = ?').get(input.id) as BrainMessageRow;
  }

  getMessages(sessionId: string): BrainMessageRow[] {
    return this.db.prepare('SELECT * FROM brain_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(sessionId) as BrainMessageRow[];
  }

  touchSession(id: string, model?: string): void {
    if (model === undefined) {
      this.db.prepare("UPDATE brain_sessions SET updated_at = datetime('now') WHERE id = ?").run(id);
    } else {
      this.db.prepare("UPDATE brain_sessions SET updated_at = datetime('now'), model = ? WHERE id = ?").run(model, id);
    }
  }

  removeForUser(userId: number): void {
    this.db.prepare('DELETE FROM brain_messages WHERE session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)').run(userId);
    this.db.prepare('DELETE FROM brain_sessions WHERE user_id = ?').run(userId);
  }
}
