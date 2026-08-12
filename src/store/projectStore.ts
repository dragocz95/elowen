import { tolerateMissingPluginTables } from './db.js';
import type { Db } from './db.js';
import { deleteTasksAndDeps } from './cascade.js';

/** `pr_enabled`: per-project GitHub PR-native override. null = inherit the global autopilot default;
 *  true/false = force the flow on/off for this project. */
export interface Project { id: number; slug: string; path: string; notes: string; icon: string; pr_enabled: boolean | null }

type ProjectRow = { id: number; slug: string; path: string; notes: string; icon: string; pr_enabled: number | null };
const toProject = (r: ProjectRow): Project => ({
  id: r.id, slug: r.slug, path: r.path, notes: r.notes ?? '', icon: r.icon ?? '',
  pr_enabled: r.pr_enabled == null ? null : !!r.pr_enabled,
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
  /** Update a project's path, Pilot notes, icon and/or PR-flow override. The slug is the stable
   *  identifier and stays immutable. `icon` is a project-relative image path (or '' to clear it back to
   *  the default glyph). `pr_enabled` is tri-state: pass `null` to inherit the global default, a boolean
   *  to force it; omit the key to leave it unchanged. */
  update(id: number, patch: { path?: string; notes?: string; icon?: string; pr_enabled?: boolean | null }): Project | null {
    const cur = this.get(id);
    if (!cur) return null;
    const path = patch.path ?? cur.path;
    const notes = patch.notes ?? cur.notes;
    const icon = patch.icon ?? cur.icon;
    const prEnabled = 'pr_enabled' in patch ? patch.pr_enabled : cur.pr_enabled;
    this.db.prepare('UPDATE projects SET path = ?, notes = ?, icon = ?, pr_enabled = ? WHERE id = ?')
      .run(path, notes, icon, prEnabled == null ? null : prEnabled ? 1 : 0, id);
    return this.get(id);
  }

  /** Remove a project from the registry and everything scoped to it: its tasks (+ their deps and any
   *  missions driving them), its agents, and every user's access grant. The schema has no FK cascade,
   *  so the order is explicit and the whole thing runs in one transaction. The on-disk files at
   *  `project.path` are NEVER touched — this only detaches the project from elowen. */
  remove(id: number): boolean {
    if (!this.get(id)) return false;
    this.db.transaction(() => {
      // Tasks + their missions and dep edges go through the shared cascade; the agents, access
      // grants and the project row itself are project-only and stay here.
      deleteTasksAndDeps(this.db, 'project', id);
      // `agents` is an AGENTS-PLUGIN table — purge when present (even with the plugin off), tolerate
      // a fresh install where the plugin never created it.
      tolerateMissingPluginTables(() => { this.db.prepare('DELETE FROM agents WHERE project_id = ?').run(id); }, undefined);
      this.db.prepare('DELETE FROM user_projects WHERE project_id = ?').run(id);
      // Project-scoped categories must disappear with the project. Their memories become uncategorized,
      // which keeps them fail-closed until a person explicitly files them again.
      this.db.prepare(
        "UPDATE memories SET category_id = NULL, updated_at = datetime('now') WHERE category_id IN (SELECT id FROM memory_categories WHERE project_id = ?)"
      ).run(id);
      this.db.prepare('DELETE FROM memory_categories WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    })();
    return true;
  }
}
