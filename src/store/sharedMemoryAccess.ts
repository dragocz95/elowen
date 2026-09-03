import type { Db } from './db.js';

/** Sentinel owner of a project's SHARED memory category. A memory_categories row with user_id = 0 and
 *  a non-null project_id is the instance-owned shared pool of that project; memories inside it keep
 *  their author's real user_id (attribution + audit). The 0 sentinel follows the activity_buckets
 *  precedent ("0 = no account behind it") and is safe because nothing joins users over the memory
 *  tables — the one deliberate JOIN lives in the /memory list projection for author names. */
export const SHARED_CATEGORY_USER_ID = 0;

/** Access predicates for SHARED PROJECT MEMORY. Deliberately fail-closed and derived DIRECTLY from
 *  `projects.memory_shared` + `project_memory_members` + `user_projects`:
 *  - NOT via `UserProjectStore.canAccess` / `canAccessProject`, which return true for an admin on every
 *    project and true in single-user mode when the stores are absent — either would silently make an
 *    admin a sharer of every pool (and redirect their MemoryAdd fallback into someone else's pool).
 *  - An admin shares a pool only like anyone else: as a project member, or named in the share list.
 *
 *  Share-list semantics (the feature contract): when the toggle is on and `project_memory_members` has
 *  NO rows for the project, every project member shares it; with rows present, exactly those users. */

function projectShared(db: Db, projectId: number): boolean {
  const row = db.prepare('SELECT memory_shared FROM projects WHERE id = ?').get(projectId) as
    { memory_shared: number } | undefined;
  return !!row && row.memory_shared === 1;
}

/** True when `userId` may read/write the shared memory pool of `projectId`. */
export function isSharer(db: Db, userId: number, projectId: number): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  if (!projectShared(db, projectId)) return false;
  const named = db.prepare(
    'SELECT 1 FROM project_memory_members WHERE project_id = ? AND user_id = ?',
  ).get(projectId, userId);
  if (named) return true;
  const hasList = db.prepare('SELECT 1 FROM project_memory_members WHERE project_id = ? LIMIT 1').get(projectId);
  if (hasList) return false; // an explicit list exists and does not name this user
  // Empty selection = all project members share.
  return !!db.prepare('SELECT 1 FROM user_projects WHERE user_id = ? AND project_id = ?').get(userId, projectId);
}

/** Ids of the shared memory categories this user may touch, across EVERY project they share. The
 *  browsing/search surface (web list, semantic search, retrieval inspector) works over this whole set;
 *  turn recall narrows to one project through the scope instead. */
export function sharedCategoryIds(db: Db, userId: number): number[] {
  if (!Number.isSafeInteger(userId) || userId <= 0) return [];
  const rows = db.prepare(
    `SELECT c.id FROM memory_categories c
      WHERE c.user_id = ? AND c.project_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM projects p WHERE p.id = c.project_id AND p.memory_shared = 1)
        AND (
          EXISTS (SELECT 1 FROM project_memory_members m WHERE m.project_id = c.project_id AND m.user_id = ?)
          OR (
            NOT EXISTS (SELECT 1 FROM project_memory_members m2 WHERE m2.project_id = c.project_id)
            AND EXISTS (SELECT 1 FROM user_projects up WHERE up.user_id = ? AND up.project_id = c.project_id)
          )
        )`,
  ).all(SHARED_CATEGORY_USER_ID, userId, userId) as { id: number }[];
  return rows.map((r) => r.id);
}

/** True when `userId` may USE `categoryId` as a target for their memories: one of their OWN categories,
 *  or the shared category of a project they share. This is the category-side twin of memory access —
 *  `setCategory`/`setCategoryIfUnchanged` must ask THIS, not just row ownership, or every write into a
 *  shared pool is silently rejected (the category carries user_id = 0) and the memory stays
 *  uncategorized, which recall never surfaces (fail-closed). */
export function canUseCategory(db: Db, userId: number, categoryId: number): boolean {
  const cat = db.prepare('SELECT user_id, project_id FROM memory_categories WHERE id = ?')
    .get(categoryId) as { user_id: number; project_id: number | null } | undefined;
  if (!cat) return false;
  if (cat.user_id === userId) return true;
  if (cat.user_id === SHARED_CATEGORY_USER_ID && cat.project_id !== null) {
    return isSharer(db, userId, cat.project_id);
  }
  return false;
}
