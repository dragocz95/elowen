import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import type { Db } from '../../src/store/db.js';
import { MemoryCategoryStore } from '../../src/store/memoryCategoryStore.js';
import { MemoryStore } from '../../src/store/memoryStore.js';

describe('MemoryCategoryStore', () => {
  let db: Db;
  let cats: MemoryCategoryStore;
  let mem: MemoryStore;
  beforeEach(() => {
    db = openDb(':memory:');
    cats = new MemoryCategoryStore(db);
    mem = new MemoryStore(db);
  });

  it('create returns the full row with defaults and is_builtin flag', () => {
    const c = cats.create(1, { name: 'Práce' });
    expect(c).toMatchObject({ user_id: 1, name: 'Práce', description: '', color: '', is_builtin: 0 });
    expect(typeof c.id).toBe('number');

    const b = cats.create(1, { name: 'Systém', description: 'infra', color: '#f00', isBuiltin: true });
    expect(b).toMatchObject({ name: 'Systém', description: 'infra', color: '#f00', is_builtin: 1 });
  });

  it('list is user-scoped and name-sorted case-insensitively', () => {
    cats.create(1, { name: 'zebra' });
    cats.create(1, { name: 'Alpha' });
    cats.create(1, { name: 'mid' });
    cats.create(2, { name: "other user's" });

    expect(cats.list(1).map((c) => c.name)).toEqual(['Alpha', 'mid', 'zebra']);
    expect(cats.list(2).map((c) => c.name)).toEqual(["other user's"]);
  });

  it('get is owner-scoped', () => {
    const c = cats.create(1, { name: 'Práce' });
    expect(cats.get(1, c.id)?.name).toBe('Práce');
    expect(cats.get(2, c.id)).toBeUndefined();
  });

  it('create throws SQLITE_CONSTRAINT_UNIQUE on a duplicate name per user', () => {
    cats.create(1, { name: 'dup' });
    try {
      cats.create(1, { name: 'dup' });
      throw new Error('expected a UNIQUE violation');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('SQLITE_CONSTRAINT_UNIQUE');
    }
    // Same name for a different user is fine (per-user unique).
    expect(cats.create(2, { name: 'dup' })).toMatchObject({ user_id: 2, name: 'dup' });
  });

  it('update patches only provided fields and is owner-scoped', () => {
    const c = cats.create(1, { name: 'Práce', description: 'old', color: '#000' });
    const updated = cats.update(1, c.id, { description: 'new' })!;
    expect(updated).toMatchObject({ name: 'Práce', description: 'new', color: '#000' });

    // A foreign user can't update.
    expect(cats.update(2, c.id, { name: 'hacked' })).toBeUndefined();
    expect(cats.get(1, c.id)?.name).toBe('Práce');
    // Missing category → undefined.
    expect(cats.update(1, 9999, { name: 'x' })).toBeUndefined();
  });

  it('update to a colliding name throws UNIQUE', () => {
    cats.create(1, { name: 'a' });
    const b = cats.create(1, { name: 'b' });
    try {
      cats.update(1, b.id, { name: 'a' });
      throw new Error('expected a UNIQUE violation');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('SQLITE_CONSTRAINT_UNIQUE');
    }
  });

  it('delete removes the category and nulls referencing memories (reassign-on-delete)', () => {
    const c = cats.create(1, { name: 'Práce' });
    const m1 = mem.add(1, { body: 'a' }, 'agent', '');
    const m2 = mem.add(1, { body: 'b' }, 'agent', '');
    mem.setCategory(1, m1.id, c.id, 'user:1', 'tag');
    mem.setCategory(1, m2.id, c.id, 'user:1', 'tag');
    expect(mem.get(1, m1.id)?.category_id).toBe(c.id);

    expect(cats.delete(1, c.id)).toBe(true);
    expect(cats.get(1, c.id)).toBeUndefined();
    // Referencing memories were cleared, not deleted.
    expect(mem.get(1, m1.id)?.category_id).toBeNull();
    expect(mem.get(1, m2.id)?.category_id).toBeNull();

    // Idempotent-ish: deleting again returns false.
    expect(cats.delete(1, c.id)).toBe(false);
  });

  it('delete is owner-scoped: a foreign user cannot delete', () => {
    const c = cats.create(1, { name: 'Práce' });
    expect(cats.delete(2, c.id)).toBe(false);
    expect(cats.get(1, c.id)).toBeDefined();
  });

  it('removeForUser wipes only that user\'s categories', () => {
    cats.create(1, { name: 'a' });
    cats.create(1, { name: 'b' });
    cats.create(2, { name: 'keep' });
    cats.removeForUser(1);
    expect(cats.list(1)).toHaveLength(0);
    expect(cats.list(2).map((c) => c.name)).toEqual(['keep']);
  });
});
