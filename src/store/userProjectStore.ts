import { readIsAdmin } from './userStore.js';
import type { Db } from './db.js';

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

  unassign(userId: number, projectId: number): void {
    this.db.prepare('DELETE FROM user_projects WHERE user_id = ? AND project_id = ?').run(userId, projectId);
  }

  /** True for an admin account (full visibility + may manage assignments). Delegates to the one reader
   *  in `userStore` so this store and `UserStore.isAdmin` can never answer the same question differently. */
  isAdmin(userId: number): boolean {
    return readIsAdmin(this.db, userId);
  }

  /** True when the user may see/operate the project: the admin always can; otherwise only when
   *  explicitly assigned. (Assignment is the access boundary for non-admin users.) */
  canAccess(userId: number, projectId: number): boolean {
    if (this.isAdmin(userId)) return true;
    const r = this.db.prepare('SELECT 1 FROM user_projects WHERE user_id = ? AND project_id = ?').get(userId, projectId);
    return !!r;
  }
}
