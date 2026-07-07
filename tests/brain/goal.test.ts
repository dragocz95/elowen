import { describe, it, expect } from 'vitest';
import { judgeGoalCompletion, goalPrompt, goalContinuePrompt } from '../../src/brain/goal.js';
import type { BrainGoalRow } from '../../src/store/brainStore.js';

const row = (over: Partial<BrainGoalRow> = {}): BrainGoalRow => ({
  session_id: 's', user_id: 1, status: 'active', goal: 'Ship the feature', draft: '', subgoals: '[]',
  turns_used: 0, turn_budget: 8, last_verdict: '', last_evidence: '', paused_reason: '',
  created_at: '', updated_at: '', ...over,
} as BrainGoalRow);

describe('judgeGoalCompletion — explicit GOAL_DONE sentinel only', () => {
  it('marks done on a start-of-line GOAL_DONE with evidence', () => {
    const r = judgeGoalCompletion('Finished the work.\nGOAL_DONE: all 12 tests pass, build is green');
    expect(r.done).toBe(true);
    expect(r.evidence).toBe('all 12 tests pass, build is green');
  });

  it('does NOT mark done on a negated/echoed prose completion (the old false positive)', () => {
    expect(judgeGoalCompletion('The goal is not yet complete. I edited the config and wrote a test.').done).toBe(false);
    expect(judgeGoalCompletion('Everything is done and tests passed — that is what I will claim once finished.').done).toBe(false);
  });

  it('does not fire on the sentinel mentioned mid-sentence', () => {
    expect(judgeGoalCompletion('I will print GOAL_DONE: <evidence> when I am finished.').done).toBe(false);
  });

  it('rejects an empty or placeholder evidence', () => {
    expect(judgeGoalCompletion('GOAL_DONE:').done).toBe(false);
    expect(judgeGoalCompletion('GOAL_DONE: <evidence>').done).toBe(false);
  });

  it('is case-insensitive and tolerates leading whitespace', () => {
    expect(judgeGoalCompletion('  goal_done: deployed to prod, health 200').done).toBe(true);
  });
});

describe('goal prompts advertise the sentinel', () => {
  it('kickoff and continuation both instruct the model to emit GOAL_DONE only on real completion', () => {
    expect(goalPrompt(row())).toContain('GOAL_DONE:');
    expect(goalContinuePrompt(row())).toContain('GOAL_DONE:');
  });
});
