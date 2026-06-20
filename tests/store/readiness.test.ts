import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';

let store: TaskStore; let ready: Readiness;
beforeEach(() => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  store = new TaskStore(db); ready = new Readiness(db);
  store.create({ id: 't1', project_id: 1, title: 'one' });
  store.create({ id: 't2', project_id: 1, title: 'two' });
  store.addDep('t2', 't1'); // t2 depends on t1
});

describe('Readiness.ready', () => {
  it('returns only the unblocked head while a blocker is open', () => {
    expect(ready.ready(1).map(t => t.id)).toEqual(['t1']);
  });
  it('unblocks the dependent once the blocker is closed', () => {
    store.setStatus('t1', 'closed');
    expect(ready.ready(1).map(t => t.id)).toEqual(['t2']);
  });
  it('excludes epics from the ready set', () => {
    store.create({ id: 'e1', project_id: 1, title: 'epic', type: 'epic' });
    expect(ready.ready(1).map(t => t.id)).toEqual(['t1']);
  });
  it('excludes non-open tasks (in_progress / blocked / closed)', () => {
    store.setStatus('t1', 'in_progress');
    expect(ready.ready(1).map(t => t.id)).toEqual([]); // t2 still blocked by open dep t1
  });
});

describe('Readiness.readyForEpic', () => {
  it('returns only the epic\'s own direct, dependency-cleared children', () => {
    // e1 has children a1, a2 (a2 depends on a1); e2 has child b1. A separate top-level t1 also ready.
    store.create({ id: 'e1', project_id: 1, title: 'epic1', type: 'epic' });
    store.create({ id: 'e2', project_id: 1, title: 'epic2', type: 'epic' });
    store.create({ id: 'a1', project_id: 1, title: 'a1', parent_id: 'e1' });
    store.create({ id: 'a2', project_id: 1, title: 'a2', parent_id: 'e1' });
    store.create({ id: 'b1', project_id: 1, title: 'b1', parent_id: 'e2' });
    store.addDep('a2', 'a1'); // a2 blocked by a1

    expect(ready.readyForEpic('e1').map(t => t.id)).toEqual(['a1']); // a2 blocked, b1/t1 belong elsewhere
    expect(ready.readyForEpic('e2').map(t => t.id)).toEqual(['b1']);
  });
  it('unblocks a dependent child once its blocker closes', () => {
    store.create({ id: 'e1', project_id: 1, title: 'epic1', type: 'epic' });
    store.create({ id: 'a1', project_id: 1, title: 'a1', parent_id: 'e1' });
    store.create({ id: 'a2', project_id: 1, title: 'a2', parent_id: 'e1' });
    store.addDep('a2', 'a1');
    store.setStatus('a1', 'closed');
    expect(ready.readyForEpic('e1').map(t => t.id)).toEqual(['a2']);
  });
  it('does not descend past direct children (grandchildren stay out)', () => {
    store.create({ id: 'e1', project_id: 1, title: 'epic1', type: 'epic' });
    store.create({ id: 'a1', project_id: 1, title: 'a1', parent_id: 'e1' });
    store.create({ id: 'g1', project_id: 1, title: 'grandchild', parent_id: 'a1' });
    expect(ready.readyForEpic('e1').map(t => t.id)).toEqual(['a1']); // g1 is a child of a1, not e1
  });
  it('excludes nested epics from a parent epic\'s children', () => {
    store.create({ id: 'e1', project_id: 1, title: 'epic1', type: 'epic' });
    store.create({ id: 'e1a', project_id: 1, title: 'sub-epic', type: 'epic', parent_id: 'e1' });
    store.create({ id: 'a1', project_id: 1, title: 'a1', parent_id: 'e1' });
    expect(ready.readyForEpic('e1').map(t => t.id)).toEqual(['a1']);
  });
});
