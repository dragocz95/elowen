import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { storedContextMessages } from '../../src/brain/persistence.js';
import { forkSameModel } from '../../src/brain/channels.js';
import { forkCacheVerdict, forkParentPrefixTokens, type ForkMessage } from '../../src/brain/session/forkPrefix.js';

/** What the fork-cache log line is allowed to conclude, and from what.
 *
 *  The line is the only evidence surface the feature has, so a reading it takes from the wrong place does
 *  not merely mislabel a fork — it sends the next reader looking for a bug that is not there.
 *
 *  RED BEFORE THE FIX: a delegated spawn commonly lands in a RUNNER process, where the parent has no live
 *  record at all. Both readings were taken off that record alone, so production fork
 *  `brain-ch-subagent-sub-dlg-292aee42` reported `parentPrefix≈0 verdict=not-shared (different model)`
 *  while parent and child were both running claude-fable-5-1 and the parent had just read back 162130
 *  cached tokens. */
describe('what the fork-cache line reads about the parent', () => {
  describe('same-model comparison', () => {
    const live = { model: 'claude-fable-5-1', providerId: 'anthropic' };
    const row = { model: 'claude-fable-5-1', provider: 'anthropic' };

    it('falls back to the durable row when the parent is not live in this process', () => {
      expect(forkSameModel({ provider: 'anthropic', model: 'claude-fable-5-1' }, undefined, row)).toBe(true);
    });

    it('reported a mismatch that was really an absent live record', () => {
      // The exact production reading: a live record the runner does not hold, and no row consulted.
      expect(forkSameModel({ provider: 'anthropic', model: 'claude-fable-5-1' }, undefined, undefined)).toBe(false);
      expect(forkCacheVerdict({
        childSessionId: 'c', parentSessionId: 'p',
        cacheRead: 18_532, cacheWrite: 112_543, input: 4,
        parentPrefix: 162_130, sameModel: false, providerCaches: true,
      }).reason).toBe('different model');
    });

    it('still separates two providers that expose the same model id', () => {
      expect(forkSameModel({ provider: 'relay', model: 'claude-fable-5-1' }, live, row)).toBe(false);
      expect(forkSameModel({ provider: 'anthropic', model: 'other' }, live, row)).toBe(false);
    });

    it('prefers the live record over the row', () => {
      expect(forkSameModel({ provider: 'anthropic', model: 'claude-fable-5-1' }, live, { model: 'stale', provider: 'stale' })).toBe(true);
    });

    it('treats a model the caller did not name as the parent’s own', () => {
      expect(forkSameModel(undefined, undefined, undefined)).toBe(true);
      expect(forkSameModel({ provider: 'anthropic' }, undefined, undefined)).toBe(true);
    });

    it('compares a legacy row with no provider on the model id alone', () => {
      // An unmeasured provider must not manufacture a mismatch nobody observed.
      expect(forkSameModel({ provider: 'anthropic', model: 'claude-fable-5-1' }, undefined, { model: 'claude-fable-5-1' })).toBe(true);
    });
  });

  describe('the parent’s warm prefix', () => {
    let db: Db;
    let store: BrainStore;

    beforeEach(() => {
      db = openDb(':memory:');
      store = new BrainStore(db);
      store.createSession({ id: 'p', userId: 1, model: 'claude-fable-5-1', provider: 'anthropic' });
      store.appendMessage({ id: 'm1', sessionId: 'p', parentId: null, role: 'user', content: { role: 'user', content: 'ask' } });
      store.appendMessage({
        id: 'm2', sessionId: 'p', parentId: null, role: 'assistant',
        content: {
          role: 'assistant', content: [{ type: 'text', text: 'answer' }],
          usage: { input: 4, output: 401, cacheRead: 161_527, cacheWrite: 603 },
        },
      });
    });

    /** The load-bearing claim of the fallback: the shared reading a fork already seeds from carries the
     *  same `usage` the live messages do, so both sides answer the same question. */
    it('is readable off the durable rows, through the very reading the seed uses', () => {
      const stored = storedContextMessages(store, 'p') as ForkMessage[];
      expect(forkParentPrefixTokens(stored)).toBe(161_531);
    });

    it('stays 0 when the parent has never spoken, so the verdict says unknown instead of guessing', () => {
      store.createSession({ id: 'q', userId: 1, model: 'claude-fable-5-1' });
      expect(forkParentPrefixTokens(storedContextMessages(store, 'q') as ForkMessage[])).toBe(0);
      expect(forkCacheVerdict({
        childSessionId: 'c', parentSessionId: 'q',
        cacheRead: 0, cacheWrite: 10, input: 4, parentPrefix: 0, sameModel: true, providerCaches: true,
      }).reason).toBe('parent prefix unknown');
    });
  });
});
