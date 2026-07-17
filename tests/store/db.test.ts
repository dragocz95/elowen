import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    expect(db.pragma('user_version', { simple: true })).toBe(2); // every one-shot migration is done
  });

  it("rewrites a platform role's tool allow-list, keeping the unrestricted markers intact", () => {
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
    expect(cfg.discord.rolePolicies.map((r: { tools: string[] }) => r.tools)).toEqual([
      [], ['*'], ['DiscordReadChannel', 'AskUserQuestion', 'sarah_hair'], // a foreign plugin's tool rides through
    ]);
    // rolePolicies is a declared config type, not a Discord field — every plugin's config is walked.
    expect(cfg.telegram.rolePolicies[0].tools).toEqual(['Bash']);
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
    expect(db.pragma('user_version', { simple: true })).toBe(2);
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
    expect(db.pragma('user_version', { simple: true })).toBe(2); // still marked done — there was nothing to do
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
