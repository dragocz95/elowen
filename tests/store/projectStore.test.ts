import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectStore } from '../../src/store/projectStore.js';
import { MemoryCategoryStore } from '../../src/store/memoryCategoryStore.js';
import { MemoryStore } from '../../src/store/memoryStore.js';
import { openDb } from '../../src/store/db.js';

let store: ProjectStore;
beforeEach(() => { store = new ProjectStore(openDb(':memory:')); });

describe('ProjectStore', () => {
  it('creates, lists and gets projects with notes', () => {
    const p = store.create({ slug: 'web', path: '/var/www/web', notes: 'the frontend' });
    expect(p.id).toBeGreaterThan(0);
    expect(p.notes).toBe('the frontend');
    expect(store.get(p.id)?.slug).toBe('web');
    expect(store.list().map((x) => x.slug)).toContain('web');
  });
  it('defaults notes to empty and rejects duplicate slug', () => {
    const p = store.create({ slug: 'a', path: '/a' });
    expect(p.notes).toBe('');
    expect(() => store.create({ slug: 'a', path: '/b' })).toThrow();
  });
  it('defaults icon to empty and round-trips an icon update without clobbering other fields', () => {
    const p = store.create({ slug: 'web', path: '/p', notes: 'keep' });
    expect(p.icon).toBe('');
    store.update(p.id, { icon: 'assets/logo.png' });
    expect(store.get(p.id)).toMatchObject({ path: '/p', notes: 'keep', icon: 'assets/logo.png' });
    store.update(p.id, { icon: '' }); // clear back to the default glyph
    expect(store.get(p.id)?.icon).toBe('');
  });
  it('updates path and notes, leaving the slug immutable', () => {
    const p = store.create({ slug: 'web', path: '/old', notes: 'old' });
    const up = store.update(p.id, { path: '/new', notes: 'new' });
    expect(up).toMatchObject({ id: p.id, slug: 'web', path: '/new', notes: 'new' });
    expect(store.get(p.id)?.path).toBe('/new');
  });
  it('applies a partial update without clobbering other fields', () => {
    const p = store.create({ slug: 'web', path: '/p', notes: 'keep' });
    store.update(p.id, { notes: 'changed' });
    expect(store.get(p.id)).toMatchObject({ path: '/p', notes: 'changed' });
    store.update(p.id, { path: '/q' });
    expect(store.get(p.id)).toMatchObject({ path: '/q', notes: 'changed' });
  });
  it('returns null when updating a missing project', () => {
    expect(store.update(999, { notes: 'x' })).toBeNull();
  });
  it('returns false when removing a missing project', () => {
    expect(store.remove(999)).toBe(false);
  });
});

describe('ProjectStore.remove (cascade)', () => {
  it('deletes project-bound categories and clears their memories fail-closed', () => {
    const db = openDb(':memory:');
    const projects = new ProjectStore(db);
    const categories = new MemoryCategoryStore(db);
    const memories = new MemoryStore(db);
    db.prepare("INSERT INTO users (id,username,password_hash) VALUES (1,'u','h')").run();
    const doomed = projects.create({ slug: 'doomed', path: '/d' });
    const keep = projects.create({ slug: 'keep', path: '/k' });
    const doomedCategory = categories.create(1, { name: 'Doomed', projectId: doomed.id });
    const keepCategory = categories.create(1, { name: 'Keep', projectId: keep.id });
    const memory = memories.add(1, { body: 'project detail' }, 'agent', '');
    memories.setCategory(1, memory.id, doomedCategory.id, 'user:1', 'tag');

    expect(projects.remove(doomed.id)).toBe(true);

    expect(categories.get(1, doomedCategory.id)).toBeUndefined();
    expect(categories.get(1, keepCategory.id)?.projectId).toBe(keep.id);
    expect(memories.get(1, memory.id)?.category_id).toBeNull();
  });
});
