import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import type { Db } from '../../src/store/db.js';
import { MemoryStore, hashBody } from '../../src/store/memoryStore.js';
import { MemoryCategoryStore } from '../../src/store/memoryCategoryStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { isSharer, canUseCategory } from '../../src/store/sharedMemoryAccess.js';

/** Shared project memory at the STORE level: the pool is a memory_categories row with user_id = 0,
 *  memory rows keep their author, and access flows through isSharer/canUseCategory/getAccessible. */
describe('shared project memory (store)', () => {
  let db: Db;
  let mem: MemoryStore;
  let cats: MemoryCategoryStore;
  let userProjects: UserProjectStore;

  beforeEach(() => {
    db = openDb(':memory:');
    mem = new MemoryStore(db);
    cats = new MemoryCategoryStore(db);
    userProjects = new UserProjectStore(db);
  });

  const shareProject = (slug: string, opts?: { members?: number[]; sharers?: number[] }): { id: number; slug: string } => {
    const project = new ProjectStore(db).create({ slug, path: `/tmp/${slug}` });
    for (const userId of opts?.members ?? []) userProjects.assign(userId, project.id);
    const updated = new ProjectStore(db).update(project.id, { memoryShared: true })!;
    userProjects.setMemoryMembers(project.id, opts?.sharers ?? []);
    return { id: updated.id, slug: updated.slug };
  };

  it('isSharer follows the toggle and the empty-list-means-everyone rule', () => {
    const project = shareProject('obchod', { members: [10, 11], sharers: [10] });
    expect(isSharer(db, 10, project.id)).toBe(true);  // named in the list
    expect(isSharer(db, 11, project.id)).toBe(false); // member, but not named
    expect(isSharer(db, 12, project.id)).toBe(false); // not even a member

    // Empty list → every project member shares.
    userProjects.setMemoryMembers(project.id, []);
    expect(isSharer(db, 11, project.id)).toBe(true);
    expect(isSharer(db, 12, project.id)).toBe(false);

    // Toggle off → nobody shares, list contents irrelevant.
    new ProjectStore(db).update(project.id, { memoryShared: false });
    expect(isSharer(db, 10, project.id)).toBe(false);

    // A missing project is fail-closed.
    expect(isSharer(db, 10, 99999)).toBe(false);
  });

  it('sharedForProject lazily creates ONE pool per project and stays null for non-sharers', () => {
    const project = shareProject('obchod', { members: [10], sharers: [10] });
    expect(cats.sharedForProject(11, project)).toBeNull(); // not a sharer → never see/create the pool

    const pool = cats.sharedForProject(10, project)!;
    expect(pool).toMatchObject({ user_id: 0, projectId: project.id });
    expect(pool.name).toBe('obchod (shared)');
    expect(cats.sharedForProject(10, project)!.id).toBe(pool.id); // idempotent
    // One row per project: the partial unique (user_id, project_id) index holds even under create races.
    expect(() => db.prepare(
      'INSERT INTO memory_categories (user_id, name, project_id) VALUES (0, ?, ?)',
    ).run('other', project.id)).toThrow(/UNIQUE constraint failed/);
  });

  it('listShared returns only pools of projects the user shares', () => {
    const a = shareProject('a', { members: [10, 11], sharers: [] });
    const b = shareProject('b', { members: [11], sharers: [] });
    cats.sharedForProject(10, a); // pool A created
    cats.sharedForProject(11, b); // pool B created
    expect(cats.listShared(10).map((c) => c.id)).toEqual([cats.sharedForProject(10, a)!.id]);
    expect(cats.listShared(11).map((c) => c.id).sort()).toEqual(
      [cats.sharedForProject(10, a)!.id, cats.sharedForProject(11, b)!.id].sort(),
    );
    expect(cats.listShared(12)).toHaveLength(0);
  });

  it('canUseCategory accepts own categories and shared pools of sharers only', () => {
    const project = shareProject('obchod', { members: [10, 11], sharers: [10] });
    const own = cats.create(10, { name: 'Own' });
    const pool = cats.sharedForProject(10, project)!;
    expect(canUseCategory(db, 10, own.id)).toBe(true);
    expect(canUseCategory(db, 10, pool.id)).toBe(true);
    expect(canUseCategory(db, 11, pool.id)).toBe(false); // member but not a sharer
    expect(canUseCategory(db, 12, pool.id)).toBe(false);
    expect(canUseCategory(db, 10, 99999)).toBe(false);
  });

  it('a member may write INTO the pool and read/edit/delete another member\'s shared memory', () => {
    const project = shareProject('obchod', { members: [10, 11], sharers: [10, 11] });
    const pool = cats.sharedForProject(10, project)!;

    const author = mem.add(10, { body: 'pricing decision' }, 'user:10', 'add');
    expect(mem.setCategory(10, author.id, pool.id, 'user:10', 'file into pool')).toBe(true);

    // Another member sees it through getAccessible and may mutate it (full parity).
    expect(mem.getAccessible(11, author.id)?.body).toBe('pricing decision');
    expect(mem.update(11, author.id, { importance: 5 }, 'user:11', 'edit')?.importance).toBe(5);
    expect(mem.getAccessible(12, author.id)).toBeUndefined(); // outsider still 404-equivalent

    // …but a member cannot pull the memory OUT of the pool (the asymmetry rule).
    const own = cats.create(11, { name: 'Mine' });
    expect(mem.setCategory(11, author.id, own.id, 'user:11', 'steal')).toBe(false);
    expect(mem.setCategory(11, author.id, null, 'user:11', 'clear')).toBe(false);
    expect(mem.get(10, author.id)?.category_id).toBe(pool.id); // untouched

    expect(mem.softDelete(11, author.id, 'user:11', 'delete')).toBe(true);
    expect(mem.get(10, author.id)?.status).toBe('deleted');
  });

  it('markUsed counts another member\'s recall of a shared memory and keys the event to the reader', () => {
    const project = shareProject('obchod', { members: [10, 11], sharers: [10, 11] });
    const pool = cats.sharedForProject(10, project)!;
    const memory = mem.add(10, { body: 'infra fact' }, 'user:10', 'add');
    mem.setCategory(10, memory.id, pool.id, 'user:10', 'tag');

    mem.markUsed(11, [memory.id], { sessionId: 's1', turnId: 't1', searchIndex: 0 });
    // The ROW's counter moved (the retention sweep must not see a live shared memory as dead)…
    const row = mem.get(10, memory.id)!;
    expect(row.use_count).toBe(1);
    expect(row.last_used_at).not.toBeNull();
    // …while the usage event records the READER.
    const events = db.prepare('SELECT user_id FROM memory_usage_events WHERE memory_id = ?').all(memory.id) as { user_id: number }[];
    expect(events).toEqual([{ user_id: 11 }]);
    // A foreign (non-shared) id logs nothing.
    const foreign = mem.add(12, { body: 'private' }, 'test', '');
    mem.markUsed(11, [foreign.id]);
    expect(mem.get(12, foreign.id)!.use_count).toBe(0);
  });

  it('recall surfaces another member\'s shared memory in a project-scoped retrieve', () => {
    const project = shareProject('obchod', { members: [10, 11], sharers: [10, 11] });
    const pool = cats.sharedForProject(10, project)!;
    const memory = mem.add(10, { body: 'deployment topology of the shop' }, 'user:10', 'add');
    mem.setCategory(10, memory.id, pool.id, 'user:10', 'file');

    // Author's own scope includes the pool category; the reader's scope does too via listShared.
    const scopeFor = (userId: number) => ({
      projectId: project.id,
      categoryIds: new Set([
        ...cats.list(userId).filter((c) => c.projectId === null || c.projectId === project.id).map((c) => c.id),
        ...cats.listShared(userId).map((c) => c.id),
      ]),
      sharedCategoryIds: new Set(cats.listShared(userId).map((c) => c.id)),
    });
    // Keyword path with the reader's widening set returns the other author's row.
    const hits = mem.search(11, 'deployment', 10, [...scopeFor(11).sharedCategoryIds]);
    expect(hits.map((m) => m.body)).toEqual(['deployment topology of the shop']);
    // The same search WITHOUT the shared widening stays empty (user-scoped as before).
    expect(mem.search(11, 'deployment', 10)).toHaveLength(0);
    expect(mem.getAccessible(11, memory.id)?.category_id).toBe(pool.id);
  });

  it('deleteShared clears every author\'s rows; the owner-scoped delete cannot touch the pool', () => {
    const project = shareProject('obchod', { members: [10, 11], sharers: [10, 11] });
    const pool = cats.sharedForProject(10, project)!;
    const a = mem.add(10, { body: 'x' }, 'user:10', 'add');
    const b = mem.add(11, { body: 'y' }, 'user:11', 'add');
    mem.setCategory(10, a.id, pool.id, 'user:10', 'tag');
    mem.setCategory(11, b.id, pool.id, 'user:11', 'tag');

    // An owner-scoped delete (as the old route would run it with the admin's id) is a no-op on the pool.
    expect(cats.delete(10, pool.id)).toBe(false);
    expect(cats.getShared(pool.id)).toBeDefined();

    expect(cats.deleteShared(pool.id)).toBe(true);
    expect(cats.getShared(pool.id)).toBeUndefined();
    expect(mem.get(10, a.id)?.category_id).toBeNull();
    expect(mem.get(11, b.id)?.category_id).toBeNull();
    expect(cats.deleteShared(pool.id)).toBe(false);
  });

  it('removeForUser re-attributes shared-pool rows to the instance instead of deleting them', () => {
    const project = shareProject('obchod', { members: [10, 11], sharers: [10, 11] });
    const pool = cats.sharedForProject(10, project)!;
    const shared = mem.add(10, { body: 'team fact' }, 'user:10', 'add');
    mem.setCategory(10, shared.id, pool.id, 'user:10', 'tag');
    const personal = mem.add(10, { body: 'mine only' }, 'user:10', 'add');

    mem.removeForUser(10);
    expect(mem.get(10, personal.id)).toBeUndefined(); // personal rows die with the account
    const kept = db.prepare('SELECT * FROM memories WHERE id = ?').get(shared.id) as { user_id: number; category_id: number };
    expect(kept.user_id).toBe(0); // the pool survives, re-attributed
    expect(kept.category_id).toBe(pool.id);
    // Audit events follow the re-attribution, so eventsForMemory stays consistent.
    const eventUsers = db.prepare('SELECT DISTINCT user_id FROM memory_events WHERE memory_id = ?').all(shared.id) as { user_id: number }[];
    expect(eventUsers).toEqual([{ user_id: 0 }]);
    expect(mem.eventsForMemory(shared.id).length).toBeGreaterThan(0);
  });

  it('reclassify excludes shared-pool rows and revision is author-keyed', () => {
    const project = shareProject('obchod', { members: [10, 11], sharers: [10, 11] });
    const pool = cats.sharedForProject(10, project)!;
    const shared = mem.add(10, { body: 'team fact' }, 'user:10', 'add');
    mem.setCategory(10, shared.id, pool.id, 'user:10', 'tag');
    expect(mem.sharedPoolCategoryIds()).toContain(pool.id);
    // The author-keyed revision reads events written under the row's owner…
    expect(mem.revision(shared.id)).toBeGreaterThan(0);
    // …and a member's CAS passes the author-keyed revision, not a zeroed foreign one.
    const ok = mem.setCategoryIfUnchanged(11, shared.id, {
      bodyHash: hashBody('team fact'),
      categoryId: pool.id,
      revision: mem.revision(shared.id),
    }, pool.id, 'user:11', 'categorize');
    expect(ok).toBe(true);
  });

  it('user-delete drops the share-list rows; the pool membership itself survives', () => {
    const project = shareProject('obchod', { members: [10, 11], sharers: [10] });
    expect(userProjects.memoryMembers(project.id)).toEqual([10]);
    userProjects.setMemoryMembers(project.id, [10]);
    cats.removeShareMembership(10);
    expect(userProjects.memoryMembers(project.id)).toHaveLength(0);
    // canUseCategory flips with the list: 11 is now a member of an empty list → sharer.
    const pool = cats.sharedForProject(11, project)!;
    expect(canUseCategory(db, 11, pool.id)).toBe(true);
  });

  it('merge keeps the pool when all sources agree on it, and never mixes a private fact into it', () => {
    const project = shareProject('obchod', { members: [10, 11], sharers: [10, 11] });
    const pool = cats.sharedForProject(10, project)!;
    const a = mem.add(10, { body: 'supplier A terms' }, 'user:10', 'add');
    const b = mem.add(11, { body: 'supplier A pricing' }, 'user:11', 'add');
    mem.setCategory(10, a.id, pool.id, 'user:10', 'tag');
    mem.setCategory(11, b.id, pool.id, 'user:11', 'tag');
    // A member merges two of the team's rows: the merged memory STAYS in the pool.
    const merged = mem.merge(11, [a.id, b.id], 'supplier A: terms + pricing', 'user:11', 'dedupe');
    expect(merged.category_id).toBe(pool.id);
    // Mixing a pool row with a personal row lands UNCATEGORIZED — the shared fact must not leak into
    // anyone's private filing (a later reclassify pass re-files it).
    const personal = mem.add(11, { body: 'my own note' }, 'user:11', 'add');
    const mixed = mem.merge(11, [a.id, personal.id], 'mixed merge', 'user:11', 'dedupe');
    expect(mixed.category_id).toBeNull();
  });

  it('a sharer may hard-purge a foreign shared row, taking every reader\'s usage events with it', () => {
    const project = shareProject('obchod', { members: [10, 11], sharers: [10, 11] });
    const pool = cats.sharedForProject(10, project)!;
    const foreign = mem.add(10, { body: 'obsolete fact' }, 'user:10', 'add');
    mem.setCategory(10, foreign.id, pool.id, 'user:10', 'tag');
    mem.markUsed(10, [foreign.id]);
    mem.markUsed(11, [foreign.id]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_usage_events WHERE memory_id = ?').get(foreign.id)).toEqual({ n: 2 });

    // Full parity on the destructive path too…
    expect(mem.purge(11, foreign.id, 'user:11', 'cleanup')).toBe(true);
    // …and the row is GONE: the embedding cascades, the usage events follow, the audit survives.
    expect(mem.get(10, foreign.id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_usage_events WHERE memory_id = ?').get(foreign.id)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_events WHERE memory_id = ?').get(foreign.id)).toEqual({ n: 3 });
    // A non-member still cannot purge anything foreign.
    const other = mem.add(12, { body: 'private' }, 'user:12', 'add');
    expect(mem.purge(11, other.id, 'user:11', 'nope')).toBe(false);
    expect(mem.get(12, other.id)).toBeDefined();
  });

  it('unassigning a member revokes their share-list row, so pool access cannot outlive project access', () => {
    const project = shareProject('obchod', { members: [10, 11], sharers: [10, 11] });
    const pool = cats.sharedForProject(10, project)!;
    expect(canUseCategory(db, 11, pool.id)).toBe(true);

    userProjects.unassign(11, project.id);
    expect(userProjects.memoryMembers(project.id)).toEqual([10]);
    expect(isSharer(db, 11, project.id)).toBe(false);
    expect(canUseCategory(db, 11, pool.id)).toBe(false);
  });

  it('setCategory rejects a foreign category target and an unknown memory as before', () => {
    shareProject('obchod', { members: [10], sharers: [10] });
    const other = cats.create(11, { name: 'Foreign' });
    const memory = mem.add(10, { body: 'x' }, 'user:10', 'add');
    expect(mem.setCategory(10, memory.id, other.id, 'user:10', 'tag')).toBe(false);
    expect(mem.setCategory(10, 99999, null, 'user:10', 'tag')).toBe(false);
  });
});
