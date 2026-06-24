import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import type { Db } from '../../src/store/db.js';
import { MissionPrStore } from '../../src/store/missionPrStore.js';

let db: Db;
let store: MissionPrStore;
beforeEach(() => { db = openDb(':memory:'); store = new MissionPrStore(db); });

describe('MissionPrStore', () => {
  it('returns null for a mission with no PR record', () => {
    expect(store.get('m-x')).toBeNull();
  });

  it('creates a record with branch + worktree and reads it back', () => {
    const rec = store.create({ mission_id: 'm-1', branch: 'orca/feat-1', worktree: '/tmp/.orca-worktrees/feat-1' });
    expect(rec).toMatchObject({ mission_id: 'm-1', branch: 'orca/feat-1', worktree: '/tmp/.orca-worktrees/feat-1' });
    expect(rec.pr_number).toBeNull();
    expect(rec.pr_url).toBeNull();
    expect(rec.pr_state).toBeNull();
    expect(rec.last_review_ts).toBeNull();
    expect(store.get('m-1')).toEqual(rec);
  });

  it('is idempotent on create — re-engaging an epic keeps the branch/worktree', () => {
    store.create({ mission_id: 'm-1', branch: 'orca/feat-1', worktree: '/wt/a' });
    const again = store.create({ mission_id: 'm-1', branch: 'orca/feat-2', worktree: '/wt/b' });
    // The original branch/worktree win — a live worktree must not be silently rebound.
    expect(again.branch).toBe('orca/feat-1');
    expect(again.worktree).toBe('/wt/a');
  });

  it('records the opened PR (number, url, state)', () => {
    store.create({ mission_id: 'm-1', branch: 'orca/feat-1', worktree: '/wt/a' });
    const rec = store.setPr('m-1', { number: 42, url: 'https://github.com/o/r/pull/42', state: 'open' });
    expect(rec?.pr_number).toBe(42);
    expect(rec?.pr_url).toBe('https://github.com/o/r/pull/42');
    expect(rec?.pr_state).toBe('open');
  });

  it('updates the PR state without touching the number/url', () => {
    store.create({ mission_id: 'm-1', branch: 'orca/feat-1', worktree: '/wt/a' });
    store.setPr('m-1', { number: 7, url: 'https://github.com/o/r/pull/7', state: 'open' });
    const rec = store.setPrState('m-1', 'merged');
    expect(rec?.pr_state).toBe('merged');
    expect(rec?.pr_number).toBe(7);
    expect(rec?.pr_url).toBe('https://github.com/o/r/pull/7');
  });

  it('stamps the last-review timestamp for feedback dedup', () => {
    store.create({ mission_id: 'm-1', branch: 'orca/feat-1', worktree: '/wt/a' });
    const rec = store.setLastReviewTs('m-1', '2026-06-24T10:00:00Z');
    expect(rec?.last_review_ts).toBe('2026-06-24T10:00:00Z');
  });

  it('starts fix_rounds at 0, bumps it (returns the new count) and resets it', () => {
    store.create({ mission_id: 'm-1', branch: 'orca/feat-1', worktree: '/wt/a' });
    expect(store.get('m-1')?.fix_rounds).toBe(0);
    expect(store.bumpFixRounds('m-1')).toBe(1);
    expect(store.bumpFixRounds('m-1')).toBe(2);
    expect(store.get('m-1')?.fix_rounds).toBe(2);
    store.resetFixRounds('m-1');
    expect(store.get('m-1')?.fix_rounds).toBe(0);
  });

  it('records the PR-review feedback and clears it on reset', () => {
    store.create({ mission_id: 'm-1', branch: 'orca/feat-1', worktree: '/wt/a' });
    expect(store.get('m-1')?.last_feedback).toBeNull();
    store.setLastFeedback('m-1', '- codex: fix the cap bug');
    expect(store.get('m-1')?.last_feedback).toBe('- codex: fix the cap bug');
    store.resetFixRounds('m-1'); // merge/close clears the fix context too
    expect(store.get('m-1')?.last_feedback).toBeNull();
  });

  it('removes a record on cleanup', () => {
    store.create({ mission_id: 'm-1', branch: 'orca/feat-1', worktree: '/wt/a' });
    store.remove('m-1');
    expect(store.get('m-1')).toBeNull();
  });

  it('lists records that have an open PR (for the feedback poller)', () => {
    store.create({ mission_id: 'm-1', branch: 'b1', worktree: '/wt/1' });
    store.create({ mission_id: 'm-2', branch: 'b2', worktree: '/wt/2' });
    store.create({ mission_id: 'm-3', branch: 'b3', worktree: '/wt/3' });
    store.setPr('m-1', { number: 1, url: 'u1', state: 'open' });
    store.setPr('m-2', { number: 2, url: 'u2', state: 'merged' });
    const open = store.withOpenPr().map((r) => r.mission_id).sort();
    expect(open).toEqual(['m-1']);
  });
});
