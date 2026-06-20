import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = Database.Database;

/** Add a column only if it isn't already present. Unlike a try/catch around ALTER TABLE, this
 *  checks the actual table shape, so a genuine ALTER failure (lock, disk full) is not swallowed. */
function addColumn(db: Db, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // Enforce foreign keys so any REFERENCES added to the schema actually cascade/reject.
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf-8'));
  // Additive migrations for DBs created before a column existed. Idempotent: a column that already
  // exists is skipped via PRAGMA table_info, so we never rely on swallowing arbitrary ALTER errors
  // (a real failure — disk full, lock — now surfaces instead of being silently caught).
  addColumn(db, 'projects', 'notes', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'tasks', 'description', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'tasks', 'scheduled_at', 'TEXT');
  addColumn(db, 'tasks', 'autostart', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'tasks', 'result_summary', 'TEXT');
  addColumn(db, 'tasks', 'outcome', 'TEXT');
  addColumn(db, 'tasks', 'closed_at', 'TEXT');
  addColumn(db, 'users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'users', 'allowed_execs', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'name', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'email', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'avatar', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'default_exec', "TEXT NOT NULL DEFAULT ''");
  // Token scope: spawned agents get a 'agent'-scoped token (worker/overseer/pilot verbs only),
  // never the admin's full token. Pre-existing rows default to 'full' (interactive user sessions).
  addColumn(db, 'auth_tokens', 'scope', "TEXT NOT NULL DEFAULT 'full'");
  // Seed the bootstrap admin on existing DBs: the lowest-id user, if none is flagged yet.
  db.exec("UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)");
  return db;
}
