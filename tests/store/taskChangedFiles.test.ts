import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'o','/o')").run();
  const tasks = new TaskStore(db);
  tasks.create({ id: 't', project_id: 1, title: 'T' });
  return { db, tasks };
}

describe('TaskStore changed_files', () => {
  it('round-trips a saved change list with its base/head', () => {
    const { tasks } = setup();
    tasks.saveChangedFiles('t', [{ path: 'a.ts', added: 3, deleted: 1 }], 'aaaa', 'bbbb');
    const t = tasks.get('t')!;
    expect(t.changed_files).toEqual([{ path: 'a.ts', added: 3, deleted: 1 }]);
    expect(t.base_sha).toBe('aaaa');
    expect(t.head_sha).toBe('bbbb');
  });

  it('drops malformed elements from a hand-edited changed_files column', () => {
    const { db, tasks } = setup();
    db.prepare("UPDATE tasks SET changed_files = ? WHERE id = 't'")
      .run(JSON.stringify([{ path: 'ok.ts', added: 1, deleted: 0 }, { nope: true }, 42, null]));
    expect(tasks.get('t')!.changed_files).toEqual([{ path: 'ok.ts', added: 1, deleted: 0 }]); // only the well-formed entry
  });

  it('degrades to [] on a non-array or invalid JSON value', () => {
    const { db, tasks } = setup();
    db.prepare("UPDATE tasks SET changed_files = ? WHERE id = 't'").run('{not json');
    expect(tasks.get('t')!.changed_files).toEqual([]);
    db.prepare("UPDATE tasks SET changed_files = ? WHERE id = 't'").run(JSON.stringify({ not: 'an array' }));
    expect(tasks.get('t')!.changed_files).toEqual([]);
  });
});
