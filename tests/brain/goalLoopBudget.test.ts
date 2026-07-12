import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { GoalLoopService } from '../../src/brain/service/goalLoop.js';
import type { BrainGoalRow } from '../../src/store/brainStore.js';

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

/** Build a GoalLoopService over a real in-memory store, with the drive/lifecycle deps stubbed. `yolo`
 *  and the budgets are injected so the budget-branch behaviour can be exercised directly. A goal is
 *  seeded active with `turnsUsed` already banked, so the next judge lands exactly on the budget edge. */
function harness(opts: { yolo: boolean; turnBudget: number; turnsUsed: number; goalMaxTurns: number }) {
  const store = new BrainStore(openDb(':memory:'));
  store.createSession({ id: 'brain-1', userId: 1, title: 'T', model: 'm' });
  store.upsertGoal({ sessionId: 'brain-1', userId: 1, goal: 'Keep working', turnBudget: opts.turnBudget });
  store.updateGoal('brain-1', { turns_used: opts.turnsUsed });
  // A benign assistant turn: no GOAL_DONE, no BLOCKED — the judge falls through to the budget check.
  store.appendMessage({ id: 'a1', sessionId: 'brain-1', parentId: null, role: 'assistant', content: { content: 'Progress: still working on it.' } });
  const send = vi.fn(async () => {});
  const loop = new GoalLoopService({
    store,
    ownedUserSession: (_u, s) => s,
    activeSessionId: () => 'brain-1', // driver present → a YOLO continuation is allowed to schedule
    attachedCount: () => 0,
    ensureLive: async () => {},
    start: async () => ({ sessionId: 'brain-1' }),
    send,
    defaultTurnBudget: () => 8,
    goalMaxTurns: () => opts.goalMaxTurns,
    isYolo: () => opts.yolo,
    publishGoal: () => {},
  });
  return { store, loop };
}

describe('GoalLoopService — budget + YOLO', () => {
  it('publishes an active goal before its kickoff turn settles, then publishes completion', async () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'brain-1', userId: 1, title: 'T', model: 'm' });
    const kickoff = deferred<void>();
    const published: Array<BrainGoalRow | null> = [];
    const loop = new GoalLoopService({
      store,
      ownedUserSession: (_userId, sessionId) => sessionId,
      activeSessionId: () => 'brain-1',
      attachedCount: () => 1,
      ensureLive: async () => {},
      start: async () => ({ sessionId: 'brain-1' }),
      send: async () => kickoff.promise,
      defaultTurnBudget: () => 8,
      goalMaxTurns: () => 64,
      isYolo: () => false,
      publishGoal: (_sessionId, goal) => { published.push(goal); },
    });

    let requestSettled = false;
    const request = loop.setGoal(1, 'Ship the goal indicator', {}, 'brain-1')
      .then((goal) => { requestSettled = true; return goal; });
    await Promise.resolve();
    await Promise.resolve();

    expect(requestSettled).toBe(false);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ status: 'active', goal: 'Ship the goal indicator' });

    kickoff.resolve();
    await request;
    store.appendMessage({
      id: 'a1', sessionId: 'brain-1', parentId: null, role: 'assistant',
      content: { content: 'GOAL_DONE: indicator verified in tmux' },
    });
    loop.afterTurnGoalJudge(1, 'brain-1', 'build', { goalKickoff: true });

    expect(published.at(-1)).toMatchObject({ status: 'done', last_verdict: 'done' });
  });

  it('pauses at the turn budget for confirmation when NOT in YOLO', () => {
    const { store, loop } = harness({ yolo: false, turnBudget: 2, turnsUsed: 1, goalMaxTurns: 64 });
    loop.afterTurnGoalJudge(1, 'brain-1', 'build');
    const g = store.getGoal('brain-1')!;
    expect(g.status).toBe('paused');
    expect(g.last_verdict).toBe('budget_reached');
    expect(g.paused_reason).toContain('turn budget reached');
  });

  it('keeps going past a spent budget in YOLO (below the safety ceiling)', () => {
    const { store, loop } = harness({ yolo: true, turnBudget: 2, turnsUsed: 1, goalMaxTurns: 8 });
    loop.afterTurnGoalJudge(1, 'brain-1', 'build');
    const g = store.getGoal('brain-1')!;
    expect(g.status).toBe('active'); // not paused — the loop continues
    expect(g.last_verdict).toBe('continue');
    loop.cancelGoalContinuation('brain-1'); // clear the scheduled timer
  });

  it('pauses even in YOLO once the absolute safety ceiling is hit', () => {
    const { store, loop } = harness({ yolo: true, turnBudget: 2, turnsUsed: 3, goalMaxTurns: 4 });
    loop.afterTurnGoalJudge(1, 'brain-1', 'build');
    const g = store.getGoal('brain-1')!;
    expect(g.status).toBe('paused');
    expect(g.last_verdict).toBe('budget_reached');
    expect(g.paused_reason).toContain('safety ceiling');
  });

  it('floors the ceiling at the budget: a ceiling below the budget still pauses at the budget edge, honestly', () => {
    // Misconfig: per-goal budget (5) above the absolute ceiling (3). YOLO must NOT run the whole budget
    // before "pausing" — the effective ceiling is max(ceiling, budget) = 5, so it pauses at turn 5 with a
    // truthful reason, not `safety ceiling reached (5/3)`.
    const { store, loop } = harness({ yolo: true, turnBudget: 5, turnsUsed: 4, goalMaxTurns: 3 });
    loop.afterTurnGoalJudge(1, 'brain-1', 'build');
    const g = store.getGoal('brain-1')!;
    expect(g.status).toBe('paused');
    expect(g.paused_reason).toBe('safety ceiling reached (5/5)');
  });

  it('a new goal without an explicit budget takes the operator default', () => {
    const { store, loop } = harness({ yolo: false, turnBudget: 2, turnsUsed: 0, goalMaxTurns: 64 });
    // defaultTurnBudget() is 8 in the harness — an unbudgeted setGoal should adopt it.
    return loop.setGoal(1, 'Fresh goal', {}, 'brain-1').then(() => {
      expect(store.getGoal('brain-1')!.turn_budget).toBe(8);
    });
  });
});
