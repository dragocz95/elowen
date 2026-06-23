import type { Db } from './db.js';
import { deleteTasksAndDeps } from './cascade.js';

export interface Project { id: number; slug: string; path: string; notes: string; icon: string }

export class ProjectStore {
  constructor(private db: Db) {}
  create(p: { slug: string; path: string; notes?: string }): Project {
    const info = this.db.prepare('INSERT INTO projects (slug, path, notes) VALUES (?, ?, ?)').run(p.slug, p.path, p.notes ?? '');
    return this.get(Number(info.lastInsertRowid))!;
  }
  list(): Project[] { return this.db.prepare('SELECT * FROM projects ORDER BY id').all() as Project[]; }
  get(id: number): Project | null { return (this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined) ?? null; }
  /** Update a project's path, Pilot notes and/or icon. The slug is the stable identifier and stays
   *  immutable. `icon` is a project-relative image path (or '' to clear it back to the default glyph). */
  update(id: number, patch: { path?: string; notes?: string; icon?: string }): Project | null {
    const cur = this.get(id);
    if (!cur) return null;
    const path = patch.path ?? cur.path;
    const notes = patch.notes ?? cur.notes;
    const icon = patch.icon ?? cur.icon;
    this.db.prepare('UPDATE projects SET path = ?, notes = ?, icon = ? WHERE id = ?').run(path, notes, icon, id);
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
