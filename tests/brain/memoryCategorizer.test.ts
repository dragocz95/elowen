import { describe, it, expect, vi } from 'vitest';
import { MemoryCategorizer } from '../../src/brain/memoryCategorizer.js';
import type { MemoryCategoryStore, MemoryCategoryRow } from '../../src/store/memoryCategoryStore.js';
import type { MemoryStore } from '../../src/store/memoryStore.js';
import type { InferenceClient } from '../../src/inference/types.js';

function cat(id: number, name: string, description = ''): MemoryCategoryRow {
  return { id, user_id: 1, name, description, color: '', is_builtin: 0, created_at: '2026-01-01' };
}

/** Fake category store exposing only `list` (the classify path's sole dependency). */
function fakeCategories(cats: MemoryCategoryRow[]): MemoryCategoryStore {
  return { list: () => cats } as unknown as MemoryCategoryStore;
}

/** Fake inference client whose decide() always returns `reply`. */
function fakeInference(reply: string): InferenceClient {
  return { decide: vi.fn(async () => ({ text: reply })) };
}

const memories = {} as unknown as MemoryStore;

function build(cats: MemoryCategoryRow[], inference: () => InferenceClient | null) {
  return new MemoryCategorizer({ categories: fakeCategories(cats), memories, inference });
}

const CATS = [cat(10, 'Infrastruktura', 'cesty, porty, endpointy'), cat(20, 'Preference', 'pracovní styl')];

describe('MemoryCategorizer.classify', () => {
  it('exact-match reply resolves to that category id', async () => {
    const c = build(CATS, () => fakeInference('Infrastruktura'));
    expect(await c.classify(1, 'daemon běží na portu 4400')).toBe(10);
  });

  it('coerces case + surrounding prose to a whole-token match', async () => {
    const c = build(CATS, () => fakeInference('Kategorie: "preference".'));
    expect(await c.classify(1, 'preferuje tmavý režim')).toBe(20);
  });

  it('unknown category name → null (never invents)', async () => {
    const c = build(CATS, () => fakeInference('Sport'));
    expect(await c.classify(1, 'něco')).toBeNull();
  });

  it('explicit "none" reply → null', async () => {
    const c = build(CATS, () => fakeInference('none'));
    expect(await c.classify(1, 'ahoj')).toBeNull();
  });

  it('no categories → null without calling the model', async () => {
    const inf = fakeInference('Infrastruktura');
    const c = build([], () => inf);
    expect(await c.classify(1, 'cokoliv')).toBeNull();
    expect(inf.decide).not.toHaveBeenCalled();
  });

  it('no model wired (inference() → null) → null', async () => {
    const c = build(CATS, () => null);
    expect(await c.classify(1, 'daemon na portu 4400')).toBeNull();
  });

  it('configured() reflects whether inference() resolves', () => {
    expect(build(CATS, () => fakeInference('x')).configured()).toBe(true);
    expect(build(CATS, () => null).configured()).toBe(false);
  });
});
