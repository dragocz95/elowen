import type { Db } from './db.js';
import { deleteTasksAndDeps } from './cascade.js';

export interface Project { id: number; slug: string; path: string; notes: string }

export class ProjectStore {
  constructor(private db: Db) {}
  create(p: { slug: string; path: string; notes?: string }): Project {
    const info = this.db.prepare('INSERT INTO projects (slug, path, notes) VALUES (?, ?, ?)').run(p.slug, p.path, p.notes ?? '');
    return this.get(Number(info.lastInsertRowid))!;
  }
  list(): Project[] { return this.db.prepare('SELECT * FROM projects ORDER BY id').all() as Project[]; }
  get(id: number): Project | null { return (this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined) ?? null; }
  /** Update a project's path and/or Pilot notes. The slug is the stable identifier and stays immutable. */
  update(id: number, patch: { path?: string; notes?: string }): Project | null {
    const cur = this.get(id);
    if (!cur) return null;
    const path = patch.path ?? cur.path;
    const notes = patch.notes ?? cur.notes;
    this.db.prepare('UPDATE projects SET path = ?, notes = ? WHERE id = ?').run(path, notes, id);
    return this.get(id);
  }

  /** Remove a project from the registry and everything scoped to it: its tasks (+ their deps and any
   *  missions driving them), its agents, and every user's access grant. The schema has no FK cascade,
   *  so the order is explicit and the whole thing runs in one transaction. The on-disk files at
   *  `project.path` are NEVER touched — this only detaches the project from orca. */
  remove(id: number): boolean {
    if (!this.get(id)) return false;
    this.db.transaction(() => {
      // Tasks + their missions and dep edges go through the shared cascade; the agents, access
      // grants and the project row itself are project-only and stay here.
      deleteTasksAndDeps(this.db, 'project', id);
      this.db.prepare('DELETE FROM agents WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM user_projects WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    })();
    return true;
  }
}
