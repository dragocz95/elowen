import { describe, it, expect } from 'vitest';
import { normalizeCard, isEmptyCard, CardRegistry } from '../../src/brain/cards.js';

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
