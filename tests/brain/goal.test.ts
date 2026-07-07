import { describe, it, expect } from 'vitest';
import { judgeGoalCompletion, judgeGoalBlocked, parseSubgoalDone, applySubgoalDone, allSubgoalsDone, parseProgress, goalPrompt, goalContinuePrompt } from '../../src/brain/goal.js';
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

  it('tolerates markdown wrapping the sentinel (backticks / bold) and strips it from the evidence', () => {
    const backtick = judgeGoalCompletion('`GOAL_DONE: all tests pass`');
    expect(backtick.done).toBe(true);
    expect(backtick.evidence).toBe('all tests pass');
    const bold = judgeGoalCompletion('**GOAL_DONE: build is green**');
    expect(bold.done).toBe(true);
    expect(bold.evidence).toBe('build is green');
  });
});

describe('judgeGoalBlocked — explicit GOAL_BLOCKED sentinel', () => {
  it('marks blocked with a reason, tolerating markdown', () => {
    expect(judgeGoalBlocked('Tried everything.\nGOAL_BLOCKED: missing DB credentials')).toEqual({ blocked: true, reason: 'missing DB credentials' });
    expect(judgeGoalBlocked('`GOAL_BLOCKED: needs a human decision`').blocked).toBe(true);
  });
  it('rejects an empty/placeholder reason and prose mentions', () => {
    expect(judgeGoalBlocked('GOAL_BLOCKED:').blocked).toBe(false);
    expect(judgeGoalBlocked('GOAL_BLOCKED: <reason>').blocked).toBe(false);
    expect(judgeGoalBlocked('I am not blocked, continuing.').blocked).toBe(false);
  });
  it('rejects a line-start echo of the instruction (placeholder + trailing prose)', () => {
    // A model recapping the protocol on its own line must NOT pause a healthy goal.
    expect(judgeGoalBlocked('`GOAL_BLOCKED: <reason>` — I will use this if I get stuck.').blocked).toBe(false);
    expect(judgeGoalCompletion('GOAL_DONE: <evidence> when finished, per the rules.').done).toBe(false);
  });
});

describe('sentinels ignore fenced code blocks', () => {
  it('a GOAL_DONE inside ``` … ``` does not complete the goal', () => {
    expect(judgeGoalCompletion('Here is the protocol:\n```\nGOAL_DONE: all tests pass\n```\nStill working on it.').done).toBe(false);
    expect(parseSubgoalDone('```\nSUBGOAL_DONE: 1\n```').length).toBe(0);
  });
  it('an UNCLOSED opening fence swallows the rest (truncated turn is still example code)', () => {
    expect(judgeGoalCompletion('Protocol example:\n```\nGOAL_DONE: all tests pass').done).toBe(false);
  });
  it('a bullet-list recap of the protocol does not trip the sentinel', () => {
    expect(judgeGoalCompletion('* GOAL_DONE: emitted only when everything is finished').done).toBe(false);
    expect(judgeGoalBlocked('* GOAL_BLOCKED: used when stuck').blocked).toBe(false);
    // directly-attached markdown still tolerated
    expect(judgeGoalCompletion('**GOAL_DONE: build green**').done).toBe(true);
  });
});

describe('subgoal check-off protocol', () => {
  it('parses SUBGOAL_DONE indices (multiple, deduped, markdown-tolerant)', () => {
    expect(parseSubgoalDone('SUBGOAL_DONE: 1\nwork\nSUBGOAL_DONE: 3\n`SUBGOAL_DONE: 1`')).toEqual([1, 3]);
    expect(parseSubgoalDone('no markers here')).toEqual([]);
  });
  it('applies check-offs and reports whether all are done', () => {
    const subs = [{ text: 'a', done: false }, { text: 'b', done: false }];
    const after = applySubgoalDone(subs, [1]);
    expect(after[0]!.done).toBe(true);
    expect(after[1]!.done).toBe(false);
    expect(allSubgoalsDone(after)).toBe(false);
    expect(allSubgoalsDone(applySubgoalDone(subs, [1, 2]))).toBe(true);
    expect(allSubgoalsDone([])).toBe(true); // vacuous
  });
});

describe('parseProgress — durable per-turn progress line', () => {
  it('extracts the PROGRESS summary and rejects the placeholder', () => {
    expect(parseProgress('did stuff\nPROGRESS: wired the API and added a test')).toBe('wired the API and added a test');
    expect(parseProgress('PROGRESS: <what you accomplished this turn>')).toBe(''); // the actual prompt placeholder
    expect(parseProgress('no progress line')).toBe('');
  });
  it('takes the LAST PROGRESS line when a turn writes more than one', () => {
    expect(parseProgress('PROGRESS: started the refactor\nmore work\nPROGRESS: finished and tests pass')).toBe('finished and tests pass');
  });
});

describe('goal prompts advertise the sentinels', () => {
  it('kickoff and continuation both teach GOAL_DONE / GOAL_BLOCKED / SUBGOAL_DONE / PROGRESS', () => {
    for (const p of [goalPrompt(row()), goalContinuePrompt(row())]) {
      expect(p).toContain('GOAL_DONE:');
      expect(p).toContain('GOAL_BLOCKED:');
      expect(p).toContain('SUBGOAL_DONE:');
      expect(p).toContain('PROGRESS:');
    }
  });
  it('the continuation prompt injects durable progress so it survives compaction/resume', () => {
    expect(goalContinuePrompt(row({ last_evidence: 'migrated 3 of 5 tables' }))).toContain('Progress so far: migrated 3 of 5 tables');
    expect(goalContinuePrompt(row({ last_evidence: '' }))).not.toContain('Progress so far');
  });
  it('tells the model when its GOAL_DONE was rejected for open subgoals (done_pending_subgoals)', () => {
    expect(goalContinuePrompt(row({ last_verdict: 'done_pending_subgoals' }))).toMatch(/GOAL_DONE was NOT accepted/);
    expect(goalContinuePrompt(row({ last_verdict: 'continue' }))).not.toMatch(/was NOT accepted/);
  });
});
