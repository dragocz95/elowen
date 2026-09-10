import { randomUUID } from 'node:crypto';
import { withWriteLock, type Db } from './db.js';
import { readIsAdmin } from './userStore.js';
import { isReservedProjectSlug } from '../shared/projectExecution.js';

export interface Project {
  id: number; slug: string; path: string; adoptedPath: string | null; notes: string; icon: string; memoryShared: boolean;
  executionKind: 'host' | 'managed'; creatorUserId: number | null; lifecycle: 'active' | 'deleting';
}

/** The refusal {@link ProjectStore.createManaged} throws when the account is at its ceiling. Both routes
 *  that create a managed project answer it with a 409, so the text they match on lives with the throw. */
export const PROJECT_LIMIT_REACHED = 'project creation limit reached';

/** The refusals {@link ProjectStore.adoptAsManaged} and {@link ProjectStore.releaseAdopted} throw. The
 *  adopt route answers `managed` with a 409 because adopting twice is a condition of the project rather
 *  than a bad request, and `notAdopted` with a 409 for the same reason. */
export const PROJECT_ALREADY_MANAGED = 'project is already managed';
export const PROJECT_NOT_ADOPTED = 'project was not adopted';

type ProjectRow = Omit<Project, 'memoryShared' | 'executionKind' | 'creatorUserId' | 'adoptedPath'> & {
  memory_shared: number; execution_kind: Project['executionKind']; creator_user_id: number | null; adopted_path: string | null;
};
const toProject = (r: ProjectRow): Project => ({
  id: r.id, slug: r.slug, path: r.path, notes: r.notes ?? '', icon: r.icon ?? '',
  adoptedPath: r.adopted_path ?? null, memoryShared: r.memory_shared === 1, executionKind: r.execution_kind,
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
  /** The one place a managed project row is written, and therefore the one place its ceiling is enforced:
   *  the limit is counted under the same write lock as the insert it bounds. The account's own default is
   *  created through here too, so a limit an administrator lowered below the current count holds for it
   *  as well. Administrators are unbounded. */
  private createManaged(p: { slug: string; creatorUserId: number; notes?: string }): Project {
    return withWriteLock(this.db, () => {
      const user = this.db.prepare('SELECT project_limit FROM users WHERE id = ?').get(p.creatorUserId) as { project_limit: number } | undefined;
      if (!user) throw new Error('account not found');
      if (!readIsAdmin(this.db, p.creatorUserId)) {
        const { count } = this.db.prepare("SELECT COUNT(*) AS count FROM projects WHERE creator_user_id = ? AND execution_kind = 'managed'").get(p.creatorUserId) as { count: number };
        if (count >= user.project_limit) throw new Error(PROJECT_LIMIT_REACHED);
      }
      const info = this.db.prepare("INSERT INTO projects (slug, path, notes, execution_kind, creator_user_id) VALUES (?, '', ?, 'managed', ?)")
        .run(p.slug, p.notes ?? '', p.creatorUserId);
      const id = Number(info.lastInsertRowid);
      this.db.prepare('INSERT INTO user_projects (user_id, project_id) VALUES (?, ?)').run(p.creatorUserId, id);
      return this.get(id)!;
    });
  }
  /** The grant is read under the same write lock as creation; the limit belongs to {@link createManaged},
   *  which bounds every managed row including the default this may have to provision first. */
  createForUser(userId: number, p: { slug: string; notes?: string }): Project {
    return withWriteLock(this.db, () => {
      const user = this.db.prepare('SELECT can_create_projects FROM users WHERE id = ?').get(userId) as { can_create_projects: number } | undefined;
      if (!user) throw new Error('account not found');
      if (!readIsAdmin(this.db, userId)) {
        if (!user.can_create_projects) throw new Error('project creation is not permitted');
        this.ensureDefault(userId);
      }
      return this.createManaged({ ...p, creatorUserId: userId });
    });
  }
  /** Metadata only. Existing accounts acquire a default lazily, without starting a container. */
  ensureDefault(userId: number): Project {
    return withWriteLock(this.db, () => {
      const user = this.db.prepare('SELECT default_project_id FROM users WHERE id = ?').get(userId) as { default_project_id: number | null } | undefined;
      if (!user) throw new Error('account not found');
      const existing = user.default_project_id === null ? null : this.get(user.default_project_id);
      if (existing?.lifecycle === 'active' && this.db.prepare('SELECT 1 FROM user_projects WHERE user_id = ? AND project_id = ?').get(userId, existing.id)) return existing;
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
  /** Turn an existing HOST project into a managed one IN PLACE. The row keeps its identity, its members,
   *  its Sites and its history: what changes is where its directory is — the sandbox moves it into the
   *  project's own workspace volume on the first start — and where its turns run. `adopted_path` is the
   *  original location, kept so {@link releaseAdopted} is possible at all.
   *
   *  Refused for a project that is already managed, one whose deletion is pending, and one whose slug
   *  would mount over a base-image directory: such a project could be adopted and then never started, and
   *  its slug is not patchable. The daemon's own home project is refused by the caller, which is the only
   *  layer that knows which row that is. */
  adoptAsManaged(id: number): Project {
    return withWriteLock(this.db, () => {
      const current = this.get(id);
      if (!current) throw new Error('project not found');
      if (current.executionKind === 'managed') throw new Error(PROJECT_ALREADY_MANAGED);
      if (current.lifecycle !== 'active') throw new Error('project deletion is pending');
      if (isReservedProjectSlug(current.slug)) throw new Error('slug is reserved by the project environment');
      const changed = this.db.prepare("UPDATE projects SET execution_kind='managed', adopted_path=path, path='' WHERE id=? AND execution_kind='host' AND lifecycle='active'").run(id).changes;
      if (!changed) throw new Error('project changed while it was being adopted');
      return this.get(id)!;
    });
  }
  /** The exact inverse of {@link adoptAsManaged}: the project is a host project again, at the directory it
   *  came from. Refused for a project that was never adopted, so this can never blank a path it does not
   *  own, and for one whose deletion is pending — the runtime teardown that owns that row would otherwise
   *  finish on a project this had already handed back to the host. The caller refuses it once the sandbox
   *  has taken the directory, which is a fact about the environment rather than about this row. */
  releaseAdopted(id: number): Project {
    return withWriteLock(this.db, () => {
      const current = this.get(id);
      if (!current) throw new Error('project not found');
      if (current.executionKind !== 'managed' || current.adoptedPath === null) throw new Error(PROJECT_NOT_ADOPTED);
      if (current.lifecycle !== 'active') throw new Error('project deletion is pending');
      const changed = this.db.prepare('UPDATE projects SET execution_kind=\'host\', path=adopted_path, adopted_path=NULL WHERE id=? AND execution_kind=\'managed\' AND adopted_path IS NOT NULL').run(id).changes;
      if (!changed) throw new Error('project changed while its adoption was being released');
      return this.get(id)!;
    });
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
