import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { SearchVectorStore, SEARCH_VECTOR_CACHE_MAX, searchVectorKey } from '../../src/store/searchVectorStore.js';

const vec = (seed: number) => Float32Array.from([seed, seed + 1, seed + 2]);
const store = () => new SearchVectorStore(openDb(':memory:'));

describe('SearchVectorStore', () => {
  it('round-trips a vector under its model, and misses for a different model', () => {
    const s = store();
    s.put('model-a', [{ text: 'Maximum steps', vector: vec(1) }]);

    expect([...s.get('model-a', ['Maximum steps']).get('Maximum steps')!]).toEqual([1, 2, 3]);
    // The model is part of the KEY, so switching it misses rather than returning a vector from another
    // embedding space (which could even be a different width).
    expect(s.get('model-b', ['Maximum steps']).size).toBe(0);
    expect(s.get('model-a', ['Something else']).size).toBe(0);
  });

  it('returns only the texts it has, keyed by the original text', () => {
    const s = store();
    s.put('m', [{ text: 'one', vector: vec(1) }, { text: 'three', vector: vec(3) }]);
    const found = s.get('m', ['one', 'two', 'three']);
    expect([...found.keys()].sort()).toEqual(['one', 'three']);
  });

  it('re-storing a key is a no-op rather than a duplicate row', () => {
    const s = store();
    s.put('m', [{ text: 'one', vector: vec(1) }]);
    s.put('m', [{ text: 'one', vector: vec(1) }]);
    expect(s.count()).toBe(1);
  });

  it('evicts the oldest rows once the cap is passed, keeping the newest', () => {
    const s = store();
    // Fill to exactly the cap in one transaction, then add ten more.
    s.put('m', Array.from({ length: SEARCH_VECTOR_CACHE_MAX }, (_, i) => ({ text: `old-${i}`, vector: vec(i) })));
    expect(s.count()).toBe(SEARCH_VECTOR_CACHE_MAX);

    s.put('m', Array.from({ length: 10 }, (_, i) => ({ text: `new-${i}`, vector: vec(i) })));
    expect(s.count()).toBe(SEARCH_VECTOR_CACHE_MAX);

    // The ten newest survived; the ten oldest are the ones that went.
    const newest = Array.from({ length: 10 }, (_, i) => `new-${i}`);
    expect(s.get('m', newest).size).toBe(10);
    const oldest = Array.from({ length: 10 }, (_, i) => `old-${i}`);
    expect(s.get('m', oldest).size).toBe(0);
    // …and everything between them is untouched.
    expect(s.get('m', ['old-2500']).size).toBe(1);
  });

  it('keys by sha256 of model + NUL + text, so no concatenation can collide', () => {
    // 'a\0b' and 'ab' must not hash alike — the separator is what guarantees it.
    expect(searchVectorKey('a', 'b')).not.toBe(searchVectorKey('ab', ''));
    expect(searchVectorKey('m', 'x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles an empty read and an empty write without touching the database', () => {
    const s = store();
    expect(s.get('m', []).size).toBe(0);
    s.put('m', []);
    expect(s.count()).toBe(0);
  });
});
