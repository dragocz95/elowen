import { describe, it, expect, vi } from 'vitest';
import { MemoryCategorizer } from '../../src/brain/memoryCategorizer.js';
import type { MemoryCategoryStore, MemoryCategoryRow } from '../../src/store/memoryCategoryStore.js';
import type { MemoryStore } from '../../src/store/memoryStore.js';
import type { InferenceClient } from '../../src/inference/types.js';

function cat(id: number, name: string, description = ''): MemoryCategoryRow {
  return { id, user_id: 1, name, description, color: '', icon: 'Folder', is_builtin: 0, projectId: null, created_at: '2026-01-01' };
}

/** Fake category store exposing only `list` (the classify path's sole dependency). */
function fakeCategories(cats: MemoryCategoryRow[]): MemoryCategoryStore {
  return { list: () => cats } as unknown as MemoryCategoryStore;
}

/** Fake inference client whose decide() always returns `reply`. */
function fakeInference(reply: string): InferenceClient {
  return { model: 'fake-model', decide: vi.fn(async () => ({ text: reply })) };
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

describe('MemoryCategorizer.suggestIcon', () => {
  it('coerces a clean model reply to that allowlist icon', async () => {
    const c = build(CATS, () => fakeInference('Server'));
    expect(await c.suggestIcon('Infrastruktura')).toBe('Server');
  });

  it('tolerates surrounding prose / quotes (whole-token match)', async () => {
    const c = build(CATS, () => fakeInference('Icon: "Database".'));
    expect(await c.suggestIcon('Databáze')).toBe('Database');
  });

  it('unknown icon name → fail-soft Folder', async () => {
    const c = build(CATS, () => fakeInference('Sparkles'));
    expect(await c.suggestIcon('Cokoliv')).toBe('Folder');
  });

  it('no model wired → fail-soft Folder without calling the model', async () => {
    const c = build(CATS, () => null);
    expect(await c.suggestIcon('Práce')).toBe('Folder');
  });

  it('a throwing relay → fail-soft Folder (never rejects)', async () => {
    const inf: InferenceClient = { model: 'm', decide: vi.fn(async () => { throw new Error('relay down'); }) };
    const c = build(CATS, () => inf);
    expect(await c.suggestIcon('Práce')).toBe('Folder');
  });

  it('empty name → Folder without hitting the model', async () => {
    const inf = fakeInference('Server');
    const c = build(CATS, () => inf);
    expect(await c.suggestIcon('   ')).toBe('Folder');
    expect(inf.decide).not.toHaveBeenCalled();
  });
});

describe('MemoryCategorizer.classifyMemory', () => {
  /** Fake memory store over a single row, recording guarded category writes and a monotonic audit revision. */
  function fakeMemories(categoryId: number | null) {
    const row = { id: 7, user_id: 1, body: 'daemon běží na portu 4400', status: 'active', category_id: categoryId };
    const writes: { categoryId: number | null; model: string | null }[] = [];
    let revision = 1;
    const store = {
      get: () => ({ ...row }),
      revision: () => revision,
      setCategoryIfUnchanged: (
        _u: number,
        _i: number,
        expected: { categoryId: number | null; revision?: number },
        catId: number | null,
        _a: string,
        _r: string,
        model: string | null,
      ) => {
        if (expected.categoryId !== row.category_id || expected.revision !== revision) return false;
        writes.push({ categoryId: catId, model });
        row.category_id = catId;
        revision += 1;
        return true;
      },
    } as unknown as MemoryStore;
    const manualSet = (next: number | null) => { row.category_id = next; revision += 1; };
    return { store, writes, row, manualSet };
  }

  it('files an uncategorized memory under the model\'s answer, auditing the model that decided', async () => {
    const mem = fakeMemories(null);
    const c = new MemoryCategorizer({
      categories: fakeCategories(CATS), memories: mem.store, inference: () => fakeInference('Infrastruktura'),
    });

    await c.classifyMemory(1, 7, 'test');

    expect(mem.writes).toEqual([{ categoryId: 10, model: 'fake-model' }]);
  });

  // The round-trip takes long enough for the owner to file the memory by hand in the UI meanwhile. The
  // categorizer re-reads before writing, so a deliberate human choice is never replaced by a guess.
  it('abandons the write when the category changed under it during the round-trip', async () => {
    const mem = fakeMemories(null);
    const inference: InferenceClient = {
      model: 'fake-model',
      decide: vi.fn(async () => {
        mem.manualSet(20); // the user picked "Preference" while the model was thinking
        return { text: 'Infrastruktura' };
      }),
    };
    const c = new MemoryCategorizer({
      categories: fakeCategories(CATS), memories: mem.store, inference: () => inference,
    });

    await c.classifyMemory(1, 7, 'test');

    expect(mem.writes).toEqual([]);
    expect(mem.row.category_id).toBe(20);
  });

  it('never rejects into a caller that is not awaiting it', async () => {
    const mem = fakeMemories(null);
    const c = new MemoryCategorizer({
      categories: fakeCategories(CATS), memories: mem.store,
      inference: () => ({ model: 'm', decide: vi.fn(async () => { throw new Error('relay down'); }) }),
    });

    await expect(c.classifyMemory(1, 7, 'test')).resolves.toBeUndefined();
    expect(mem.writes).toEqual([]);
  });
});
