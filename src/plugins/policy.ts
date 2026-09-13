/** What a brain session may touch. Admin → 'all'; a user → their assigned Elowen projects' repo paths.
 *  The single source of truth is Elowen's per-user project access, so file/terminal tools (later plugins)
 *  never invent a parallel allow-list — they consult `allowedPaths()`. */
export interface Policy {
  allowedProjectIds: Set<number> | 'all';
  /** The repo roots this session may operate in. Empty for a user with no project access; for an admin
   *  (`allowedProjectIds === 'all'`) this stays empty — an all-access tool special-cases 'all' instead. */
  allowedPaths(): string[];
  /** Live account/project check used for managed targets, including deletion and revocation. */
  canAccessProject?(projectId: number): boolean;
  canExecuteHost?(): boolean;
}

export interface PolicyDeps {
  userProjects: { forUser(userId: number): number[]; isAdmin(userId: number): boolean };
  projects: { get(id: number): { path: string; executionKind?: 'host' | 'managed'; lifecycle?: 'active' | 'deleting' } | null | undefined };
}

/** Resolve the repo-access policy for a user from Elowen's existing project assignments. */
export function resolvePolicy(deps: PolicyDeps, userId: number): Policy {
  const ids = new Set(deps.userProjects.forUser(userId));
  const canAccessProject = (projectId: number): boolean => {
    const project = deps.projects.get(projectId);
    return !!project && project.lifecycle !== 'deleting' && (deps.userProjects.isAdmin(userId)
      || (ids.has(projectId) && deps.userProjects.forUser(userId).includes(projectId)));
  };
  if (deps.userProjects.isAdmin(userId)) {
    return { allowedProjectIds: 'all', allowedPaths: () => [], canAccessProject, canExecuteHost: () => deps.userProjects.isAdmin(userId) };
  }
  return {
    canAccessProject,
    allowedProjectIds: ids,
    allowedPaths: () => {
      // A session keeps the project set it was minted with, but removals apply immediately: re-read the
      // assignment and intersect it with that frozen set. A later grant waits for a respawn rather than
      // silently widening a live session; a revocation never does.
      const assigned = new Set(deps.userProjects.forUser(userId));
      const currentIds = [...ids].filter((id) => assigned.has(id));
      return currentIds.map((id) => deps.projects.get(id))
        .filter((project) => project?.executionKind !== 'managed' && project?.lifecycle !== 'deleting')
        .map((project) => project?.path).filter((p): p is string => !!p);
    },
  };
}
