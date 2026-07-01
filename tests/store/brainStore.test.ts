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
});
