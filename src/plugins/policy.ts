/** What a brain session may touch. Admin → 'all'; a user → their assigned Elowen projects' repo paths.
 *  The single source of truth is Elowen's per-user project access, so file/terminal tools (later plugins)
 *  never invent a parallel allow-list — they consult `allowedPaths()`. */
export interface Policy {
  allowedProjectIds: Set<number> | 'all';
  /** The repo roots this session may operate in. Empty for a user with no project access; for an admin
   *  (`allowedProjectIds === 'all'`) this stays empty — an all-access tool special-cases 'all' instead. */
  allowedPaths(): string[];
}

export interface PolicyDeps {
  userProjects: { forUser(userId: number): number[]; isAdmin(userId: number): boolean };
  projects: { get(id: number): { path: string } | null | undefined };
  /** Live supplemental roots owned by another domain (Sandbox workspaces). Each row names its Project so
   * core can intersect it with the account's CURRENT assignment instead of trusting a path-only widening. */
  supplementalPaths?: (userId: number, projectIds: readonly number[]) => { projectId: number; path: string }[];
}

/** Resolve the repo-access policy for a user from Elowen's existing project assignments. */
export function resolvePolicy(deps: PolicyDeps, userId: number): Policy {
  if (deps.userProjects.isAdmin(userId)) {
    return { allowedProjectIds: 'all', allowedPaths: () => [] };
  }
  const ids = new Set(deps.userProjects.forUser(userId));
  return {
    allowedProjectIds: ids,
    allowedPaths: () => {
      // A session keeps the project set it was minted with, but removals apply immediately: re-read the
      // assignment and intersect it with that frozen set. A later grant waits for a respawn rather than
      // silently widening a live session; a revocation never does.
      const assigned = new Set(deps.userProjects.forUser(userId));
      const currentIds = [...ids].filter((id) => assigned.has(id));
      const roots = currentIds.map((id) => deps.projects.get(id)?.path).filter((p): p is string => !!p);
      if (!deps.supplementalPaths || currentIds.length === 0) return roots;
      const allowed = new Set(currentIds);
      let supplemental: { projectId: number; path: string }[] = [];
      try { supplemental = deps.supplementalPaths(userId, currentIds); }
      catch { return roots; }
      for (const root of supplemental) {
        if (allowed.has(root.projectId) && root.path && !roots.includes(root.path)) roots.push(root.path);
      }
      return roots;
    },
  };
}
