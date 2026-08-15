import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { MemoryCategoryStore } from '../../src/store/memoryCategoryStore.js';
import { MemoryStore } from '../../src/store/memoryStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { RefMissions, RefTaskStore } from '../helpers/refStores.js';

let store: ProjectStore;
beforeEach(() => { store = new ProjectStore(openPluginTablesDb(':memory:')); });

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
  it('defaults pr_enabled to null (inherit) and round-trips the tri-state override', () => {
    const p = store.create({ slug: 'web', path: '/p' });
    expect(p.pr_enabled).toBeNull(); // inherit the global default by default
    expect(store.update(p.id, { pr_enabled: true })?.pr_enabled).toBe(true);
    expect(store.update(p.id, { pr_enabled: false })?.pr_enabled).toBe(false);
    expect(store.update(p.id, { pr_enabled: null })?.pr_enabled).toBeNull();
    // an unrelated update must not clobber the override
    store.update(p.id, { pr_enabled: true });
    expect(store.update(p.id, { notes: 'x' })?.pr_enabled).toBe(true);
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
    const db = openPluginTablesDb(':memory:');
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

  it('detaches the project and everything scoped to it, leaving siblings untouched', () => {
    const db = openPluginTablesDb(':memory:');
    const projects = new ProjectStore(db);
    const tasks = new RefTaskStore(db);
    const missions = new RefMissions(db);
    const up = new UserProjectStore(db);
    db.prepare("INSERT INTO users (id,username,password_hash) VALUES (1,'u','h')").run();

    const doomed = projects.create({ slug: 'doomed', path: '/d' });
    const keep = projects.create({ slug: 'keep', path: '/k' });

    const epic = tasks.create({ id: 'd-epic', project_id: doomed.id, title: 'E', type: 'epic' });
    const child = tasks.create({ id: 'd-child', project_id: doomed.id, title: 'C' });
    tasks.addDep(child.id, epic.id);
    missions.create({ id: 'm1', epic_id: epic.id, autonomy: 'L3', max_sessions: 1 });
    // A plugin-owned row keyed on the project. Written as SQL against the frozen plugin DDL
    // (tests/fixtures/pluginSchema.ts) rather than through the plugin's own store: the cascade is
    // core's (store/cascade.ts) and must clear plugin tables whether or not their owner is installed.
    db.prepare("INSERT INTO agents (project_id,name,program,model) VALUES (?,'Nova','claude-code','sonnet')").run(doomed.id);
    up.assign(1, doomed.id);

    const keepTask = tasks.create({ id: 'k-task', project_id: keep.id, title: 'K' });

    expect(projects.remove(doomed.id)).toBe(true);

    expect(projects.get(doomed.id)).toBeNull();
    expect(projects.get(keep.id)).not.toBeNull();
    expect(tasks.get('d-epic')).toBeNull();
    expect(tasks.get('d-child')).toBeNull();
    expect(tasks.depsFor('d-child')).toEqual([]);
    expect(missions.get('m1')).toBeNull();
    expect(up.forUser(1)).not.toContain(doomed.id);
    expect(db.prepare('SELECT COUNT(*) c FROM agents WHERE project_id = ?').get(doomed.id)).toEqual({ c: 0 });
    expect(tasks.get(keepTask.id)).not.toBeNull(); // sibling project's data survives
  });
});
