import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf-8'));
  try { db.exec("ALTER TABLE projects ADD COLUMN notes TEXT NOT NULL DEFAULT ''"); } catch { /* column already exists */ }
  try { db.exec("ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''"); } catch { /* column already exists */ }
  try { db.exec("ALTER TABLE tasks ADD COLUMN scheduled_at TEXT"); } catch { /* column already exists */ }
  try { db.exec("ALTER TABLE tasks ADD COLUMN autostart INTEGER NOT NULL DEFAULT 0"); } catch { /* column already exists */ }
  try { db.exec("ALTER TABLE tasks ADD COLUMN result_summary TEXT"); } catch { /* column already exists */ }
  try { db.exec("ALTER TABLE tasks ADD COLUMN outcome TEXT"); } catch { /* column already exists */ }
  try { db.exec("ALTER TABLE tasks ADD COLUMN closed_at TEXT"); } catch { /* column already exists */ }
  return db;
}
