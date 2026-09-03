import type { Db } from './db.js';
import type { MemoryCategoryRow } from '../shared/wireContract.js';
import { SHARED_CATEGORY_USER_ID, isSharer, sharedCategoryIds } from './sharedMemoryAccess.js';

// The category row shape is the daemon↔web wire contract (served over /memory/categories) — defined
// once in src/shared and re-exported here, so a field added on the daemon can never be missing on the web.
export type { MemoryCategoryRow };

/** The server source of truth for category icons — 24 lucide names shared with the web client. Any icon
 *  written to a category is clamped to one of these; the default/fallback is 'Folder'. */
export const ICON_ALLOWLIST = [
  'Briefcase', 'Server', 'Database', 'Heart', 'Code', 'Home', 'Star', 'Folder', 'Globe', 'Book',
  'Cpu', 'Terminal', 'Rocket', 'Lightbulb', 'Target', 'Calendar', 'DollarSign', 'ShoppingCart',
  'Music', 'Camera', 'MapPin', 'Zap', 'Flag', 'Bookmark',
] as const;

export const DEFAULT_ICON = 'Folder';

/** Coerce an arbitrary icon string to a KNOWN allowlist name, falling back to 'Folder'. Used on every
 *  create/update so a foreign name (or a model-suggested one) can never land in the DB. */
function clampIcon(icon: string | null | undefined): string {
  return icon && (ICON_ALLOWLIST as readonly string[]).includes(icon) ? icon : DEFAULT_ICON;
}

// A user-scoped memory category. name is the label; description is the LLM-facing guide the
// categorizer classifies against; color is an optional UI hint; icon is a lucide name from
// ICON_ALLOWLIST; is_builtin marks seeded ones. The row shape is the shared wire contract
// (re-exported above).

export interface CategoryInput { name: string; description?: string; color?: string; icon?: string; isBuiltin?: boolean; projectId?: number | null }
export interface CategoryPatch { name?: string; description?: string; color?: string; icon?: string; projectId?: number | null }

type MemoryCategoryDbRow = Omit<MemoryCategoryRow, 'projectId'> & { project_id: number | null };

function toCategory(row: MemoryCategoryDbRow): MemoryCategoryRow {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    description: row.description,
    color: row.color,
    icon: row.icon,
    is_builtin: row.is_builtin,
    projectId: row.project_id,
    created_at: row.created_at,
  };
}

/** Stable semantic identity for one category generation. A delete/recreate that happens to reuse SQLite's
 * numeric id must not validate a model decision made against the deleted category. */
export function memoryCategoryFingerprint(row: MemoryCategoryRow): string {
  return JSON.stringify([
    row.id, row.user_id, row.name, row.description, row.color, row.icon,
    row.is_builtin, row.projectId, row.created_at,
  ]);
}

/** Persistence for per-user memory categories. Every read/write is filtered by user_id. A null projectId
 *  is global; a non-null value is a stable project binding. Category CRUD is UNaudited (per spec); a
 *  memory's category change is audited by MemoryStore.setCategory. */
export class MemoryCategoryStore {
  constructor(private db: Db) {}

  /** All of this user's categories, name-sorted (case-insensitive). */
  list(userId: number): MemoryCategoryRow[] {
    const rows = this.db.prepare(
      'SELECT * FROM memory_categories WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC'
    ).all(userId) as MemoryCategoryDbRow[];
    return rows.map(toCategory);
  }

  /** Read one category owned by this user. */
  get(userId: number, id: number): MemoryCategoryRow | undefined {
    const row = this.db.prepare('SELECT * FROM memory_categories WHERE id = ? AND user_id = ?')
      .get(id, userId) as MemoryCategoryDbRow | undefined;
    return row ? toCategory(row) : undefined;
  }

  /** Insert a category and return the full row. Unique violations propagate so routes can map them to 409. */
  create(userId: number, input: CategoryInput): MemoryCategoryRow {
    const info = this.db.prepare(
      `INSERT INTO memory_categories (user_id, name, description, color, icon, is_builtin, project_id)
       VALUES (@user_id, @name, @description, @color, @icon, @is_builtin, @project_id)`
    ).run({
      user_id: userId,
      name: input.name,
      description: input.description ?? '',
      color: input.color ?? '',
      icon: clampIcon(input.icon),
      is_builtin: input.isBuiltin ? 1 : 0,
      project_id: input.projectId ?? null,
    });
    const category = this.get(userId, Number(info.lastInsertRowid));
    if (!category) throw new Error('created memory category missing');
    return category;
  }

  /** Owner-scoped patch of only the provided fields. Returns undefined if the category doesn't exist for
   *  this user. A unique collision throws → route → 409. */
  update(userId: number, id: number, patch: CategoryPatch): MemoryCategoryRow | undefined {
    const before = this.get(userId, id);
    if (!before) return undefined;
    const sets: string[] = [];
    const params: Record<string, string | number | null> = { id, user_id: userId };
    if (patch.name !== undefined) { sets.push('name = @name'); params.name = patch.name; }
    if (patch.description !== undefined) { sets.push('description = @description'); params.description = patch.description; }
    if (patch.color !== undefined) { sets.push('color = @color'); params.color = patch.color; }
    if (patch.icon !== undefined) { sets.push('icon = @icon'); params.icon = clampIcon(patch.icon); }
    if (patch.projectId !== undefined) { sets.push('project_id = @project_id'); params.project_id = patch.projectId; }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE memory_categories SET ${sets.join(', ')} WHERE id = @id AND user_id = @user_id`).run(params);
    }
    return this.get(userId, id);
  }

  /** Delete a category and clear it off referencing memories. Atomic: (a) null out memories.category_id
   *  for this user's rows pointing at it (bumping updated_at, no per-row audit — bulk), (b) delete the
   *  category. Returns false if the category doesn't exist for this user. */
  delete(userId: number, id: number): boolean {
    return this.db.transaction(() => {
      if (!this.get(userId, id)) return false;
      this.db.prepare(
        "UPDATE memories SET category_id = NULL, updated_at = datetime('now') WHERE user_id = ? AND category_id = ?"
      ).run(userId, id);
      this.db.prepare('DELETE FROM memory_categories WHERE id = ? AND user_id = ?').run(id, userId);
      return true;
    })();
  }

  /** Hard-delete all of this user's categories (user-delete cleanup; mirrors MemoryStore.removeForUser). */
  removeForUser(userId: number): void {
    this.db.prepare('DELETE FROM memory_categories WHERE user_id = ?').run(userId);
  }

  // --- Shared project memory pools. A shared category is a row with user_id = SHARED_CATEGORY_USER_ID
  // (0) and a project binding; memories inside it keep their author's real user_id. Members READ and
  // WRITE these rows through the dedicated methods below — the owner-scoped CRUD above never sees them. ---

  /** The shared category of `project`, for a user who shares it — created on first use, named
   *  `<slug> (shared)`. NULL when the user is not a sharer or the project has sharing off: callers use
   *  this both as the access gate and as the lazy factory (a non-sharer must never see, let alone create,
   *  the pool). One row per project is guaranteed by the existing partial unique index on
   *  (user_id, project_id) WHERE project_id IS NOT NULL — user_id is pinned to the shared sentinel. */
  sharedForProject(userId: number, project: { id: number; slug: string }): MemoryCategoryRow | null {
    if (!isSharer(this.db, userId, project.id)) return null;
    const existing = this.db.prepare(
      'SELECT * FROM memory_categories WHERE user_id = ? AND project_id = ?',
    ).get(SHARED_CATEGORY_USER_ID, project.id) as MemoryCategoryDbRow | undefined;
    if (existing) return toCategory(existing);
    try {
      return this.create(SHARED_CATEGORY_USER_ID, { name: `${project.slug} (shared)`, projectId: project.id });
    } catch {
      // A concurrent first shared write lost the UNIQUE(user_id, project_id) race — re-read the winner.
      const concurrent = this.db.prepare(
        'SELECT * FROM memory_categories WHERE user_id = ? AND project_id = ?',
      ).get(SHARED_CATEGORY_USER_ID, project.id) as MemoryCategoryDbRow | undefined;
      if (!concurrent) throw new Error('shared memory category missing after create');
      return toCategory(concurrent);
    }
  }

  /** Every shared category this user may touch (their own share lists, one per shared project). The
   *  sharer predicate lives in ONE place — sharedCategoryIds() — so a fix to the access rule can never
   *  land in one copy and miss the other; this only adds display fields and the sort order. */
  listShared(userId: number): MemoryCategoryRow[] {
    const ids = sharedCategoryIds(this.db, userId);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT * FROM memory_categories WHERE id IN (${placeholders}) ORDER BY name COLLATE NOCASE ASC`,
    ).all(...ids) as MemoryCategoryDbRow[];
    return rows.map(toCategory);
  }

  /** Shared pool category ids only (no display fields) — the widening set for the read queries. */
  listSharedIds(userId: number): number[] {
    return sharedCategoryIds(this.db, userId);
  }

  /** Read one shared category by id, regardless of who asks (route-level gating decides WHO may act). */
  getShared(id: number): MemoryCategoryRow | undefined {
    const row = this.db.prepare('SELECT * FROM memory_categories WHERE id = ? AND user_id = ?')
      .get(id, SHARED_CATEGORY_USER_ID) as MemoryCategoryDbRow | undefined;
    return row ? toCategory(row) : undefined;
  }

  /** Admin-side patch of a shared category's display/classification fields. The project binding is
   *  deliberately NOT patchable — a pool belongs to its project for its whole life. */
  updateShared(id: number, patch: { name?: string; description?: string; color?: string; icon?: string }): MemoryCategoryRow | undefined {
    const before = this.getShared(id);
    if (!before) return undefined;
    const sets: string[] = [];
    const params: Record<string, string | number> = { id, user_id: SHARED_CATEGORY_USER_ID };
    if (patch.name !== undefined) { sets.push('name = @name'); params.name = patch.name; }
    if (patch.description !== undefined) { sets.push('description = @description'); params.description = patch.description; }
    if (patch.color !== undefined) { sets.push('color = @color'); params.color = patch.color; }
    if (patch.icon !== undefined) { sets.push('icon = @icon'); params.icon = clampIcon(patch.icon); }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE memory_categories SET ${sets.join(', ')} WHERE id = @id AND user_id = @user_id`).run(params);
    }
    return this.getShared(id);
  }

  /** Delete a shared category and clear it off EVERY author's memories referencing it. The owner-scoped
   *  {@link delete} nulls `WHERE user_id = ? AND category_id = ?` — run with the admin's id it would
   *  clear nothing (the category carries user_id = 0) and leave dangling references on other authors'
   *  rows, so shared pools get this dedicated path instead. */
  deleteShared(id: number): boolean {
    return this.db.transaction(() => {
      if (!this.getShared(id)) return false;
      this.db.prepare(
        "UPDATE memories SET category_id = NULL, updated_at = datetime('now') WHERE category_id = ?",
      ).run(id);
      this.db.prepare('DELETE FROM memory_categories WHERE id = ? AND user_id = ?').run(id, SHARED_CATEGORY_USER_ID);
      return true;
    })();
  }

  /** Drop a user's rows from every share list (user-delete cleanup). The pools themselves survive. */
  removeShareMembership(userId: number): void {
    this.db.prepare('DELETE FROM project_memory_members WHERE user_id = ?').run(userId);
  }
}
