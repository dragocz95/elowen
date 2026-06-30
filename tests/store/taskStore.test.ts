import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import type { Db } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';

let db: Db;
let store: TaskStore;
beforeEach(() => { db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/var/www/orca')").run(); store = new TaskStore(db); });

describe('TaskStore', () => {
  it('creates and reads a task with parsed labels', () => {
    const t = store.create({ id: 'orca-1', project_id: 1, title: 'A', labels: ['exec:sonnet'] });
    expect(t.title).toBe('A');
    expect(store.get('orca-1')?.labels).toEqual(['exec:sonnet']);
  });
  it('persists created_by (owner) and defaults it to null', () => {
    store.create({ id: 'orca-1', project_id: 1, title: 'A', created_by: 7 });
    store.create({ id: 'orca-2', project_id: 1, title: 'B' });
    expect(store.get('orca-1')?.created_by).toBe(7);
    expect(store.get('orca-2')?.created_by).toBeNull();
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

  it('addDep ignores self-references', () => {
    store.create({ id: 'a', project_id: 1, title: 'A' });
    store.addDep('a', 'a');
    expect(store.depsFor('a')).toEqual([]);
  });

  it('addDep rejects an edge that would create a cycle', () => {
    store.create({ id: 'a', project_id: 1, title: 'A' });
    store.create({ id: 'b', project_id: 1, title: 'B' });
    store.addDep('b', 'a'); // b → a
    store.addDep('a', 'b'); // a → b would close the cycle; must be dropped
    expect(store.depsFor('a')).toEqual([]);
    expect(store.depsFor('b')).toEqual(['a']);
  });

  it('addDep rejects a transitive cycle', () => {
    store.create({ id: 'a', project_id: 1, title: 'A' });
    store.create({ id: 'b', project_id: 1, title: 'B' });
    store.create({ id: 'c', project_id: 1, title: 'C' });
    store.addDep('b', 'a'); // b → a
    store.addDep('c', 'b'); // c → b
    store.addDep('a', 'c'); // a → c closes a→c→b→a; must be dropped
    expect(store.depsFor('a')).toEqual([]);
  });

  it('setDeps drops self-references and cycle-forming edges', () => {
    store.create({ id: 'a', project_id: 1, title: 'A' });
    store.create({ id: 'b', project_id: 1, title: 'B' });
    store.addDep('b', 'a'); // existing b → a
    store.setDeps('a', ['a', 'b']); // self-ref dropped; a → b would cycle, dropped
    expect(store.depsFor('a')).toEqual([]);
  });

  it('update drops a non-string scheduled_at, keeps string/null', () => {
    store.create({ id: 's', project_id: 1, title: 'S', scheduled_at: '2026-06-20T10:00:00.000Z' });
    // A loose request value (number) must not be persisted.
    store.update('s', { scheduled_at: 42 as unknown as string });
    expect(store.get('s')?.scheduled_at).toBe('2026-06-20T10:00:00.000Z'); // untouched
    store.update('s', { scheduled_at: null });
    expect(store.get('s')?.scheduled_at).toBeNull();
    store.update('s', { scheduled_at: '2026-07-01T00:00:00.000Z' });
    expect(store.get('s')?.scheduled_at).toBe('2026-07-01T00:00:00.000Z');
  });

  it('delete of an epic task also removes its mission', () => {
    store.create({ id: 'epic', project_id: 1, title: 'Epic', type: 'epic' });
    db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m1','epic','L3','active')").run();
    store.delete('epic');
    expect(db.prepare("SELECT COUNT(*) c FROM missions WHERE epic_id = 'epic'").get()).toEqual({ c: 0 });
  });

  it('delete of a parent task cascades to its children — never leaves orphaned phases', () => {
    store.create({ id: 'epic', project_id: 1, title: 'Epic', type: 'epic' });
    store.create({ id: 'a', project_id: 1, title: 'A', parent_id: 'epic' });
    store.create({ id: 'b', project_id: 1, title: 'B', parent_id: 'epic' });
    store.create({ id: 'other', project_id: 1, title: 'Other' }); // unrelated, must survive
    store.delete('epic');
    expect(store.get('epic')).toBeNull();
    expect(store.get('a')).toBeNull();
    expect(store.get('b')).toBeNull();
    expect(store.get('other')).not.toBeNull();
  });

  it('delete of a leaf task removes only that task', () => {
    store.create({ id: 'epic', project_id: 1, title: 'Epic', type: 'epic' });
    store.create({ id: 'a', project_id: 1, title: 'A', parent_id: 'epic' });
    store.delete('a');
    expect(store.get('a')).toBeNull();
    expect(store.get('epic')).not.toBeNull(); // the parent and its siblings stay
  });

  it('deleteEpic removes the epic, its whole subtree, their deps and the mission', () => {
    store.create({ id: 'epic', project_id: 1, title: 'Epic', type: 'epic' });
    store.create({ id: 'a', project_id: 1, title: 'A', parent_id: 'epic' });
    store.create({ id: 'b', project_id: 1, title: 'B', parent_id: 'epic' });
    store.addDep('b', 'a');
    db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m1','epic','L3','active')").run();
    db.prepare("INSERT INTO mission_pr (mission_id,branch,worktree) VALUES ('m1','orca/x','/wt/m1')").run();
    store.create({ id: 'other', project_id: 1, title: 'Other' }); // unrelated, must survive

    const removed = store.deleteEpic('epic');
    expect(removed.tasks).toBe(3); // epic + a + b
    expect(store.get('epic')).toBeNull();
    expect(store.get('a')).toBeNull();
    expect(store.get('b')).toBeNull();
    expect(store.depsFor('b')).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) c FROM missions").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM mission_pr").get()).toEqual({ c: 0 }); // PR record torn down too — no orphan
    expect(store.get('other')).not.toBeNull(); // unrelated task untouched
  });

  it('resetReviewFix clears the reviewfix budget on an epic\'s phases, keeping other labels', () => {
    store.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
    store.create({ id: 'p1', project_id: 1, title: 'P1', parent_id: 'epic', labels: ['agent:x', 'reviewfix:2'] });
    store.create({ id: 'p2', project_id: 1, title: 'P2', parent_id: 'epic', labels: ['exec:sonnet'] }); // no reviewfix → untouched
    store.create({ id: 'other', project_id: 1, title: 'O', labels: ['reviewfix:1'] }); // not a child → untouched

    store.resetReviewFix('epic');

    expect(store.get('p1')!.labels).toEqual(['agent:x']);        // reviewfix dropped, agent kept
    expect(store.get('p2')!.labels).toEqual(['exec:sonnet']);    // unchanged
    expect(store.get('other')!.labels).toEqual(['reviewfix:1']); // unrelated task untouched
  });

  it('deleteAll wipes every task, dep and mission and reports the counts', () => {
    store.create({ id: 'epic', project_id: 1, title: 'Epic', type: 'epic' });
    store.create({ id: 'a', project_id: 1, title: 'A', parent_id: 'epic' });
    store.addDep('a', 'epic');
    db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m1','epic','L3','active')").run();
    const removed = store.deleteAll();
    expect(removed).toEqual({ tasks: 2, missions: 1 });
    expect(store.list()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) c FROM task_deps').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM missions').get()).toEqual({ c: 0 });
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

  it('setResumeLabel sets and replaces the resume label, preserving others', () => {
    store.create({ id: 'x', project_id: 1, title: 'X', labels: ['exec:sonnet'] });
    store.setResumeLabel('x', 'claude-code', '7f3a-uuid');
    expect(store.get('x')?.labels).toEqual(['exec:sonnet', 'resume:claude-code:7f3a-uuid']);
    store.setResumeLabel('x', 'opencode', 'ses_99');
    expect(store.get('x')?.labels).toEqual(['exec:sonnet', 'resume:opencode:ses_99']);
  });

  it('setResumeLabel rejects a session id with unsafe characters (CSV/shell defense), clearing any prior', () => {
    store.create({ id: 'x', project_id: 1, title: 'X', labels: ['exec:sonnet'] });
    store.setResumeLabel('x', 'claude-code', 'good-id');
    store.setResumeLabel('x', 'claude-code', "evil,id; rm -rf /");
    expect(store.get('x')?.labels).toEqual(['exec:sonnet']); // unsafe value dropped, no resume label stored
  });

  it('setResumeNote stores the note in its own field, leaving the description untouched', () => {
    store.create({ id: 'x', project_id: 1, title: 'X', description: 'Original brief' });
    store.setResumeNote('x', 'Fix the failing test');
    const t = store.get('x')!;
    expect(t.description).toBe('Original brief'); // description is never mutated
    expect(t.resume_note).toBe('Fix the failing test');
  });

  it('setResumeNote replaces the previous note instead of stacking', () => {
    store.create({ id: 'x', project_id: 1, title: 'X', description: 'Original brief' });
    store.setResumeNote('x', 'First feedback');
    store.setResumeNote('x', 'Second feedback');
    expect(store.get('x')!.resume_note).toBe('Second feedback'); // last write wins, no stacking
  });

  it('setResumeNote with a blank note clears the field back to null', () => {
    store.create({ id: 'x', project_id: 1, title: 'X', description: 'Original brief' });
    store.setResumeNote('x', 'Some feedback');
    store.setResumeNote('x', '   ');
    expect(store.get('x')!.resume_note).toBeNull();
    expect(store.get('x')!.description).toBe('Original brief');
  });

  it('a clean (ok) close clears the resume note so it cannot mislead a later restart', () => {
    store.create({ id: 'x', project_id: 1, title: 'X' });
    store.setResumeNote('x', '[Review rejected] add the missing test');
    store.close('x', { summary: 'done', outcome: 'ok' });
    expect(store.get('x')!.resume_note).toBeNull();
  });

  it('a failing close keeps the resume note (the task may be re-spawned or escalated)', () => {
    store.create({ id: 'x', project_id: 1, title: 'X' });
    store.setResumeNote('x', 'Could not finish — see feedback');
    store.close('x', { summary: 'blocked', outcome: 'fail' });
    expect(store.get('x')!.resume_note).toBe('Could not finish — see feedback');
  });

  describe('reparent', () => {
    it('promotes a plain target to an epic and sets the dragged task as its phase', () => {
      store.create({ id: 'a', project_id: 1, title: 'A' });
      store.create({ id: 'b', project_id: 1, title: 'B' });
      const result = store.reparent('a', 'b');
      expect(result).toEqual({ task: store.get('a') });
      expect(store.get('a')!.parent_id).toBe('b');
      expect(store.get('b')!.type).toBe('epic');
    });
    it('leaves an existing epic\'s type untouched', () => {
      store.create({ id: 'epic', project_id: 1, title: 'Epic', type: 'epic' });
      store.create({ id: 'a', project_id: 1, title: 'A' });
      store.reparent('a', 'epic');
      expect(store.get('epic')!.type).toBe('epic');
      expect(store.get('a')!.parent_id).toBe('epic');
    });
    it('rejects reparenting a task onto itself', () => {
      store.create({ id: 'a', project_id: 1, title: 'A' });
      expect(store.reparent('a', 'a')).toEqual({ error: 'cannot reparent onto itself' });
    });
    it('rejects a cross-project reparent', () => {
      db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/var/www/other')").run();
      store.create({ id: 'a', project_id: 1, title: 'A' });
      store.create({ id: 'b', project_id: 2, title: 'B' });
      expect(store.reparent('a', 'b')).toEqual({ error: 'cross-project reparent not allowed' });
    });
    it('rejects reparenting a task that already has children', () => {
      store.create({ id: 'epic', project_id: 1, title: 'Epic', type: 'epic' });
      store.create({ id: 'phase', project_id: 1, title: 'Phase', parent_id: 'epic' });
      store.create({ id: 'b', project_id: 1, title: 'B' });
      expect(store.reparent('epic', 'b')).toEqual({ error: 'task has its own children' });
    });
    it('rejects reparenting a task that is already a phase', () => {
      store.create({ id: 'epic', project_id: 1, title: 'Epic', type: 'epic' });
      store.create({ id: 'phase', project_id: 1, title: 'Phase', parent_id: 'epic' });
      store.create({ id: 'b', project_id: 1, title: 'B' });
      expect(store.reparent('phase', 'b')).toEqual({ error: 'task is already a phase' });
    });
    it('rejects targeting a task that is already a phase', () => {
      store.create({ id: 'epic', project_id: 1, title: 'Epic', type: 'epic' });
      store.create({ id: 'phase', project_id: 1, title: 'Phase', parent_id: 'epic' });
      store.create({ id: 'a', project_id: 1, title: 'A' });
      expect(store.reparent('a', 'phase')).toEqual({ error: 'target is already a phase' });
    });
    it('rejects reparenting a closed or cancelled task', () => {
      store.create({ id: 'a', project_id: 1, title: 'A' });
      store.create({ id: 'b', project_id: 1, title: 'B' });
      store.setStatus('a', 'closed');
      expect(store.reparent('a', 'b')).toEqual({ error: 'task is already finished' });
      store.setStatus('a', 'cancelled');
      expect(store.reparent('a', 'b')).toEqual({ error: 'task is already finished' });
    });
    it('rejects reparenting a task that is currently running', () => {
      store.create({ id: 'a', project_id: 1, title: 'A' });
      store.setStatus('a', 'in_progress');
      store.create({ id: 'b', project_id: 1, title: 'B' });
      expect(store.reparent('a', 'b')).toEqual({ error: 'task is currently running' });
    });
    it('rejects missing task or target ids', () => {
      store.create({ id: 'a', project_id: 1, title: 'A' });
      expect(store.reparent('missing', 'a')).toEqual({ error: 'task not found' });
      expect(store.reparent('a', 'missing')).toEqual({ error: 'target not found' });
    });
  });
});
