import { describe, it, expect } from 'vitest';
import { normalizeCard, isEmptyCard, CardRegistry } from '../../src/brain/cards.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';

describe('normalizeCard — untrusted ctx.emitCard payload', () => {
  it('drops junk items, coerces status, keeps text', () => {
    const c = normalizeCard({
      id: 'todos', title: 'Todos',
      items: [
        { text: 'A', status: 'completed' },
        { text: '  ', status: 'pending' }, // empty text dropped
        { text: 'B', status: 'bogus' },    // unknown status → pending
        'nope',                            // non-object dropped
        { text: 'C', status: 'in_progress' },
      ],
    });
    expect(c).not.toBeNull();
    expect(c!.items).toEqual([
      { text: 'A', status: 'completed' },
      { text: 'B', status: 'pending' },
      { text: 'C', status: 'in_progress' },
    ]);
  });

  it('returns null without an id, and flags an empty card', () => {
    expect(normalizeCard({ title: 'x' })).toBeNull();
    expect(normalizeCard('x')).toBeNull();
    expect(isEmptyCard(normalizeCard({ id: 'a' })!)).toBe(true);
    expect(isEmptyCard(normalizeCard({ id: 'a', body: 'hi' })!)).toBe(false);
  });
});

describe('CardRegistry — per-session live cards', () => {
  it('upserts by id and replaces on re-emit', () => {
    const r = new CardRegistry();
    r.set('s1', { id: 'todos', items: [{ text: 'A', status: 'pending' }] });
    r.set('s1', { id: 'todos', items: [{ text: 'A', status: 'completed' }] }); // replace
    r.set('s1', { id: 'other', body: 'hi' });
    const cards = r.forSession('s1');
    expect(cards).toHaveLength(2);
    expect(cards.find((c) => c.id === 'todos')!.items![0].status).toBe('completed');
  });

  it('an empty card removes it; clearSession drops everything', () => {
    const r = new CardRegistry();
    r.set('s1', { id: 'todos', items: [{ text: 'A' }] });
    r.set('s1', { id: 'todos', items: [] }); // empty → remove
    expect(r.forSession('s1')).toEqual([]);
    r.set('s1', { id: 'x', body: 'y' });
    r.clearSession('s1');
    expect(r.forSession('s1')).toEqual([]);
  });

  it('sessions are isolated', () => {
    const r = new CardRegistry();
    r.set('s1', { id: 'a', body: '1' });
    r.set('s2', { id: 'a', body: '2' });
    expect(r.forSession('s1')[0].body).toBe('1');
    expect(r.forSession('s2')[0].body).toBe('2');
  });
});

// Closing the chat disposes the live session, and disposal evicts the card cache. While the cards lived
// only in memory that took the user's todo list with them: reopening the conversation restored the whole
// transcript above an empty panel. Cards are conversation state, so they are stored like one.
describe('CardRegistry — a closed conversation keeps its cards', () => {
  const setup = () => {
    const store = new BrainStore(openDb(':memory:'));
    return { store, registry: new CardRegistry(() => store) };
  };
  const todos = { id: 'todos', title: 'Todos', pinned: true, items: [{ text: 'Ship it', status: 'in_progress' }] };

  it('reopening the conversation the user closed brings the checklist back', () => {
    const { registry } = setup();
    registry.set('s1', todos);
    registry.clearSession('s1'); // the user closed the chat → session disposed
    const back = registry.forSession('s1');
    expect(back).toHaveLength(1);
    expect(back[0].items).toEqual([{ text: 'Ship it', status: 'in_progress' }]);
    expect(back[0].pinned).toBe(true); // still the pinned panel, not a plain card
  });

  it('survives the daemon restarting, which no in-memory registry could', () => {
    const { store, registry } = setup();
    registry.set('s1', todos);
    expect(new CardRegistry(() => store).forSession('s1')).toHaveLength(1);
  });

  it('a cleared panel stays cleared — an emptied card must not resurrect on reopen', () => {
    const { registry } = setup();
    registry.set('s1', todos);
    registry.set('s1', { id: 'todos', items: [] }); // the plugin cleared the panel
    registry.clearSession('s1');
    expect(registry.forSession('s1')).toEqual([]);
  });

  it('deleting the conversation takes its cards with it', () => {
    const { store, registry } = setup();
    registry.set('s1', todos);
    registry.clearSession('s1');
    store.deleteSession('s1'); // BrainService disposes, then deletes — the cascade drops the cards
    expect(registry.forSession('s1')).toEqual([]);
  });

  it('keeps the emit order across a reopen, so the panel does not reshuffle', () => {
    const { store, registry } = setup();
    registry.set('s1', { id: 'first', body: '1' });
    registry.set('s1', { id: 'second', body: '2' });
    registry.set('s1', { id: 'first', body: 'updated' }); // an update must not move it to the end
    registry.clearSession('s1');
    expect(new CardRegistry(() => store).forSession('s1').map((c) => c.id)).toEqual(['first', 'second']);
  });
});
