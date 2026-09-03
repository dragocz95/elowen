import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { MemoryCategoryRow } from '../shared/wireContract.js';

export interface MemoryRecallScope {
  projectId: number | null;
  /** Every category eligible for recall in this scope: the user's own eligible categories plus (when
   *  they share the resolved project) that project's shared pool. Recall filters on THIS set. */
  categoryIds: ReadonlySet<number>;
  /** The subset of `categoryIds` that are SHARED pool categories. The store needs the split to widen
   *  its user-keyed candidate queries (`user_id = ? OR category_id IN (…)`); recall filtering itself
   *  only ever consults `categoryIds`. */
  sharedCategoryIds: ReadonlySet<number>;
}

interface RecallProject {
  id: number;
  path: string;
}

interface RecallCategories {
  list(userId: number): MemoryCategoryRow[];
  /** Shared pool categories the user may touch across every project they share (may be empty). */
  listShared(userId: number): MemoryCategoryRow[];
}

interface RecallProjects {
  list(): RecallProject[];
}

export function globalMemoryRecallScope(userId: number, categories: RecallCategories): MemoryRecallScope {
  return memoryRecallScope(userId, undefined, categories, { list: () => [] });
}

/** Resolves a memory scope from canonical paths. `relative` preserves directory boundaries, so a project
 * at `/work/kolin` cannot accidentally claim `/work/kolin-old`. */
export function memoryRecallScope(
  userId: number,
  cwd: string | undefined,
  categories: RecallCategories,
  projects: RecallProjects,
): MemoryRecallScope {
  const canonicalCwd = canonicalDirectory(cwd);
  let projectId: number | null = null;
  let longestPath = '';

  if (canonicalCwd) {
    for (const project of projects.list()) {
      const projectPath = canonicalDirectory(project.path);
      if (!projectPath || !isWithinDirectory(canonicalCwd, projectPath) || projectPath.length <= longestPath.length) continue;
      projectId = project.id;
      longestPath = projectPath;
    }
  }

  const own = categories.list(userId)
    .filter((category) => category.projectId === null || category.projectId === projectId);
  // Shared pools enter the scope through the project binding they already carry: a shared category is
  // bound to its project, so outside that project (and in the global channel scope) it drops out by the
  // same predicate — no special-casing. listShared only returns pools the user actually shares.
  const shared = categories.listShared(userId)
    .filter((category) => category.projectId === projectId);
  const categoryIds = new Set([...own, ...shared].map((category) => category.id));
  return {
    projectId,
    categoryIds,
    sharedCategoryIds: new Set(shared.map((category) => category.id)),
  };
}

function canonicalDirectory(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isWithinDirectory(path: string, directory: string): boolean {
  const pathFromDirectory = relative(directory, path);
  return pathFromDirectory === '' || (!pathFromDirectory.startsWith('..') && !isAbsolute(pathFromDirectory));
}
