import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';

/** The `users` shape a database created before v7 has: no AUTOINCREMENT (which is what makes the rebuild
 *  run at all) and only the columns that existed back then. Everything since is supplied by the additive
 *  `addColumn` block, which runs BEFORE the rebuild — so a column the rebuild's hardcoded list forgets is
 *  added and then silently dropped again, on exactly the databases that are being upgraded. */
const LEGACY_USERS_DDL = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_admin INTEGER NOT NULL DEFAULT 0,
    allowed_execs TEXT NOT NULL DEFAULT '',
    disabled_tools TEXT NOT NULL DEFAULT ''
  );
`;

const columnsOf = (path: string): string[] => {
  const db = openDb(path);
  const names = (db.pragma('table_info(users)') as { name: string }[]).map((c) => c.name).sort();
  db.close();
  return names;
};

describe('makeUserIdsMonotonic rebuilds users without losing a column', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const seedLegacy = (name: string, extra?: (db: Database.Database) => void): string => {
    dir = mkdtempSync(join(tmpdir(), `elowen-users-${name}-`));
    const path = join(dir, 'elowen.db');
    const legacy = new Database(path);
    legacy.exec(LEGACY_USERS_DDL);
    legacy.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (1, 'amy', 'h', 0)").run();
    extra?.(legacy);
    legacy.pragma('user_version = 6'); // one below the rebuild, so it actually runs
    legacy.close();
    return path;
  };

  // `granted_plugins` was once missing from the rebuild's hardcoded column list, and every pre-v7 database
  // silently lost its plugin grants on upgrade — no error, no log, just an account that could no longer
  // reach the plugins an admin had handed it. `allowed_tools` was about to repeat it, and now carries tool
  // AUTHORITY, so losing it would reset every migrated account's grant to the column default. Comparing
  // the rebuilt table against a database created fresh off schema.sql + addColumn is what makes the next
  // added column fail here instead of in production.
  it('ends with exactly the columns a freshly created database has', () => {
    const migrated = columnsOf(seedLegacy('columns'));
    expect(migrated).toEqual(columnsOf(':memory:'));
    // Named explicitly as well: an equality against another derived list would still pass if BOTH sides
    // lost the column (e.g. someone deleted the addColumn line and the rebuild entry together).
    expect(migrated).toContain('allowed_tools');
    expect(migrated).toContain('granted_plugins');
  });

  it('carries each account\'s stored tool grant and plugin grant through the rebuild', () => {
    // A database that already ran the additive block once (so the columns exist and hold real admin
    // decisions) but has never been rebuilt — the exact state an upgrading instance is in.
    const path = seedLegacy('values', (db) => {
      db.exec("ALTER TABLE users ADD COLUMN allowed_tools TEXT NOT NULL DEFAULT '*'");
      db.exec("ALTER TABLE users ADD COLUMN granted_plugins TEXT NOT NULL DEFAULT ''");
      db.prepare("UPDATE users SET allowed_tools = 'Read,Bash', granted_plugins = 'terminal', disabled_tools = 'Write' WHERE id = 1").run();
    });

    const db = openDb(path);
    expect(db.prepare('SELECT id, allowed_tools, granted_plugins, disabled_tools FROM users WHERE id = 1').get())
      .toEqual({ id: 1, allowed_tools: 'Read,Bash', granted_plugins: 'terminal', disabled_tools: 'Write' });
    // The rebuild happened (that is what this suite is about) rather than being skipped.
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get())
      .toMatchObject({ sql: expect.stringContaining('AUTOINCREMENT') });
    db.close();
  });
});
