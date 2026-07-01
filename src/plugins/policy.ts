/** What a brain session may touch. Admin → 'all'; a user → their assigned Orca projects' repo paths.
 *  The single source of truth is Orca's per-user project access, so file/terminal tools (later plugins)
 *  never invent a parallel allow-list — they consult `allowedPaths()`. */
export interface Policy {
  allowedProjectIds: Set<number> | 'all';
  /** The repo roots this session may operate in. Empty for a user with no project access; for an admin
   *  (`allowedProjectIds === 'all'`) this stays empty — an all-access tool special-cases 'all' instead. */
  allowedPaths(): string[];
}

export interface PolicyDeps {
  userProjects: { forUser(userId: number): number[]; isAdmin(userId: number): boolean };
  projects: { get(id: number): { path: string } | undefined };
}

/** Resolve the repo-access policy for a user from Orca's existing project assignments. */
export function resolvePolicy(deps: PolicyDeps, userId: number): Policy {
  if (deps.userProjects.isAdmin(userId)) {
    return { allowedProjectIds: 'all', allowedPaths: () => [] };
  }
  const ids = new Set(deps.userProjects.forUser(userId));
  return {
    allowedProjectIds: ids,
    allowedPaths: () => [...ids].map((id) => deps.projects.get(id)?.path).filter((p): p is string => !!p),
  };
}
