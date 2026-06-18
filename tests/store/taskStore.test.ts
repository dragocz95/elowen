import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';

let store: TaskStore;
beforeEach(() => { const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/var/www/orca')").run(); store = new TaskStore(db); });

describe('TaskStore', () => {
  it('creates and reads a task with parsed labels', () => {
    const t = store.create({ id: 'orca-1', project_id: 1, title: 'A', labels: ['exec:sonnet'] });
    expect(t.title).toBe('A');
    expect(store.get('orca-1')?.labels).toEqual(['exec:sonnet']);
  });
  it('setStatus updates status', () => {
    store.create({ id: 'orca-1', project_id: 1, title: 'A' });
    store.setStatus('orca-1', 'closed');
    expect(store.get('orca-1')?.status).toBe('closed');
  });

  it('close stamps status, summary, outcome and closed_at', () => {
    store.create({ id: 'orca-1', project_id: 1, title: 'A' });
    store.close('orca-1', { summary: 'Built the thing', outcome: 'ok' });
    const t = store.get('orca-1')!;
    expect(t.status).toBe('closed');
    expect(t.result_summary).toBe('Built the thing');
    expect(t.outcome).toBe('ok');
    expect(t.closed_at).toBeTruthy();
  });

  it('close without a summary leaves result fields null', () => {
    store.create({ id: 'orca-2', project_id: 1, title: 'B' });
    store.close('orca-2');
    const t = store.get('orca-2')!;
    expect(t.status).toBe('closed');
    expect(t.result_summary).toBeNull();
    expect(t.outcome).toBeNull();
  });

  it('create stores the autostart flag', () => {
    store.create({ id: 'auto', project_id: 1, title: 'Auto', scheduled_at: '2026-06-18T10:00:00.000Z', autostart: 1 });
    expect(store.get('auto')?.autostart).toBe(1);
    store.create({ id: 'manual', project_id: 1, title: 'Manual' });
    expect(store.get('manual')?.autostart).toBe(0);
  });

  it('descendants returns the transitive subtree excluding the root', () => {
    store.create({ id: 'epic', project_id: 1, title: 'Epic', type: 'epic' });
    store.create({ id: 'a', project_id: 1, title: 'A', parent_id: 'epic' });
    store.create({ id: 'a1', project_id: 1, title: 'A1', parent_id: 'a' });
    store.create({ id: 'other', project_id: 1, title: 'Other' });
    const ids = store.descendants('epic').map((t) => t.id).sort();
    expect(ids).toEqual(['a', 'a1']);
  });

  it('descendants returns empty for a leaf', () => {
    store.create({ id: 'epic', project_id: 1, title: 'Epic', type: 'epic' });
    expect(store.descendants('epic')).toEqual([]);
  });

  it('depsAmong returns only edges with both ends in the set', () => {
    store.create({ id: 'a', project_id: 1, title: 'A' });
    store.create({ id: 'b', project_id: 1, title: 'B' });
    store.create({ id: 'c', project_id: 1, title: 'C' });
    store.addDep('b', 'a'); // b depends on a
    store.addDep('c', 'b'); // c depends on b
    expect(store.depsAmong(['a', 'b'])).toEqual([{ task_id: 'b', depends_on_id: 'a' }]);
    expect(store.depsAmong([])).toEqual([]);
  });

  it('update changes only the provided fields', () => {
    store.create({ id: 'u', project_id: 1, title: 'Old', type: 'task', priority: 'P2' });
    store.update('u', { title: 'New', priority: 'P0' });
    const t = store.get('u')!;
    expect(t.title).toBe('New');
    expect(t.priority).toBe('P0');
    expect(t.type).toBe('task'); // untouched
  });

  it('delete removes the task and its dependency edges', () => {
    store.create({ id: 'a', project_id: 1, title: 'A' });
    store.create({ id: 'b', project_id: 1, title: 'B' });
    store.addDep('b', 'a');
    store.delete('a');
    expect(store.get('a')).toBeNull();
    expect(store.depsAmong(['a', 'b'])).toEqual([]); // edge gone too
  });

  it('setExec sets, replaces and clears the exec label, preserving others', () => {
    store.create({ id: 'x', project_id: 1, title: 'X', labels: ['area:ui'] });
    store.setExec('x', 'sonnet');
    expect(store.get('x')?.labels).toEqual(['area:ui', 'exec:sonnet']);
    store.setExec('x', 'codex:gpt-5.4');
    expect(store.get('x')?.labels).toEqual(['area:ui', 'exec:codex:gpt-5.4']);
    store.setExec('x', '');
    expect(store.get('x')?.labels).toEqual(['area:ui']);
  });
});
