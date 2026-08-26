import type { Db } from './db.js';

export interface Project { id: number; slug: string; path: string; notes: string; icon: string }

type ProjectRow = Project;
const toProject = (r: ProjectRow): Project => ({
  id: r.id, slug: r.slug, path: r.path, notes: r.notes ?? '', icon: r.icon ?? '',
});

export class ProjectStore {
  constructor(private db: Db) {}
  create(p: { slug: string; path: string; notes?: string }): Project {
    const info = this.db.prepare('INSERT INTO projects (slug, path, notes) VALUES (?, ?, ?)').run(p.slug, p.path, p.notes ?? '');
    const project = this.get(Number(info.lastInsertRowid));
    if (!project) throw new Error('created project missing');
    return project;
  }
  list(): Project[] { return (this.db.prepare('SELECT * FROM projects ORDER BY id').all() as ProjectRow[]).map(toProject); }
  get(id: number): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return r ? toProject(r) : null;
  }
  /** Update a project's path, notes and/or icon. The slug is the stable identifier and stays immutable.
   *  `icon` is a project-relative image path (or '' to clear it back to the default glyph). */
  update(id: number, patch: { path?: string; notes?: string; icon?: string }): Project | null {
    const cur = this.get(id);
    if (!cur) return null;
    const path = patch.path ?? cur.path;
    const notes = patch.notes ?? cur.notes;
    const icon = patch.icon ?? cur.icon;
    this.db.prepare('UPDATE projects SET path = ?, notes = ?, icon = ? WHERE id = ?')
      .run(path, notes, icon, id);
    return this.get(id);
  }

  /** Remove a project from the core registry and its core-owned access/category rows. Plugin-owned state
   * is handled by registerProjectRemoved plus each plugin's boot reconciliation contract. */
  remove(id: number): boolean {
    if (!this.get(id)) return false;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM user_projects WHERE project_id = ?').run(id);
      this.db.prepare(
        "UPDATE memories SET category_id = NULL, updated_at = datetime('now') WHERE category_id IN (SELECT id FROM memory_categories WHERE project_id = ?)"
      ).run(id);
      this.db.prepare('DELETE FROM memory_categories WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    })();
    return true;
  }
}
