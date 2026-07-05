import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';

describe('BrainStore', () => {
  let store: BrainStore;
  beforeEach(() => { store = new BrainStore(openDb(':memory:')); });

  it('creates and reads back a session', () => {
    const s = store.createSession({ id: 's1', userId: 7, model: 'anthropic/claude' });
    expect(s.user_id).toBe(7);
    expect(store.getSession('s1')?.model).toBe('anthropic/claude');
  });

  it('appends messages and returns them in order', () => {
    store.createSession({ id: 's1', userId: 7, model: 'm' });
    store.appendMessage({ id: 'm1', sessionId: 's1', parentId: null, role: 'user', content: { text: 'hi' } });
    store.appendMessage({ id: 'm2', sessionId: 's1', parentId: 'm1', role: 'assistant', content: { text: 'yo' } });
    const msgs = store.getMessages('s1');
    expect(msgs.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(JSON.parse(msgs[0]!.content)).toEqual({ text: 'hi' });
  });

  it('scopes sessions per user', () => {
    store.createSession({ id: 'a', userId: 1, model: 'm' });
    store.createSession({ id: 'b', userId: 2, model: 'm' });
    expect(store.listSessions(1).map((s) => s.id)).toEqual(['a']);
  });

  it('touchSession updates the model when provided', () => {
    store.createSession({ id: 'a', userId: 1, model: 'm1' });
    store.touchSession('a', 'm2');
    expect(store.getSession('a')?.model).toBe('m2');
  });

  it('removeForUser drops the user rows and their messages', () => {
    store.createSession({ id: 'a', userId: 1, model: 'm' });
    store.appendMessage({ id: 'x', sessionId: 'a', parentId: null, role: 'user', content: {} });
    store.removeForUser(1);
    expect(store.getSession('a')).toBeUndefined();
    expect(store.getMessages('a')).toHaveLength(0);
  });

  describe('searchMessages', () => {
    const userMsg = (id: string, sessionId: string, text: string) =>
      store.appendMessage({ id, sessionId, parentId: null, role: 'user', content: { role: 'user', content: text } });

    it('finds matches only in the caller\'s own sessions', () => {
      store.createSession({ id: 'mine', userId: 1, title: 'Mine', model: 'm' });
      store.createSession({ id: 'theirs', userId: 2, title: 'Theirs', model: 'm' });
      userMsg('m1', 'mine', 'deploy the daemon tonight');
      userMsg('m2', 'theirs', 'deploy the daemon tonight');
      const hits = store.searchMessages(1, 'daemon');
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ sessionId: 'mine', sessionTitle: 'Mine', role: 'user' });
    });

    it('is case-insensitive over the user own chat sessions', () => {
      store.createSession({ id: 'mine2', userId: 1, title: 'Ops', model: 'm' });
      userMsg('m1', 'mine2', 'Restart NGINX please');
      expect(store.searchMessages(1, 'nginx')[0]?.sessionId).toBe('mine2');
    });

    it('excludes shared channel and ephemeral subagent sessions (personal chat search only)', () => {
      store.createSession({ id: 'brain-ch-42', userId: 1, title: 'Discord', model: 'm' });
      store.createSession({ id: 'brain-task-9', userId: 1, title: 'Subagent', model: 'm' });
      userMsg('c1', 'brain-ch-42', 'Restart NGINX please');
      userMsg('t1', 'brain-task-9', 'Restart NGINX please');
      expect(store.searchMessages(1, 'nginx')).toHaveLength(0);
    });

    it('treats LIKE wildcards as literals', () => {
      store.createSession({ id: 's', userId: 1, model: 'm' });
      userMsg('m1', 's', 'coverage is 100% done');
      userMsg('m2', 's', 'coverage is 100x done');
      userMsg('m3', 's', 'abc alphabet');
      expect(store.searchMessages(1, '100%')).toHaveLength(1);
      expect(store.searchMessages(1, '100%')[0]?.snippet).toContain('100% done');
      expect(store.searchMessages(1, 'a_c')).toHaveLength(0); // '_' must not act as a single-char wildcard ('abc')
    });

    it('never matches JSON structure, only display text', () => {
      store.createSession({ id: 's', userId: 1, model: 'm' });
      userMsg('m1', 's', 'plain words');
      expect(store.searchMessages(1, 'role')).toHaveLength(0); // every row's JSON carries "role"
    });

    it('returns [] for queries shorter than 2 chars', () => {
      store.createSession({ id: 's', userId: 1, model: 'm' });
      userMsg('m1', 's', 'x marks the spot');
      expect(store.searchMessages(1, 'x')).toHaveLength(0);
      expect(store.searchMessages(1, '  ')).toHaveLength(0);
    });

    it('clips the snippet to ±60 chars around the match with ellipses', () => {
      store.createSession({ id: 's', userId: 1, model: 'm' });
      userMsg('m1', 's', `${'a'.repeat(100)} needle ${'b'.repeat(100)}`);
      const [hit] = store.searchMessages(1, 'needle');
      expect(hit?.snippet.startsWith('…')).toBe(true);
      expect(hit?.snippet.endsWith('…')).toBe(true);
      expect(hit?.snippet).toContain('needle');
      expect(hit!.snippet.length).toBeLessThanOrEqual(2 + 'needle'.length + 120 + 2); // pads + match + 2×radius + ellipses
    });

    it('respects the limit, newest first', () => {
      store.createSession({ id: 's', userId: 1, model: 'm' });
      for (let i = 0; i < 5; i++) userMsg(`m${i}`, 's', `needle ${i}`);
      expect(store.searchMessages(1, 'needle', 3).map((h) => h.snippet)).toEqual(['needle 4', 'needle 3', 'needle 2']);
    });
  });

  describe('userStats', () => {
    it('counts a user\'s sessions and picks the model used in the most of them', () => {
      store.createSession({ id: 'a', userId: 1, model: 'anthropic/opus' });
      store.createSession({ id: 'b', userId: 1, model: 'anthropic/opus' });
      store.createSession({ id: 'c', userId: 1, model: 'relay/kimi' });
      store.createSession({ id: 'd', userId: 2, model: 'other/model' }); // another user — excluded
      const stats = store.userStats(1);
      expect(stats.sessionCount).toBe(3);
      expect(stats.topModel).toBe('anthropic/opus');
    });

    it('returns a zero count and null top model for a user with no sessions', () => {
      expect(store.userStats(99)).toEqual({ sessionCount: 0, topModel: null });
    });

    it('ignores sessions with an empty model when choosing the top model', () => {
      store.createSession({ id: 'a', userId: 5, model: '' });
      store.createSession({ id: 'b', userId: 5, model: 'relay/glm' });
      const stats = store.userStats(5);
      expect(stats.sessionCount).toBe(2); // both counted
      expect(stats.topModel).toBe('relay/glm'); // but the blank-model one isn't the "top"
    });
  });
});
