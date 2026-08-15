import { describe, it, expect } from 'vitest';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { openWorkDb } from '../helpers/workDb.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { RefMissions, RefTaskStore } from '../helpers/refStores.js';

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
    const tasks = new RefTaskStore(db);
    tasks.create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
    tasks.create({ id: 'c1', project_id: 1, title: 'C', parent_id: 'e1' });
    expect(tasks.deleteEpic('e1').tasks).toBe(2);
    expect(tasks.list()).toEqual([]);
  });

  it('admin wipe (deleteAll + listMissionIds) without the agents tables', () => {
    const db = openWorkDb();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'p','/o')").run();
    const tasks = new RefTaskStore(db);
    tasks.create({ id: 't1', project_id: 1, title: 'T' });
    expect(tasks.listMissionIds()).toEqual([]);
    expect(tasks.deleteAll()).toEqual({ tasks: 1, missions: 0 });
  });

  it('project delete without the agents tables', () => {
    const db = openWorkDb();
    const projects = new ProjectStore(db);
    const p = projects.create({ slug: 'p', path: '/o' });
    new RefTaskStore(db).create({ id: 't1', project_id: p.id, title: 'T' });
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
    const tasks = new RefTaskStore(db);
    const missions = new RefMissions(db);
    // Plugin rows written as SQL against the frozen DDL (tests/fixtures/pluginSchema.ts): the cascade
    // under test is CORE's and must clear them whether or not their owner is installed to write them.
    const note = (scope: string, target: string, body: string) =>
      db.prepare('INSERT INTO notes (scope,target,body) VALUES (?,?,?)').run(scope, target, body);
    tasks.create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
    tasks.create({ id: 'c1', project_id: 1, title: 'C', parent_id: 'e1' });
    missions.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    db.prepare("INSERT INTO mission_pr (mission_id, branch, worktree) VALUES ('m-e1','b','/w')").run();
    note('mission', 'e1', 'n1');
    note('custom', 'e1', 'n2');
    tasks.deleteEpic('e1');
    expect(missions.get('m-e1')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM mission_pr').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM notes').get()).toEqual({ c: 0 });
  });

  it('admin wipe clears missions, PR records and every note', () => {
    const db = openPluginTablesDb();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'p','/o')").run();
    const tasks = new RefTaskStore(db);
    tasks.create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
    new RefMissions(db).create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    db.prepare("INSERT INTO notes (scope,target,body) VALUES ('mission','e1','n')").run();
    expect(tasks.listMissionIds()).toEqual(['m-e1']);
    expect(tasks.deleteAll()).toEqual({ tasks: 1, missions: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM notes').get()).toEqual({ c: 0 });
  });

  it('project delete purges its agents rows and its epics missions', () => {
    const db = openPluginTablesDb();
    const projects = new ProjectStore(db);
    const p = projects.create({ slug: 'p', path: '/o' });
    const tasks = new RefTaskStore(db);
    tasks.create({ id: 'e1', project_id: p.id, title: 'E', type: 'epic' });
    new RefMissions(db).create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
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
    new RefTaskStore(db).create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
    new RefMissions(db).create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1, created_by: u.id });
    users.delete(u.id);
    expect(db.prepare("SELECT created_by FROM missions WHERE id = 'm-e1'").get()).toEqual({ created_by: null });
  });
});
