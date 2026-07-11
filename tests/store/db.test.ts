import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDb } from '../../src/store/db.js';

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

describe('openDb', () => {
  it('applies schema (tables exist) on a fresh :memory: db', () => {
    const db = openDb(':memory:');
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(['projects', 'tasks', 'task_deps', 'agents', 'missions', 'brain_subagent_runs']));
  });

  it('migrates a pre-project_id events table without throwing (adds the column + index)', () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'old.db');
    // Simulate a DB created before the project_id column existed: events with the OLD shape.
    const old = new Database(path);
    old.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')), type TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')");
    old.prepare("INSERT INTO events (type, target, detail) VALUES ('task','t1','open')").run();
    old.close();
    // Re-opening must run the additive migration cleanly (this used to crash: "no such column: project_id").
    const db = openDb(path);
    const cols = db.prepare('PRAGMA table_info(events)').all().map((r: any) => r.name);
    expect(cols).toContain('project_id');
    // Existing rows survive with a null project, and the project index exists.
    expect((db.prepare("SELECT project_id FROM events WHERE target='t1'").get() as any).project_id).toBeNull();
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_project'").get();
    expect(idx).toBeTruthy();
  });

  it('migrates a pre-work_dir brain_sessions table (adds the column, existing rows read cwd-less)', () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'old.db');
    // Simulate a DB created before brain sessions carried a working directory.
    const old = new Database(path);
    old.exec(`CREATE TABLE brain_sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    old.prepare("INSERT INTO brain_sessions (id, user_id, title, model) VALUES ('brain-1', 1, 'old chat', 'm')").run();
    old.close();
    const db = openDb(path);
    const cols = db.prepare('PRAGMA table_info(brain_sessions)').all().map((r: any) => r.name);
    expect(cols).toContain('work_dir');
    // Legacy rows come back with an EMPTY work_dir — treated as cwd-less by the CLI start resolution.
    expect((db.prepare("SELECT work_dir FROM brain_sessions WHERE id='brain-1'").get() as any).work_dir).toBe('');
  });

  it('migrates a pre-parent brain_sessions table and creates the delegation index afterwards', () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'old.db');
    const old = new Database(path);
    old.exec(`CREATE TABLE brain_sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '', work_dir TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    old.prepare("INSERT INTO brain_sessions (id, user_id, model) VALUES ('brain-1', 1, 'm')").run();
    old.close();

    const db = openDb(path);
    const cols = db.prepare('PRAGMA table_info(brain_sessions)').all().map((r: any) => r.name);
    expect(cols).toContain('parent_session_id');
    expect(cols).toContain('delegated_access');
    expect((db.prepare("SELECT parent_session_id FROM brain_sessions WHERE id='brain-1'").get() as any).parent_session_id).toBeNull();
    expect((db.prepare("SELECT delegated_access FROM brain_sessions WHERE id='brain-1'").get() as any).delegated_access).toBeNull();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_brain_sessions_parent'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='brain_subagent_runs'").get()).toBeTruthy();
  });
});
