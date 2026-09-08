import { randomUUID } from 'node:crypto';
import { withWriteLock, type Db } from './db.js';
import { readIsAdmin } from './userStore.js';

export interface Project {
  id: number; slug: string; path: string; notes: string; icon: string; memoryShared: boolean;
  executionKind: 'host' | 'managed'; creatorUserId: number | null; lifecycle: 'active' | 'deleting';
}

type ProjectRow = Omit<Project, 'memoryShared' | 'executionKind' | 'creatorUserId'> & {
  memory_shared: number; execution_kind: Project['executionKind']; creator_user_id: number | null;
};
const toProject = (r: ProjectRow): Project => ({
  id: r.id, slug: r.slug, path: r.path, notes: r.notes ?? '', icon: r.icon ?? '',
  memoryShared: r.memory_shared === 1, executionKind: r.execution_kind,
  creatorUserId: r.creator_user_id, lifecycle: r.lifecycle,
});

export class ProjectStore {
  constructor(private db: Db) {}
  create(p: { slug: string; path: string; notes?: string }): Project {
    const info = this.db.prepare('INSERT INTO projects (slug, path, notes) VALUES (?, ?, ?)').run(p.slug, p.path, p.notes ?? '');
    const project = this.get(Number(info.lastInsertRowid));
    if (!project) throw new Error('created project missing');
    return project;
  }
  createManaged(p: { slug: string; creatorUserId: number; notes?: string }): Project {
    return withWriteLock(this.db, () => {
      if (!this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(p.creatorUserId)) throw new Error('account not found');
      const info = this.db.prepare("INSERT INTO projects (slug, path, notes, execution_kind, creator_user_id) VALUES (?, '', ?, 'managed', ?)")
        .run(p.slug, p.notes ?? '', p.creatorUserId);
      const id = Number(info.lastInsertRowid);
      this.db.prepare('INSERT INTO user_projects (user_id, project_id) VALUES (?, ?)').run(p.creatorUserId, id);
      return this.get(id)!;
    });
  }
  /** The grant and limit are read under the same write lock as creation. */
  createForUser(userId: number, p: { slug: string; notes?: string }): Project {
    return withWriteLock(this.db, () => {
      const user = this.db.prepare('SELECT can_create_projects, project_limit FROM users WHERE id = ?').get(userId) as { can_create_projects: number; project_limit: number } | undefined;
      if (!user) throw new Error('account not found');
      if (!readIsAdmin(this.db, userId)) {
        if (!user.can_create_projects) throw new Error('project creation is not permitted');
        this.ensureDefault(userId);
        const { count } = this.db.prepare("SELECT COUNT(*) AS count FROM projects WHERE creator_user_id = ? AND execution_kind = 'managed'").get(userId) as { count: number };
        if (count >= user.project_limit) throw new Error('project creation limit reached');
      }
      return this.createManaged({ ...p, creatorUserId: userId });
    });
  }
  /** Metadata only. Existing accounts acquire a default lazily, without starting a container. */
  ensureDefault(userId: number): Project {
    return withWriteLock(this.db, () => {
      const user = this.db.prepare('SELECT default_project_id, project_limit FROM users WHERE id = ?').get(userId) as { default_project_id: number | null; project_limit: number } | undefined;
      if (!user) throw new Error('account not found');
      const existing = user.default_project_id === null ? null : this.get(user.default_project_id);
      if (existing?.lifecycle === 'active' && this.db.prepare('SELECT 1 FROM user_projects WHERE user_id = ? AND project_id = ?').get(userId, existing.id)) return existing;
      const { count } = this.db.prepare("SELECT COUNT(*) AS count FROM projects WHERE creator_user_id = ? AND execution_kind = 'managed'").get(userId) as { count: number };
      if (!readIsAdmin(this.db, userId) && count >= user.project_limit) throw new Error('project creation limit reached');
      const project = this.createManaged({ slug: `personal-${userId}-${randomUUID().slice(0, 8)}`, creatorUserId: userId });
      this.db.prepare('UPDATE users SET default_project_id = ? WHERE id = ?').run(project.id, userId);
      return project;
    });
  }
  list(): Project[] { return (this.db.prepare('SELECT * FROM projects ORDER BY id').all() as ProjectRow[]).map(toProject); }
  get(id: number): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return r ? toProject(r) : null;
  }
  update(id: number, patch: { path?: string; notes?: string; icon?: string; memoryShared?: boolean }): Project | null {
    const cur = this.get(id);
    if (!cur) return null;
    if (cur.lifecycle !== 'active') throw new Error('project deletion is pending');
    if (cur.executionKind === 'managed' && patch.path !== undefined) throw new Error('managed projects do not have a host path');
    this.db.prepare('UPDATE projects SET path = ?, notes = ?, icon = ?, memory_shared = ? WHERE id = ?')
      .run(patch.path ?? cur.path, patch.notes ?? cur.notes, patch.icon ?? cur.icon, (patch.memoryShared ?? cur.memoryShared) ? 1 : 0, id);
    return this.get(id);
  }
  beginDeletion(id: number): boolean {
    return this.db.prepare("UPDATE projects SET lifecycle = 'deleting' WHERE id = ? AND execution_kind = 'managed'").run(id).changes > 0;
  }
  /** Called only by the runtime's verified cleanup acknowledgement, never by a user route. */
  finishDeletion(id: number): boolean {
    if (this.get(id)?.lifecycle !== 'deleting') throw new Error('project cleanup has not been requested');
    return this.removeRows(id);
  }
  remove(id: number): boolean {
    const project = this.get(id);
    if (!project) return false;
    if (project.executionKind === 'managed') throw new Error('managed project requires verified runtime cleanup');
    return this.removeRows(id);
  }
  private removeRows(id: number): boolean {
    return withWriteLock(this.db, () => {
      if (!this.get(id)) return false;
      this.db.prepare('DELETE FROM user_projects WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM project_memory_members WHERE project_id = ?').run(id);
      this.db.prepare("UPDATE memories SET category_id = NULL, updated_at = datetime('now') WHERE category_id IN (SELECT id FROM memory_categories WHERE project_id = ?)").run(id);
      this.db.prepare('DELETE FROM memory_categories WHERE project_id = ?').run(id);
      this.db.prepare('UPDATE users SET default_project_id = NULL WHERE default_project_id = ?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      return true;
    });
  }
}
