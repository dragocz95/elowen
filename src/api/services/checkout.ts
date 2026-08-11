import { usagePath } from '../../integrations/usage/usagePath.js';

/** Resolves the pieces needed to map a task to the checkout its agent writes in. */
export interface CheckoutResolver {
  /** Filesystem path of a project's shared checkout. */
  projectPath: (projectId: number) => string;
  /** A PR mission's isolated worktree dir, or null/undefined when it runs in the shared checkout. */
  worktreeFor?: (missionId: string) => string | null | undefined;
}

/** The checkout a task's agent edits — its cwd (mirrors usagePath): a PR mission's isolated worktree,
 *  else the shared project path. */
export function checkoutOf(r: CheckoutResolver, task: { project_id: number; parent_id: string | null }): string {
  return usagePath(task, r.projectPath, r.worktreeFor);
}
