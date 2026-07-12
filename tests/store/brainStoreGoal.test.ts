import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';

describe('BrainStore goals', () => {
  it('persists goal state and deletes it with the owning session', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'brain-1', userId: 1, title: 'T', model: 'm' });
    const goal = store.upsertGoal({ sessionId: 'brain-1', userId: 1, goal: 'Fix failing tests', draft: 'verification: tests pass', turnBudget: 3 });
    expect(goal.status).toBe('active');
    expect(goal.turn_budget).toBe(3);
    expect(goal.draft).toContain('tests pass');

    const updated = store.updateGoal('brain-1', {
      subgoals: JSON.stringify([{ text: 'Run typecheck', done: false }]),
      turns_used: 1,
      last_verdict: 'continue',
    });
    expect(updated?.turns_used).toBe(1);
    expect(updated?.subgoals).toContain('Run typecheck');

    store.deleteSession('brain-1');
    expect(store.getGoal('brain-1')).toBeUndefined();
    expect(store.getSession('brain-1')).toBeUndefined();
  });

  it('renames sessions without losing messages or goal state', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'brain-1', userId: 1, title: 'Old', model: 'm' });
    store.appendMessage({ id: 'm1', sessionId: 'brain-1', parentId: null, role: 'user', content: { content: 'hi' } });
    store.upsertGoal({ sessionId: 'brain-1', userId: 1, goal: 'Keep going' });

    store.renameSession('brain-1', 'New title');

    expect(store.getSession('brain-1')?.title).toBe('New title');
    expect(store.getMessages('brain-1')).toHaveLength(1);
    expect(store.getGoal('brain-1')?.goal).toBe('Keep going');
  });

  it('starts a replacement goal with a fresh elapsed-time origin', () => {
    const db = openDb(':memory:');
    const store = new BrainStore(db);
    store.createSession({ id: 'brain-1', userId: 1, title: 'T', model: 'm' });
    store.upsertGoal({ sessionId: 'brain-1', userId: 1, goal: 'Old goal' });
    db.prepare("UPDATE brain_goals SET created_at = '2000-01-01 00:00:00' WHERE session_id = ?").run('brain-1');

    const replacement = store.upsertGoal({ sessionId: 'brain-1', userId: 1, goal: 'New goal' });

    expect(replacement.goal).toBe('New goal');
    expect(replacement.created_at).not.toBe('2000-01-01 00:00:00');
  });
});
