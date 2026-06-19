import type { Db } from './db.js';

/** Assignments of users to projects (many-to-many). The bootstrap admin (lowest user id) is
 *  treated as having access to everything regardless of rows here — see `canAccess`. */
export class UserProjectStore {
  constructor(private db: Db) {}

  /** Project ids assigned to a user. */
  forUser(userId: number): number[] {
    return (this.db.prepare('SELECT project_id FROM user_projects WHERE user_id = ? ORDER BY project_id').all(userId) as { project_id: number }[])
      .map((r) => r.project_id);
  }

  assign(userId: number, projectId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO user_projects (user_id, project_id) VALUES (?, ?)').run(userId, projectId);
  }

  unassign(userId: number, projectId: number): void {
    this.db.prepare('DELETE FROM user_projects WHERE user_id = ? AND project_id = ?').run(userId, projectId);
  }

  /** The lowest existing user id — the bootstrap admin, who always has full access. */
  private adminId(): number | null {
    const r = this.db.prepare('SELECT MIN(id) AS id FROM users').get() as { id: number | null };
    return r.id;
  }

  /** True when the user may see/operate the project: the admin always can; otherwise only when
   *  explicitly assigned. (Assignment is the access boundary for non-admin users.) */
  canAccess(userId: number, projectId: number): boolean {
    if (userId === this.adminId()) return true;
    const r = this.db.prepare('SELECT 1 FROM user_projects WHERE user_id = ? AND project_id = ?').get(userId, projectId);
    return !!r;
  }

  /** True for the bootstrap admin (full visibility + may manage assignments). */
  isAdmin(userId: number): boolean {
    return userId === this.adminId();
  }
}
