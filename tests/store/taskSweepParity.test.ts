import { describe, it, expect } from 'vitest';
import { deleteAllTaskRows } from '../../src/store/cascade.js';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import type { Db } from '../../src/store/db.js';

/** The admin wipe has two implementations on purpose: the owner's own store when the work plugin is
 *  loaded, and core's tolerant sweep when nothing owns the domain (core cannot import the plugin, and
 *  the sweep exists precisely for the no-owner case). Two implementations of one destructive statement
 *  drift, and the drift is invisible — an operator only ever runs ONE of them. This pins them to the
 *  same end state and the same reported counts. */
const TABLES = ['tasks', 'task_deps', 'missions', 'mission_pr', 'notes', 'task_usage'] as const;

function seeded(): Db {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  db.prepare("INSERT INTO tasks (id,project_id,title,type) VALUES ('e-1',1,'Epic','epic')").run();
  db.prepare("INSERT INTO tasks (id,project_id,title,parent_id) VALUES ('t-1',1,'Child','e-1')").run();
  db.prepare("INSERT INTO tasks (id,project_id,title) VALUES ('t-2',1,'Loose')").run();
  db.prepare("INSERT INTO task_deps (task_id,depends_on_id) VALUES ('t-1','e-1')").run();
  db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-e-1','e-1','low','disengaged')").run();
  db.prepare("INSERT INTO mission_pr (mission_id,branch,worktree) VALUES ('m-e-1','b','/w')").run();
  db.prepare("INSERT INTO notes (scope,target,body) VALUES ('handoff','e-1','n')").run();
  db.prepare("INSERT INTO task_usage (task_id,project_id,exec) VALUES ('t-1',1,'x')").run();
  return db;
}

const counts = (db: Db): Record<string, number> =>
  Object.fromEntries(TABLES.map((t) => [t, (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c]));

describe('the admin task wipe', () => {
  it('removes the same rows and reports the same counts with or without the domain owner', () => {
    const owned = seeded();
    const unowned = seeded();
    try {
      const viaOwner = new TaskStore(owned).deleteAll();
      const viaCore = deleteAllTaskRows(unowned);
      expect(viaCore).toEqual(viaOwner);
      expect(counts(unowned)).toEqual(counts(owned));
      // …and it really did wipe: the task family is empty, the projects row is untouched.
      expect(counts(unowned)).toMatchObject({ tasks: 0, task_deps: 0, missions: 0, mission_pr: 0, notes: 0 });
      expect((owned.prepare('SELECT COUNT(*) c FROM projects').get() as { c: number }).c).toBe(1);
    } finally { owned.close(); unowned.close(); }
  });

  // The no-owner case also covers the install that never had the tables at all (plugin disabled since a
  // fresh install): the sweep must report zero instead of throwing "no such table".
  it('tolerates an install where the task tables were never created', async () => {
    const { openDb } = await import('../../src/store/db.js');
    const db = openDb(':memory:');
    try {
      expect(deleteAllTaskRows(db)).toEqual({ tasks: 0, missions: 0 });
    } finally { db.close(); }
  });
});
