import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { lastAssistantText } from '../../src/brain/conversationRead.js';

/** The plugin-facing "what did the agent last say" read (PluginHostStores.conversationsRead). Pinned here
 *  rather than in a plugin: the ownership check and the choice of WHICH assistant row is the reply are
 *  core decisions, and a plugin only ever sees the answer. */
describe('lastAssistantText', () => {
  let store: BrainStore;
  beforeEach(() => { store = new BrainStore(openDb(':memory:')); });

  const assistant = (id: string, content: unknown) =>
    store.appendMessage({ id, sessionId: 's1', parentId: null, role: 'assistant', content: { role: 'assistant', content } });

  it('returns the newest assistant row that carries display text, skipping tool-call-only steps', () => {
    store.createSession({ id: 's1', userId: 7, model: 'm' });
    assistant('a1', [{ type: 'text', text: 'first reply' }]);
    assistant('a2', [{ type: 'text', text: '<thinking>secret</thinking>final **reply**' }]);
    assistant('a3', [{ type: 'toolCall', id: 'c1', name: 'Read', arguments: {} }]);
    expect(lastAssistantText(store, 's1', 7)?.text).toBe('final **reply**');
  });

  it('answers only the owner of the conversation, and null for an unknown one', () => {
    store.createSession({ id: 's1', userId: 7, model: 'm' });
    assistant('a1', [{ type: 'text', text: 'private' }]);
    expect(lastAssistantText(store, 's1', 8)).toBeNull();
    expect(lastAssistantText(store, 'nope', 7)).toBeNull();
    expect(lastAssistantText(store, 's1', 7)?.text).toBe('private');
  });

  it('ignores the provisional crash-recovery mirror of a reply still streaming', () => {
    store.createSession({ id: 's1', userId: 7, model: 'm' });
    assistant('a1', [{ type: 'text', text: 'settled' }]);
    store.appendPendingMessage({ id: 'a2', sessionId: 's1', role: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: 'half-written' }] } });
    expect(lastAssistantText(store, 's1', 7)?.text).toBe('settled');
  });

  it('is null when nothing has been said yet', () => {
    store.createSession({ id: 's1', userId: 7, model: 'm' });
    expect(lastAssistantText(store, 's1', 7)).toBeNull();
  });
});
