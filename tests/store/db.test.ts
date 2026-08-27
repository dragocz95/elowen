import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { openDb } from '../../src/store/db.js';
import { UserStore } from '../../src/store/userStore.js';
import { toolPermitted } from '../../src/plugins/policyContext.js';

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

describe('openDb', () => {
  it('applies schema (tables exist) on a fresh :memory: db', () => {
    const db = openDb(':memory:');
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(['projects', 'users', 'events', 'brain_subagent_runs']));
    // The agents-plugin and work-plugin tables are NOT core schema: a fresh install with the plugin
    // disabled must not create them (their DDL lives in plugins/<name>/src/store/migrations.ts).
    for (const t of ['missions', 'agents', 'notes', 'tasks', 'task_deps', 'task_usage']) {
      expect(names).not.toContain(t);
    }
  });

  it('rebuilds legacy Projects without pr_enabled and seeds AUTOINCREMENT above generic plugin references', () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'old.db');
    const old = new Database(path);
    old.exec(`
      CREATE TABLE projects (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, path TEXT NOT NULL, pr_enabled INTEGER);
      INSERT INTO projects (id, slug, path, pr_enabled) VALUES (3, 'legacy', '/legacy', 1);
      CREATE TABLE p_disabled_rows (project_id INTEGER NOT NULL);
      INSERT INTO p_disabled_rows (project_id) VALUES (42);
      PRAGMA user_version = 15;
    `);
    old.close();

    const db = openDb(path);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get() as { sql: string }).sql;
    expect(sql).toContain('AUTOINCREMENT');
    expect(db.prepare('PRAGMA table_info(projects)').all().map((column: any) => column.name)).not.toContain('pr_enabled');
    expect(db.prepare("SELECT id, slug, path, notes, icon FROM projects WHERE id = 3").get())
      .toEqual({ id: 3, slug: 'legacy', path: '/legacy', notes: '', icon: '' });
    const inserted = db.prepare("INSERT INTO projects (slug, path) VALUES ('next', '/next')").run();
    expect(Number(inserted.lastInsertRowid)).toBeGreaterThan(42);
  });

  it('boots with legacy duplicate normalized e-mails and leaves the uniqueness index disabled', () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'old.db');
    const old = new Database(path);
    old.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), email TEXT NOT NULL DEFAULT '')`);
    old.prepare('INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)').run('alice', 'h1', ' Owner@Example.com ');
    old.prepare('INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)').run('bob', 'h2', 'owner@example.COM');
    old.close();

    const db = openDb(path);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_email_normalized'").get()).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) AS n FROM users WHERE lower(trim(email)) = 'owner@example.com'").get() as { n: number }).n).toBe(2);
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

  // The heatmap is fed by a write-time rollup, so an instance that has been running for weeks would
  // show an empty tile for a month before it filled in. v9 seeds it from the history already stored.
  it('seeds the activity heatmap from existing history exactly once', () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'history.db');
    // Build the real schema first, then rewind user_version so the seeding migration runs over history
    // that already exists -- which is exactly the situation on an instance that has been up for weeks.
    const seeded = openDb(path);
    seeded.prepare("INSERT INTO brain_sessions (id, user_id, title, provider, model) VALUES ('brain-1', 7, '', '', '')").run();
    for (const [id, role] of [['m1', 'user'], ['m2', 'user'], ['m3', 'assistant']]) {
      seeded.prepare("INSERT INTO brain_messages (id, session_id, role, content, created_at) VALUES (?, 'brain-1', ?, '{}', datetime('now','-2 days'))").run(id, role);
    }
    seeded.prepare('DELETE FROM activity_buckets').run();
    // 14 is the highest version that existed BEFORE this migration, i.e. what a live database actually
    // sits at. The first version of this test rewound to 8 instead, which no real database has been at
    // for months -- so it passed while the migration, numbered 9, was silently skipped in production
    // because runOnce compares against one shared counter. The uniqueness test below is the mechanical
    // guard; this number is only the realistic starting point.
    seeded.pragma('user_version = 14');
    seeded.close();

    const db = openDb(path);
    const rows = db.prepare('SELECT user_id, count FROM activity_buckets').all() as { user_id: number; count: number }[];
    // Only what a person actually sent: assistant replies are not that person's activity.
    expect(rows).toEqual([{ user_id: 7, count: 2 }]);

    // Re-opening must not count the same history again -- a restored database would otherwise double
    // every bucket, and the rollup cannot tell a re-seed from real traffic.
    db.close();
    const again = openDb(path);
    again.pragma('user_version = 14');
    again.close();
    const third = openDb(path);
    expect(third.prepare('SELECT count FROM activity_buckets').all()).toEqual([{ count: 2 }]);
  });

  it('backfills brain_subagent_runs.lifecycle from legacy state, and a legacy running row is NOT a recovery candidate', () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'old.db');
    // A DB created before the recovery-lifecycle columns existed: the original 5-column shape.
    const old = new Database(path);
    old.exec(`CREATE TABLE brain_subagent_runs (
      parent_session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, child_session_id TEXT NOT NULL,
      state TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (parent_session_id, tool_call_id))`);
    const ins = old.prepare('INSERT INTO brain_subagent_runs (parent_session_id, tool_call_id, child_session_id, state) VALUES (?, ?, ?, ?)');
    ins.run('p1', 'tc-run', 'c1', JSON.stringify({ status: 'running', task: 't', tools: 0, seconds: 1 }));
    ins.run('p1', 'tc-done', 'c2', JSON.stringify({ status: 'done', task: 't', tools: 0, seconds: 1 }));
    ins.run('p1', 'tc-err', 'c3', JSON.stringify({ status: 'error', task: 't', tools: 0, seconds: 1 }));
    ins.run('p1', 'tc-bad', 'c4', 'not-json-at-all'); // malformed: json_extract would throw, so it stays NULL
    old.close();

    const db = openDb(path);
    const lc = (tc: string) => (db.prepare('SELECT lifecycle FROM brain_subagent_runs WHERE tool_call_id = ?').get(tc) as { lifecycle: string | null }).lifecycle;
    // A terminal legacy row maps straight through.
    expect(lc('tc-done')).toBe('done');
    expect(lc('tc-err')).toBe('error');
    // The load-bearing rule: a legacy `running` row becomes legacy_interrupted, NOT `running`. It predates
    // the owner_boot_id claim, so boot recovery (which only claims lifecycle IN (running,recovering)) must
    // never respawn it and repeat a mutation from weeks ago.
    expect(lc('tc-run')).toBe('legacy_interrupted');
    // A malformed legacy row keeps NULL — boot recovery never claims a NULL, so it is inert, not respawned.
    expect(lc('tc-bad')).toBeNull();
  });

  it('migrates memory categories with a nullable project binding and its partial unique index', () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'old.db');
    const old = new Database(path);
    old.exec(`CREATE TABLE memory_categories (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '',
      is_builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, name)
    )`);
    old.prepare("INSERT INTO memory_categories (user_id, name) VALUES (1, 'legacy')").run();
    old.close();

    const db = openDb(path);
    const cols = db.prepare('PRAGMA table_info(memory_categories)').all() as { name: string }[];
    expect(cols.map((column) => column.name)).toContain('project_id');
    expect((db.prepare("SELECT project_id FROM memory_categories WHERE name = 'legacy'").get() as { project_id: number | null }).project_id).toBeNull();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_categories_user_project'").get()).toBeTruthy();
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

  it('backfills spill_ns with the CURRENT id, freezing where the spill files already sit', () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'old.db');
    const old = new Database(path);
    old.exec(`CREATE TABLE brain_sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '', work_dir TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    old.prepare("INSERT INTO brain_sessions (id, user_id, model) VALUES ('brain-ch-general', 1, 'm')").run();
    old.close();

    const db = openDb(path);
    // A pre-namespace conversation's files sit under its current id; the backfill must freeze exactly
    // that — a fresh mint here would strand every existing spill dir and its already-sent placeholders.
    expect((db.prepare("SELECT spill_ns FROM brain_sessions WHERE id='brain-ch-general'").get() as any).spill_ns)
      .toBe('brain-ch-general');
  });

  it('v11 re-keys brain_tool_result_spills by occurrence, carrying old rows over as legacy', () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'old.db');
    const old = new Database(path);
    // The deployed pre-v11 shape: keyed by (session_id, tool_call_id) alone.
    old.exec(`CREATE TABLE brain_tool_result_spills (
      session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, mode TEXT NOT NULL,
      bytes INTEGER NOT NULL, preview TEXT, path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, tool_call_id))`);
    old.prepare(
      "INSERT INTO brain_tool_result_spills (session_id, tool_call_id, mode, bytes, preview, path) VALUES ('s1', 'call_0', 'time', 9000, NULL, '/spills/s1/call_0.v1-time-9000.txt')"
    ).run();
    old.close();

    const db = openDb(path);
    const cols = db.prepare('PRAGMA table_info(brain_tool_result_spills)').all().map((r: any) => r.name);
    expect(cols).toContain('occurred_at');
    expect(cols).toContain('placeholder');
    // The deployed row survives as a LEGACY row: occurrence unknown (0), placeholder unrecorded (NULL).
    const row = db.prepare("SELECT * FROM brain_tool_result_spills WHERE session_id='s1'").get() as any;
    expect(row.occurred_at).toBe(0);
    expect(row.placeholder).toBeNull();
    expect(row.path).toBe('/spills/s1/call_0.v1-time-9000.txt');
    // The widened key is the point: the same tool_call_id may now latch a SECOND occurrence — the old
    // PK made that an insert conflict, which forced one row to swallow both occurrences.
    db.prepare(
      "INSERT INTO brain_tool_result_spills (session_id, tool_call_id, occurred_at, mode, bytes, preview, path, placeholder) VALUES ('s1', 'call_0', 1754600000000, 'time', 5000, NULL, '/spills/s1/call_0.v1-time-5000.txt', '[cleared]')"
    ).run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM brain_tool_result_spills WHERE tool_call_id='call_0'").get()).toEqual({ n: 2 });
  });
});

describe('openDb — snake_case → TitleCase tool rename', () => {
  /** A DB from before the rename: real schema, tool names stored the old way, user_version rewound so
   *  the one-shot migration is armed. Seeding through openDb keeps the fixture honest — no hand-written
   *  schema to drift from the real one. */
  function seedPreRename(seed: (db: Database.Database) => void): string {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'old.db');
    const db = openDb(path);
    seed(db);
    db.pragma('user_version = 0');
    db.close();
    return path;
  }
  const perms = (db: Database.Database, userId: number) =>
    JSON.parse((db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'permissions'").get(userId) as { value: string }).value);
  const scope = (db: Database.Database, id: string) =>
    JSON.parse((db.prepare('SELECT delegated_access FROM brain_sessions WHERE id = ?').get(id) as { delegated_access: string }).delegated_access);

  it("carries ElowenDocs onto DocsSearch in a delegated child's frozen boundary", () => {
    // The real regression: 754 stored boundaries named the old tool, and they are ALLOW-lists, so a
    // read-only sub-agent that had been granted the manual would silently lose it. A stale DENY is worse
    // still — it stops matching and switches its tool back on.
    const path = seedPreRename((db) => {
      db.prepare("INSERT INTO users (id, username, password_hash, disabled_tools) VALUES (1, 'a', 'h', ?)")
        .run('ElowenDocs,Bash');
      db.prepare("INSERT INTO brain_sessions (id, user_id, model, delegated_access) VALUES ('c1', 1, 'm', ?)").run(JSON.stringify({
        admin: false, projectIds: [], owner: false,
        toolPolicy: { allow: ['ElowenDocs', 'CodebaseSearch'], deny: [] },
      }));
    });
    const db = openDb(path);
    expect(scope(db, 'c1').toolPolicy.allow).toEqual(['DocsSearch', 'CodebaseSearch']);
    expect((db.prepare('SELECT disabled_tools FROM users WHERE id = 1').get() as { disabled_tools: string }).disabled_tools)
      .toBe('DocsSearch,Bash');
  });

  it("rewrites a user's tool deny-list, leaving names it does not own alone", () => {
    const path = seedPreRename((db) => {
      db.prepare("INSERT INTO users (id, username, password_hash, disabled_tools) VALUES (1, 'a', 'h', ?)")
        // Two of ours, one bridged MCP name, one from a plugin we've never heard of.
        .run('run_command,write_file,mcp_chrome_devtools_click,sarah_hair_booking');
    });
    const db = openDb(path);
    expect((db.prepare('SELECT disabled_tools FROM users WHERE id = 1').get() as { disabled_tools: string }).disabled_tools)
      .toBe('Bash,Write,mcp_chrome_devtools_click,sarah_hair_booking');
  });

  it('rewrites saved tool rules but never bash command patterns, and keeps rule order', () => {
    const path = seedPreRename((db) => {
      db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'a', 'h')").run();
      db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (1, 'permissions', ?)").run(JSON.stringify({
        tools: { '*': 'allow', write_file: 'ask', edit_file: 'deny' },
        bash: { 'git status*': 'allow', 'read_file x': 'deny' },
        yolo: false, unattendedAsks: 'allow',
      }));
    });
    const db = openDb(path);
    const p = perms(db, 1);
    // Order is precedence (last match wins) — a rebuilt map that reordered these would silently
    // re-rank the user's rules.
    expect(Object.keys(p.tools)).toEqual(['*', 'Write', 'Edit']);
    expect(p.tools).toEqual({ '*': 'allow', Write: 'ask', Edit: 'deny' });
    // bash patterns are shell commands, not tool names: "read_file x" is a command that must survive.
    expect(p.bash).toEqual({ 'git status*': 'allow', 'read_file x': 'deny' });
  });

  it("rewrites a delegated child's frozen boundary (tool rules and toolPolicy, not bash)", () => {
    const path = seedPreRename((db) => {
      db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'a', 'h')").run();
      db.prepare("INSERT INTO brain_sessions (id, user_id, model, delegated_access) VALUES ('c1', 1, 'm', ?)").run(JSON.stringify({
        admin: false, projectIds: [9], owner: false,
        toolPolicy: { allow: ['read_file', 'codebase_search'], deny: ['discord_api'] },
        permissionBoundary: {
          rules: [
            { scope: 'tools', pattern: '*', action: 'allow' },
            { scope: 'tools', pattern: 'write_file', action: 'ask' },
            { scope: 'bash', pattern: 'git status*', action: 'allow' },
          ],
          unattendedAsks: 'allow',
        },
      }));
    });
    const db = openDb(path);
    const s = scope(db, 'c1');
    expect(s.toolPolicy).toEqual({ allow: ['Read', 'CodebaseSearch'], deny: ['DiscordApi'] });
    expect(s.permissionBoundary.rules).toEqual([
      { scope: 'tools', pattern: '*', action: 'allow' }, // the wildcard is not a name — untouched
      { scope: 'tools', pattern: 'Write', action: 'ask' },
      { scope: 'bash', pattern: 'git status*', action: 'allow' },
    ]);
    expect(s.projectIds).toEqual([9]); // the rest of the boundary is carried through verbatim
  });

  it('runs exactly once: a later tool legitimately named run_command is not rewritten', () => {
    const path = seedPreRename((db) => {
      db.prepare("INSERT INTO users (id, username, password_hash, disabled_tools) VALUES (1, 'a', 'h', 'run_command')").run();
    });
    openDb(path).close();
    // A third-party plugin claims the freed name and the user denies it. Without the user_version gate
    // the next boot would rewrite their rule to 'Bash' and deny OUR shell tool instead.
    const mid = openDb(path);
    mid.prepare("UPDATE users SET disabled_tools = 'run_command' WHERE id = 1").run();
    mid.close();
    const db = openDb(path);
    expect((db.prepare('SELECT disabled_tools FROM users WHERE id = 1').get() as { disabled_tools: string }).disabled_tools).toBe('run_command');
    expect(db.pragma('user_version', { simple: true })).toBe(17); // every one-shot migration is done
  });

  it("leaves a platform role's stale tool list alone — the host stopped reading it, so it is inert", () => {
    const path = seedPreRename((db) => {
      db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({
        plugins: { config: {
          discord: { botToken: 'x', rolePolicies: [
            { roleId: '1', name: 'admin', tools: [] },                       // empty = unrestricted
            { roleId: '2', name: 'everyone', tools: ['*'] },                 // '*' = unrestricted
            { roleId: '3', name: 'support', tools: ['discord_read_channel', 'ask_user_question', 'sarah_hair'] },
          ] },
          telegram: { rolePolicies: [{ roleId: '4', name: 'ops', tools: ['run_command'] }] },
          files: { readCap: 100000 },                                        // a config with no rolePolicies
        } },
      }));
    });
    const db = openDb(path);
    const cfg = JSON.parse((db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string }).data).plugins.config;
    // The names are deliberately NOT rewritten any more. A role's tool list was read by nothing, so
    // maintaining it only kept alive a restriction the host never enforced. It is left exactly as the
    // operator wrote it — unknown config keys are preserved rather than dropped, so nobody's blob is
    // silently rewritten — and it simply no longer means anything.
    expect(cfg.discord.rolePolicies.map((r: { tools: string[] }) => r.tools)).toEqual([
      [], ['*'], ['discord_read_channel', 'ask_user_question', 'sarah_hair'],
    ]);
    expect(cfg.telegram.rolePolicies[0].tools).toEqual(['run_command']);
    expect(cfg.files).toEqual({ readCap: 100000 });
  });

  it('gives MCP bridged names double separators, split against the configured servers', () => {
    const path = seedPreRename((db) => {
      db.prepare("INSERT INTO users (id, username, password_hash, disabled_tools) VALUES (1, 'a', 'h', ?)").run(
        // The 2nd name is the case that makes the old format unsplittable on its own: both the server and
        // the tool contain '_'. The 3rd names a server no longer configured. The 4th is not an MCP name.
        'mcp_chrome_devtools_click,mcp_chrome_devtools_performance_analyze_insight,mcp_ghost_thing,Bash',
      );
      db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({
        plugins: { config: { mcp: { servers: [{ name: 'chrome-devtools', enabled: true }] } } },
      }));
    });
    const db = openDb(path);
    expect((db.prepare('SELECT disabled_tools FROM users WHERE id = 1').get() as { disabled_tools: string }).disabled_tools)
      .toBe('mcp__chrome_devtools__click,mcp__chrome_devtools__performance_analyze_insight,mcp_ghost_thing,Bash');
    expect(db.pragma('user_version', { simple: true })).toBe(17);
  });

  it('prefers the longest matching server, so one name cannot be split by another\'s prefix', () => {
    const path = seedPreRename((db) => {
      db.prepare("INSERT INTO users (id, username, password_hash, disabled_tools) VALUES (1, 'a', 'h', 'mcp_gh_enterprise_list_repos')").run();
      db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({
        plugins: { config: { mcp: { servers: [{ name: 'gh' }, { name: 'gh-enterprise' }] } } },
      }));
    });
    const db = openDb(path);
    // 'gh' also prefixes this name; splitting on it would yield mcp__gh__enterprise_list_repos.
    expect((db.prepare('SELECT disabled_tools FROM users WHERE id = 1').get() as { disabled_tools: string }).disabled_tools)
      .toBe('mcp__gh_enterprise__list_repos');
  });

  it('leaves MCP names alone when no server is configured to split them against', () => {
    const path = seedPreRename((db) => {
      db.prepare("INSERT INTO users (id, username, password_hash, disabled_tools) VALUES (1, 'a', 'h', 'mcp_chrome_devtools_click')").run();
      db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({ plugins: { config: {} } }));
    });
    const db = openDb(path);
    expect((db.prepare('SELECT disabled_tools FROM users WHERE id = 1').get() as { disabled_tools: string }).disabled_tools)
      .toBe('mcp_chrome_devtools_click');
    expect(db.pragma('user_version', { simple: true })).toBe(17); // still marked done — there was nothing to do
  });

  it('leaves a corrupt permissions blob exactly as found', () => {
    const path = seedPreRename((db) => {
      db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'a', 'h')").run();
      db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (1, 'permissions', '{not json')").run();
    });
    const db = openDb(path);
    expect((db.prepare("SELECT value FROM user_settings WHERE user_id = 1 AND key = 'permissions'").get() as { value: string }).value).toBe('{not json');
  });

  // The regression the orca→elowen rebrand shipped: it renamed tool names and never migrated this
  // column, so every deny a user had saved stopped matching and the tool came back ON.
  it('a migrated deny-list still denies the tool it was written for', () => {
    const path = seedPreRename((db) => {
      db.prepare("INSERT INTO users (id, username, password_hash, disabled_tools) VALUES (1, 'a', 'h', 'run_command')").run();
    });
    const users = new UserStore(openDb(path));
    const deny = new Set(users.get(1)?.disabled_tools ?? []);
    expect(toolPermitted('Bash', { deny })).toBe(false);
    expect(toolPermitted('Read', { deny })).toBe(true);
  });
});

describe('openDb — registry plugin tool rename (v3)', () => {
  /** A DB whose rules predate the registry plugins' own TitleCase release. Rewound to 2, not 0: this is
   *  the real starting point — v1 and v2 had already run and marked themselves done, which is the whole
   *  reason these names could not ride along in v1's map. */
  function seedPreRegistryRename(seed: (db: Database.Database) => void): string {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'old.db');
    const db = openDb(path);
    seed(db);
    db.pragma('user_version = 2');
    db.close();
    return path;
  }

  it('rewrites a deny-list written against the registry plugins, leaving other names alone', () => {
    const path = seedPreRegistryRename((db) => {
      db.prepare("INSERT INTO users (id, username, password_hash, disabled_tools) VALUES (1, 'a', 'h', ?)")
        // Registry tools, one built-in already migrated by v1, and one name we do not own.
        .run('todo_write,web_fetch,generate_image,Bash,sarah_hair_booking');
    });
    const db = openDb(path);
    expect((db.prepare('SELECT disabled_tools FROM users WHERE id = 1').get() as { disabled_tools: string }).disabled_tools)
      .toBe('TodoWrite,WebFetch,GenerateImage,Bash,sarah_hair_booking');
  });

  it('namespaces mem0 rather than colliding with the brain\'s own memory tools', () => {
    // MemorySearch/MemoryAdd already belong to the built-in memory toolset, which mem0 REPLACES. Renaming
    // onto those names would point one rule at two different backends.
    const path = seedPreRegistryRename((db) => {
      db.prepare("INSERT INTO users (id, username, password_hash, disabled_tools) VALUES (1, 'a', 'h', 'search_memory,add_memory')").run();
    });
    const db = openDb(path);
    const denied = (db.prepare('SELECT disabled_tools FROM users WHERE id = 1').get() as { disabled_tools: string }).disabled_tools;
    expect(denied).toBe('Mem0Search,Mem0Add');
    expect(denied).not.toContain('MemorySearch');
  });

  it('a migrated deny still denies, and the tool it names is the one the plugin now offers', () => {
    const path = seedPreRegistryRename((db) => {
      db.prepare("INSERT INTO users (id, username, password_hash, disabled_tools) VALUES (1, 'a', 'h', 'todo_write')").run();
    });
    const users = new UserStore(openDb(path));
    const deny = new Set(users.get(1)?.disabled_tools ?? []);
    expect(toolPermitted('TodoWrite', { deny })).toBe(false); // the name todo/0.5.0 registers
    expect(toolPermitted('TodoRead', { deny })).toBe(true);
  });

  it('runs once, and leaves a database that never had these plugins untouched', () => {
    const path = seedPreRegistryRename((db) => {
      db.prepare("INSERT INTO users (id, username, password_hash, disabled_tools) VALUES (1, 'a', 'h', 'Bash')").run();
    });
    openDb(path).close();
    // A later plugin claims the freed snake_case name and the user denies it. Re-running would rewrite
    // their rule to TodoWrite and deny the wrong tool.
    const mid = openDb(path);
    mid.prepare("UPDATE users SET disabled_tools = 'Bash,todo_write' WHERE id = 1").run();
    mid.close();
    const db = openDb(path);
    expect((db.prepare('SELECT disabled_tools FROM users WHERE id = 1').get() as { disabled_tools: string }).disabled_tools)
      .toBe('Bash,todo_write');
    expect(db.pragma('user_version', { simple: true })).toBe(17);
  });

  it('names the image tools verb-first, the way a one-tool plugin is named', () => {
    // `create_skill` → CreateSkill, `scan_code` → ScanCode. A prefix is what a FAMILY earns (CronAdd,
    // Mem0Search); image-gen and image-edit are one tool each.
    const path = seedPreRegistryRename((db) => {
      db.prepare("INSERT INTO users (id, username, password_hash, disabled_tools) VALUES (1, 'a', 'h', 'generate_image,edit_image')").run();
    });
    const db = openDb(path);
    expect((db.prepare('SELECT disabled_tools FROM users WHERE id = 1').get() as { disabled_tools: string }).disabled_tools)
      .toBe('GenerateImage,EditImage');
  });

  it('repairs a rule left on 0.27.5\'s short-lived prefix-first image names', () => {
    // 0.27.5 shipped `generate_image` → ImageGenerate, a name no plugin ever registered. v3 is marked done
    // for anyone who ran it, so only v4 can reach those rules — and a rule matching nothing is a dead DENY.
    const path = seedPreRegistryRename((db) => {
      db.prepare("INSERT INTO users (id, username, password_hash, disabled_tools) VALUES (1, 'a', 'h', 'ImageGenerate,ImageEdit,Bash')").run();
      db.pragma('user_version = 3'); // v3 already ran, with the wrong map
    });
    const db = openDb(path);
    expect((db.prepare('SELECT disabled_tools FROM users WHERE id = 1').get() as { disabled_tools: string }).disabled_tools)
      .toBe('GenerateImage,EditImage,Bash');
    expect(db.pragma('user_version', { simple: true })).toBe(17);
  });
});

describe('openDb — session-event kinds (v5)', () => {
  /** A DB as 0.27.6 left it: the real schema, but `brain_session_events` still carrying the CHECK from
   *  before 'cwd' existed, and user_version parked at 4 so only v5 is armed. Rebuilt by hand because
   *  that constraint is exactly what the fixture has to reproduce. */
  function seedPre5(): string {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'pre5.db');
    const db = openDb(path);
    db.exec('DROP TABLE brain_session_events');
    db.exec(`CREATE TABLE brain_session_events (
      session_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('model', 'mode', 'rename', 'reasoning')),
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, event_id)
    )`);
    db.prepare("INSERT INTO brain_session_events (session_id, event_id, kind, detail, created_at) VALUES ('s1', 'e1', 'model', 'gpt-5.6', '2026-07-01 10:00:00')").run();
    db.pragma('user_version = 4');
    db.close();
    return path;
  }

  const insertCwd = (db: Database.Database): void => {
    db.prepare("INSERT INTO brain_session_events (session_id, event_id, kind, detail) VALUES ('s1', 'e2', 'cwd', '/srv/api')").run();
  };

  it('accepts a cwd marker on a database that predates the kind, carrying the old markers across', () => {
    const path = seedPre5();
    const db = openDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(17);

    expect(() => insertCwd(db)).not.toThrow();
    expect(db.prepare('SELECT event_id, kind, detail, created_at FROM brain_session_events ORDER BY event_id').all())
      .toEqual([
        { event_id: 'e1', kind: 'model', detail: 'gpt-5.6', created_at: '2026-07-01 10:00:00' },
        expect.objectContaining({ event_id: 'e2', kind: 'cwd', detail: '/srv/api' }),
      ]);
  });

  it('still rejects a kind nobody defined, so the rebuilt table is constrained and not merely open', () => {
    const db = openDb(seedPre5());
    expect(() => db.prepare("INSERT INTO brain_session_events (session_id, event_id, kind, detail) VALUES ('s1', 'e3', 'banana', 'x')").run())
      .toThrow(/CHECK/i);
  });

  it('leaves a database that already carries the kind untouched', () => {
    const path = seedPre5();
    openDb(path).close();     // v5 runs here
    const db = openDb(path);  // ...and must not rebuild the table a second time
    expect(db.pragma('user_version', { simple: true })).toBe(17);
    expect(() => insertCwd(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM brain_session_events').get()).toEqual({ n: 2 });
  });
});

describe('openDb — drop personality tables (v6)', () => {
  const hasTable = (db: Database.Database, name: string): boolean =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);

  /** A DB as it stood before the personality collapse: the schema still up to v5, plus the two retired
   *  personality tables hand-recreated (schema.sql no longer makes them), user_version parked at 5 so
   *  only v6 is armed. */
  function seedPre6(): string {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'pre6.db');
    const db = openDb(path);
    db.exec(`CREATE TABLE personality_profiles (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, platform TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL);
             CREATE INDEX idx_personality_profiles_user_platform ON personality_profiles(user_id, platform);
             CREATE TABLE personality_active_profiles (user_id INTEGER NOT NULL, platform TEXT NOT NULL, profile_id INTEGER NOT NULL, PRIMARY KEY (user_id, platform));`);
    db.pragma('user_version = 5');
    db.close();
    return path;
  }

  it('drops both personality tables (and their indexes) on a database that predates the collapse', () => {
    const path = seedPre6();
    const db = openDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(17);
    expect(hasTable(db, 'personality_profiles')).toBe(false);
    expect(hasTable(db, 'personality_active_profiles')).toBe(false);
    // The index went with its table — no orphan left behind.
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name = 'idx_personality_profiles_user_platform'").get()).toBeUndefined();
  });

  it('is a no-op on a fresh database that never had the tables (idempotent)', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(17);
    expect(hasTable(db, 'personality_profiles')).toBe(false);
    expect(hasTable(db, 'personality_active_profiles')).toBe(false);
  });
});

describe('openDb — monotonic user ids (v7)', () => {
  const addUser = (db: Database.Database, username: string): number =>
    Number(db.prepare("INSERT INTO users (username, password_hash) VALUES (?, 'x')").run(username).lastInsertRowid);

  /** A DB as it stood before user ids were made monotonic: `users` rebuilt by hand WITHOUT
   *  AUTOINCREMENT (that missing keyword is the whole point of the fixture), three users seeded, and
   *  user_version parked at 6 so only v7 is armed. */
  function seedPre7(): string {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'pre7.db');
    const db = openDb(path);
    db.exec('DROP TABLE users');
    db.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_admin INTEGER NOT NULL DEFAULT 0,
      allowed_execs TEXT NOT NULL DEFAULT '',
      disabled_tools TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '',
      default_exec TEXT NOT NULL DEFAULT '',
      advisor_exec TEXT NOT NULL DEFAULT '',
      advisor_autostart INTEGER NOT NULL DEFAULT 1
    )`);
    db.prepare("INSERT INTO users (id, username, password_hash, is_admin, email, created_at) VALUES (1, 'alice', 'h1', 1, 'a@x', '2026-01-01 09:00:00')").run();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES (2, 'bob', 'h2')").run();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES (3, 'carol', 'h3')").run();
    db.pragma('user_version = 6');
    db.close();
    return path;
  }

  // Guards the fixture itself: if this ever stops reproducing the reuse, the migration test below would
  // pass for the wrong reason — it would be asserting against a database that was never broken.
  it('the pre-migration table really does recycle a deleted id (the bug being fixed)', () => {
    const path = seedPre7();
    const db = new Database(path); // opened raw — openDb would migrate it out from under the assertion
    db.prepare('DELETE FROM users WHERE id = 3').run();
    expect(addUser(db, 'dave')).toBe(3); // carol's id, handed straight to a different person
    db.close();
  });

  it('rebuilds a legacy table, preserving every row, id and column value', () => {
    const db = openDb(seedPre7());
    expect(db.pragma('user_version', { simple: true })).toBe(17);
    expect(db.prepare('SELECT id, username, password_hash, is_admin, email, created_at FROM users ORDER BY id').all())
      .toEqual([
        { id: 1, username: 'alice', password_hash: 'h1', is_admin: 1, email: 'a@x', created_at: '2026-01-01 09:00:00' },
        { id: 2, username: 'bob', password_hash: 'h2', is_admin: 0, email: '', created_at: expect.any(String) },
        { id: 3, username: 'carol', password_hash: 'h3', is_admin: 0, email: '', created_at: expect.any(String) },
      ]);
    // The UNIQUE on username came across with the rebuild rather than being left behind on the old table.
    expect(() => addUser(db, 'alice')).toThrow(/UNIQUE/i);
  });

  it('never hands a deleted user id to the next account', () => {
    const db = openDb(seedPre7());
    db.prepare('DELETE FROM users WHERE id = 3').run();  // delete the HIGHEST id — the reusable one
    expect(addUser(db, 'dave')).toBe(4);                 // 4, not carol's 3
    // Deleting the new highest again still moves forward, so the counter is genuinely monotonic and
    // not merely one-off correct.
    db.prepare('DELETE FROM users WHERE id = 4').run();
    expect(addUser(db, 'erin')).toBe(5);
  });

  it('holds through the real UserStore path, not just raw inserts', () => {
    const path = seedPre7();
    const store = new UserStore(openDb(path));
    store.delete(3);
    expect(store.create('dave', 'pw').id).toBe(4);
  });

  // The case a plain rebuild gets WRONG, found by review against the live database: a user deleted
  // BEFORE the migration leaves rows behind, but is gone from `users`, so seeding sqlite_sequence from
  // the surviving rows puts the counter BELOW that id and the next account is handed the departed
  // user's data. Production really is in this state (brain_sessions.user_id = 4, no user 4).
  it('never reissues an id that a deleted user left referenced elsewhere', () => {
    const path = seedPre7();
    const seeded = new Database(path);
    // User 4 existed, was deleted, and left a conversation behind — the row `users` no longer explains.
    seeded.prepare("INSERT INTO brain_sessions (id, user_id, title) VALUES ('brain-4-orphan', 4, 'gone user')").run();
    seeded.close();

    const db = openDb(path);
    // Highest SURVIVING user is 3; the highest REFERENCED user is 4. Handing out 4 would inherit the
    // orphaned conversation, so the counter must clear it.
    expect(addUser(db, 'dave')).toBe(5);
    // …and the orphaned row is left untouched: unreachable is the goal, deletion is a separate decision.
    expect(db.prepare("SELECT user_id FROM brain_sessions WHERE id = 'brain-4-orphan'").get()).toEqual({ user_id: 4 });
  });

  // v8: a database migrated by the FIRST version of v7 is already AUTOINCREMENT but its counter was
  // seeded only from surviving users, so it still hands out a referenced id. v7 cannot fix it (a version
  // never runs twice), so v8 re-seeds. The live database was found in exactly this state.
  it('repairs a counter left below a referenced id by the earlier v7', () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'v7-early.db');
    const seeded = openDb(path); // fresh: already AUTOINCREMENT, user_version at the current max
    seeded.prepare("INSERT INTO users (id, username, password_hash) VALUES (3, 'carol', 'h')").run();
    seeded.prepare("INSERT INTO brain_sessions (id, user_id, title) VALUES ('brain-9-orphan', 9, 'gone')").run();
    seeded.prepare("UPDATE sqlite_sequence SET seq = 3 WHERE name = 'users'").run(); // as the early v7 left it
    seeded.pragma('user_version = 7'); // ran v7, never saw the seed fix
    seeded.close();

    const db = openDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(17);
    expect(addUser(db, 'dave')).toBe(10); // clears the orphaned 9 rather than reissuing it
  });

  it('leaves a fresh database alone — already monotonic, nothing to rebuild', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(17);
    const a = addUser(db, 'alice');
    db.prepare('DELETE FROM users WHERE id = ?').run(a);
    expect(addUser(db, 'bob')).toBe(a + 1);
  });

  it('runs once: a second open does not rebuild the table or disturb the counter', () => {
    const path = seedPre7();
    openDb(path).close();      // v7 runs here
    const db = openDb(path);   // ...and must not rebuild a second time
    expect(db.pragma('user_version', { simple: true })).toBe(17);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 3 });
    expect(addUser(db, 'dave')).toBe(4); // counter survived the reopen, so it did not restart at max(id)
  });
});

describe('concurrent openDb', () => {
  it('arms busy_timeout before switching the journal, so a concurrent WAL switch waits instead of throwing', () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const db = openDb(join(dir, 'fresh.db'));
    // Both must hold: a timeout of 0 means the loser of a first-open race fails instantly, and the
    // ordering that guarantees it is armed first is only observable through the race test below.
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('opens without migrating when asked, leaving the file untouched for the migrating process', () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'unmigrated.db');
    const plain = openDb(path, { migrate: false });
    // A runner process must not create the schema: it opens a database the daemon already migrated.
    const tables = plain.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tables).toEqual([]);
    plain.close();
    // ...and the migrating open still works on that same file afterwards.
    const migrated = openDb(path);
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get()).toBeTruthy();
  });

  it('survives many processes migrating one database at the same time', async () => {
    // The real failure this guards: addColumn reads the table shape and then ALTERs it, so without a
    // single write-locked transaction two processes both see the column missing and the loser dies on
    // "duplicate column name". Needs REAL processes — one thread cannot hold a lock against itself.
    const compiled = fileURLToPath(new URL('../../dist/store/db.js', import.meta.url));
    if (!existsSync(compiled)) return; // built artefacts only; skipped until `npm run build` has run
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-'));
    const path = join(dir, 'race.db');
    // A CURRENT schema missing exactly one additive column. A fresh database would not reproduce this:
    // schema.sql creates every column, so each addColumn is a no-op, and the racers serialize harmlessly
    // on that long batch anyway. Removing one column puts all of them on the same single ALTER.
    const seeded = openDb(path);
    seeded.exec('ALTER TABLE projects DROP COLUMN notes');
    seeded.close();
    // Each racer imports first, then spins to a shared wall-clock instant, so the import cost (tens of
    // milliseconds, and uneven) cannot stagger them past the window being tested.
    const startAt = Date.now() + 800;
    const src = `const m = await import('${pathToFileURL(compiled).href}');\nwhile (Date.now() < ${startAt}) {}\ntry { m.openDb(process.argv[1]); process.exit(0); } catch (e) { console.error(e.message); process.exit(1); }`;
    const racers = Array.from({ length: 8 }, () =>
      spawn(process.execPath, ['--input-type=module', '-e', src, path], { stdio: ['ignore', 'ignore', 'pipe'] }));
    const failures = await Promise.all(racers.map((p) => new Promise<string>((resolve) => {
      let err = '';
      p.stderr.on('data', (d) => { err += String(d); });
      p.on('close', (code) => resolve(code === 0 ? '' : err.trim()));
    })));
    expect(failures.filter(Boolean)).toEqual([]);
    // ...and the column is there once, so the winner's work is complete rather than half-applied.
    const db = openDb(path);
    expect(db.prepare('PRAGMA table_info(projects)').all().filter((r: any) => r.name === 'notes')).toHaveLength(1);
  }, 30_000);
});

// runOnce compares the requested version against ONE shared `user_version` counter, so a number that is
// already taken -- or merely lower than the database's current value -- is skipped in complete silence.
// That is exactly how the heatmap seed shipped as a no-op: it was numbered 9, a number another migration
// already used, against live databases sitting at 14. Nothing failed; the feature was just empty.
describe('migration versions', () => {
  it('are unique, so no migration is silently skipped', () => {
    const source = readFileSync(new URL('../../src/store/db.ts', import.meta.url), 'utf8');
    const versions = [...source.matchAll(/runOnce\(db,\s*(\d+)/g)].map((m) => Number(m[1]));

    expect(versions.length).toBeGreaterThan(5);
    const duplicates = versions.filter((v, i) => versions.indexOf(v) !== i);
    expect(duplicates).toEqual([]);
  });
});
