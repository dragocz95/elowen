import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { openWorkDb } from '../helpers/workDb.js';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { NoteStore } from '../../plugins/agents/src/store/noteStore.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { AGENTS_MIGRATIONS } from '../../plugins/agents/src/store/migrations.js';

/** The fresh-install ON/OFF matrix for core's destructive paths over the AGENTS-PLUGIN-owned tables
 *  (missions/mission_pr/agents/notes). OFF = openWorkDb — the task domain's tables (also plugin-owned)
 *  but none of the agents ones; ON = openPluginTablesDb, both plugins' migrations applied. Every path
 *  must work in BOTH shapes:
 *  tolerant of the tables' absence, and still purging plugin rows when they exist — cleanup must not
 *  depend on the plugin being enabled, or orphan rows resurface on re-enable. */
describe('agents tables tolerance (fresh install, plugin OFF)', () => {
  it('epic delete cascades without the agents tables', () => {
    const db = openWorkDb();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'p','/o')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
    tasks.create({ id: 'c1', project_id: 1, title: 'C', parent_id: 'e1' });
    expect(tasks.deleteEpic('e1').tasks).toBe(2);
    expect(tasks.list()).toEqual([]);
  });

  it('admin wipe (deleteAll + listMissionIds) without the agents tables', () => {
    const db = openWorkDb();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'p','/o')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 't1', project_id: 1, title: 'T' });
    expect(tasks.listMissionIds()).toEqual([]);
    expect(tasks.deleteAll()).toEqual({ tasks: 1, missions: 0 });
  });

  it('project delete without the agents tables', () => {
    const db = openWorkDb();
    const projects = new ProjectStore(db);
    const p = projects.create({ slug: 'p', path: '/o' });
    new TaskStore(db).create({ id: 't1', project_id: p.id, title: 'T' });
    expect(projects.remove(p.id)).toBe(true);
    expect(projects.get(p.id)).toBeNull();
  });

  it('user delete without the agents tables (missions.created_by nulling skipped)', () => {
    const db = openWorkDb();
    const users = new UserStore(db);
    const u = users.create('bob', 'pw');
    users.delete(u.id);
    expect(users.list().some((x) => x.username === 'bob')).toBe(false);
  });
});

describe('agents tables purge (plugin ON — tables exist)', () => {
  it('epic delete purges its mission, PR record and notes across all scopes', () => {
    const db = openPluginTablesDb();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'p','/o')").run();
    const tasks = new TaskStore(db);
    const missions = new MissionStore(db);
    const notes = new NoteStore(db);
    tasks.create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
    tasks.create({ id: 'c1', project_id: 1, title: 'C', parent_id: 'e1' });
    missions.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    db.prepare("INSERT INTO mission_pr (mission_id, branch, worktree) VALUES ('m-e1','b','/w')").run();
    notes.add({ scope: 'mission', target: 'e1', body: 'n1' });
    notes.add({ scope: 'custom', target: 'e1', body: 'n2' });
    tasks.deleteEpic('e1');
    expect(missions.get('m-e1')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM mission_pr').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM notes').get()).toEqual({ c: 0 });
  });

  it('admin wipe clears missions, PR records and every note', () => {
    const db = openPluginTablesDb();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'p','/o')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
    new MissionStore(db).create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    new NoteStore(db).add({ scope: 'mission', target: 'e1', body: 'n' });
    expect(tasks.listMissionIds()).toEqual(['m-e1']);
    expect(tasks.deleteAll()).toEqual({ tasks: 1, missions: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM notes').get()).toEqual({ c: 0 });
  });

  it('project delete purges its agents rows and its epics missions', () => {
    const db = openPluginTablesDb();
    const projects = new ProjectStore(db);
    const p = projects.create({ slug: 'p', path: '/o' });
    const tasks = new TaskStore(db);
    tasks.create({ id: 'e1', project_id: p.id, title: 'E', type: 'epic' });
    new MissionStore(db).create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    db.prepare("INSERT INTO agents (project_id, name, program, model) VALUES (?, 'Nova', 'claude', 'sonnet')").run(p.id);
    expect(projects.remove(p.id)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM agents').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM missions').get()).toEqual({ c: 0 });
  });

  it('user delete nulls missions.created_by (no dangling/recycled attribution)', () => {
    const db = openPluginTablesDb();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'p','/o')").run();
    const users = new UserStore(db);
    const u = users.create('bob', 'pw');
    new TaskStore(db).create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
    new MissionStore(db).create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1, created_by: u.id });
    users.delete(u.id);
    expect(db.prepare("SELECT created_by FROM missions WHERE id = 'm-e1'").get()).toEqual({ created_by: null });
  });
});

describe('agents plugin migration v2 (ancient DB safety net)', () => {
  it('adds the once-core columns to a pre-column era table shape', () => {
    const db = openDb(':memory:');
    // An ancient install: tables created by an old core WITHOUT the later column additions.
    db.exec(`
      CREATE TABLE missions (id TEXT PRIMARY KEY, epic_id TEXT NOT NULL, autonomy TEXT NOT NULL,
        max_sessions INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'active',
        started_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE mission_pr (mission_id TEXT PRIMARY KEY, branch TEXT NOT NULL, worktree TEXT NOT NULL,
        pr_number INTEGER, pr_url TEXT, pr_state TEXT, last_review_ts TEXT);
    `);
    // Applying the plugin migrations over it (v1 no-ops on the existing tables, v2 adds the columns).
    for (const step of AGENTS_MIGRATIONS) step.up(db);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('missions')).toEqual(expect.arrayContaining(['created_by', 'pilot_exec', 'overseer_exec']));
    expect(cols('mission_pr')).toEqual(expect.arrayContaining(['fix_rounds', 'last_feedback']));
  });
});
