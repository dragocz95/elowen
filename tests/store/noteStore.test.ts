import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import type { Db } from '../../src/store/db.js';
import { NoteStore } from '../../src/store/noteStore.js';

let db: Db;
let notes: NoteStore;
beforeEach(() => { db = openDb(':memory:'); notes = new NoteStore(db); });

describe('NoteStore', () => {
  it('adds a note and lists it back for its scope/target', () => {
    const n = notes.add({ scope: 'mission', target: 'orca-1', author: 'Iris', body: 'set up X' });
    expect(n.id).toBeGreaterThan(0);
    expect(notes.list('mission', 'orca-1')).toMatchObject([{ target: 'orca-1', author: 'Iris', body: 'set up X' }]);
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
});
