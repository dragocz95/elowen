import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../../src/store/db.js';
import type { Db } from '../../../../src/store/db.js';
import { NoteStore } from '../../../../plugins/agents/src/store/noteStore.js';

let db: Db;
let notes: NoteStore;
beforeEach(() => { db = openDb(':memory:'); notes = new NoteStore(db); });

describe('NoteStore', () => {
  it('adds a note and lists it back for its scope/target', () => {
    const n = notes.add({ scope: 'mission', target: 'elowen-1', author: 'Iris', body: 'set up X' });
    expect(n.id).toBeGreaterThan(0);
    expect(notes.list('mission', 'elowen-1')).toMatchObject([{ target: 'elowen-1', author: 'Iris', body: 'set up X' }]);
  });

  it('lists notes oldest-first (chronological handoff log)', () => {
    notes.add({ scope: 'mission', target: 'e', body: 'first' });
    notes.add({ scope: 'mission', target: 'e', body: 'second' });
    expect(notes.list('mission', 'e').map((n) => n.body)).toEqual(['first', 'second']);
  });

  it('isolates by scope+target', () => {
    notes.add({ scope: 'mission', target: 'a', body: 'for-a' });
    notes.add({ scope: 'mission', target: 'b', body: 'for-b' });
    expect(notes.list('mission', 'a').map((n) => n.body)).toEqual(['for-a']);
    expect(notes.list('project', 'a')).toEqual([]);
  });

  it('deleteForTarget removes only that target', () => {
    notes.add({ scope: 'mission', target: 'a', body: 'x' });
    notes.add({ scope: 'mission', target: 'b', body: 'y' });
    notes.deleteForTarget('mission', 'a');
    expect(notes.list('mission', 'a')).toEqual([]);
    expect(notes.list('mission', 'b').map((n) => n.body)).toEqual(['y']);
  });

  it('count reports how many notes a scope/target holds', () => {
    notes.add({ scope: 'mission', target: 'a', body: '1' });
    notes.add({ scope: 'mission', target: 'a', body: '2' });
    expect(notes.count('mission', 'a')).toBe(2);
    expect(notes.count('mission', 'b')).toBe(0);
  });

  it('deleteAllForTarget purges every scope for a target', () => {
    notes.add({ scope: 'mission', target: 'a', body: 'm' });
    notes.add({ scope: 'custom', target: 'a', body: 'c' });
    notes.add({ scope: 'mission', target: 'b', body: 'keep' });
    notes.deleteAllForTarget('a');
    expect(notes.list('mission', 'a')).toEqual([]);
    expect(notes.list('custom', 'a')).toEqual([]); // not just the default scope
    expect(notes.list('mission', 'b').map((n) => n.body)).toEqual(['keep']); // other targets untouched
  });
});
