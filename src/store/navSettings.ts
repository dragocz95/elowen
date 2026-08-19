/** Per-user layout of the primary (left) navigation, persisted as a single JSON blob under the
 *  `user_settings` key `nav`. Both fields address entries by their navigation id, so the layout
 *  survives label translation and route changes.
 *
 *  Only the "worlds" section is customizable; the system section (account/settings/users) is deliberately
 *  not addressable here, so a user can never hide their own way back into settings.
 *
 *  An id that matches no current entry is KEPT rather than dropped: a plugin world disappears from the
 *  listing while its plugin is disabled, and discarding its position would silently reset the user's
 *  arrangement every time they toggled a plugin. Resolution against the live entries happens in the web
 *  layer, which simply ignores ids it cannot see. */

export interface NavSettings {
  /** Ids the user hid. Hidden entries stay reachable by direct URL and through the command palette. */
  hidden: string[];
  /** Preferred order, by id. Ids missing from this list keep their registry order, after the listed ones. */
  order: string[];
}

export const NAV_DEFAULTS: NavSettings = { hidden: [], order: [] };

/** Upper bounds on a blob that is entirely user-supplied. The list is a navigation menu, not a data
 *  store: a few dozen entries is already far past what fits on screen. */
const MAX_ENTRIES = 64;
const MAX_ID_LENGTH = 64;

/** Validate one id list: strings only, trimmed, non-empty, deduplicated, and bounded in both directions.
 *  Order is preserved because for `order` it IS the meaning. */
function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (ids.length >= MAX_ENTRIES) break;
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (!id || id.length > MAX_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Re-validate a stored or incoming blob. A corrupt, partial or absent value degrades to the defaults,
 *  which reproduce the pre-feature navigation exactly. */
export function sanitizeNavSettings(value: unknown): NavSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...NAV_DEFAULTS };
  const partial = value as Partial<Record<keyof NavSettings, unknown>>;
  return { hidden: idList(partial.hidden), order: idList(partial.order) };
}

/** Apply a patch: a present field replaces the stored list wholesale, because both lists are ordered
 *  sets whose meaning is positional — merging them element-wise would produce an arrangement the user
 *  never asked for. An absent field is left untouched. */
export function mergeNavSettings(current: NavSettings, patch: unknown): NavSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ...current };
  const partial = patch as Partial<Record<keyof NavSettings, unknown>>;
  return {
    hidden: partial.hidden === undefined ? [...current.hidden] : idList(partial.hidden),
    order: partial.order === undefined ? [...current.order] : idList(partial.order),
  };
}
