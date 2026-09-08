import { readIsAdmin } from './userStore.js';
import type { Db } from './db.js';

export class ProjectMembershipError extends Error {}

/** Assignments of users to projects (many-to-many). The bootstrap admin (users.is_admin) always
 *  has access to everything regardless of rows here — see `canAccess`. */
export class UserProjectStore {
  constructor(private db: Db) {}

  /** Project ids assigned to a user. */
  forUser(userId: number): number[] {
    return (this.db.prepare('SELECT project_id FROM user_projects WHERE user_id = ? ORDER BY project_id').all(userId) as { project_id: number }[])
      .map((r) => r.project_id);
  }

  /** Non-admin account ids explicitly assigned to one Project. Admin access is global and therefore is
   *  not represented by assignment rows. */
  forProject(projectId: number): number[] {
    return (this.db.prepare('SELECT user_id FROM user_projects WHERE project_id = ? ORDER BY user_id').all(projectId) as { user_id: number }[])
      .map((r) => r.user_id);
  }

  assign(userId: number, projectId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO user_projects (user_id, project_id) VALUES (?, ?)').run(userId, projectId);
  }

  /** Revoke project access. The shared-memory share row MUST go with it: `isSharer` answers true for
   *  a named member WITHOUT re-checking `user_projects` (deliberately — the pool predicates must be
   *  cheap and single-source), so a share row left behind would keep the removed member reading and
   *  writing the pool. PUT /memory-members validates canAccess only at write time; THIS is what keeps
   *  the "share grant can never exceed project access" invariant true afterwards. */
  unassign(userId: number, projectId: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM user_projects WHERE user_id = ? AND project_id = ?').run(userId, projectId);
      this.db.prepare('DELETE FROM project_memory_members WHERE user_id = ? AND project_id = ?').run(userId, projectId);
    })();
  }

  /** True for an admin account (full visibility + may manage assignments). Delegates to the one reader
   *  in `userStore` so this store and `UserStore.isAdmin` can never answer the same question differently. */
  isAdmin(userId: number): boolean {
    return readIsAdmin(this.db, userId);
  }

  /** Access and management use current membership; creator attribution is not a role. */
  canAccess(userId: number, projectId: number): boolean {
    const project = this.db.prepare('SELECT lifecycle FROM projects WHERE id = ?').get(projectId) as { lifecycle: string } | undefined;
    return project?.lifecycle === 'active' && this.canManage(userId, projectId);
  }

  /** Pending deletion denies execution but its existing members may still observe/retry cleanup. */
  canManage(userId: number, projectId: number): boolean {
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return false;
    if (this.isAdmin(userId)) return true;
    return !!this.db.prepare('SELECT 1 FROM user_projects WHERE user_id = ? AND project_id = ?').get(userId, projectId);
  }

  addMember(actorId: number, userId: number, projectId: number): void {
    this.db.transaction(() => {
      if (!this.canAccess(actorId, projectId)) throw new ProjectMembershipError('project access denied');
      if (!this.isAdmin(actorId)) {
        const user = this.db.prepare('SELECT can_share_projects FROM users WHERE id = ?').get(actorId) as { can_share_projects: number } | undefined;
        if (!user?.can_share_projects) throw new ProjectMembershipError('project sharing is not permitted');
        const project = this.db.prepare('SELECT execution_kind FROM projects WHERE id = ?').get(projectId) as { execution_kind: string };
        if (project.execution_kind !== 'managed') throw new ProjectMembershipError('administrator permission required for host projects');
      }
      if (!this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw new ProjectMembershipError('account not found');
      this.assign(userId, projectId);
    }).immediate();
  }

  removeMember(actorId: number, userId: number, projectId: number): void {
    this.db.transaction(() => {
      if (!this.canAccess(actorId, projectId)) throw new ProjectMembershipError('project access denied');
      const project = this.db.prepare('SELECT execution_kind FROM projects WHERE id = ?').get(projectId) as { execution_kind: string };
      if (project.execution_kind !== 'managed' && !this.isAdmin(actorId)) throw new ProjectMembershipError('administrator permission required for host projects');
      this.unassign(userId, projectId);
    }).immediate();
  }

  // --- Shared-memory share list (project_memory_members). An EMPTY list means every project member
  // shares the pool; a non-empty list names exactly the sharers. Kept here because it is project
  // tenancy, not memory content — and because this store already owns the user↔project join. ---

  /** The explicit share list of one project (admin-managed). */
  memoryMembers(projectId: number): number[] {
    return (this.db.prepare('SELECT user_id FROM project_memory_members WHERE project_id = ? ORDER BY user_id').all(projectId) as { user_id: number }[])
      .map((r) => r.user_id);
  }

  /** Replace the share list WHOLESALE, atomically. Callers validate the users first (existing accounts,
   *  project members); the store just persists the list. */
  setMemoryMembers(projectId: number, userIds: number[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM project_memory_members WHERE project_id = ?').run(projectId);
      const insert = this.db.prepare('INSERT OR IGNORE INTO project_memory_members (project_id, user_id) VALUES (?, ?)');
      for (const userId of new Set(userIds)) insert.run(projectId, userId);
    })();
  }
}
