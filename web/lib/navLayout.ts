/** Resolution of the user's saved navigation layout against the entries the shell can actually show.
 *
 *  The daemon stores the layout as two id lists and never interprets them (see `src/store/navSettings.ts`).
 *  All the meaning lives here: which entries are hidden, in what order the rest appears, and what a single
 *  "move up" or "hide" does to the stored lists.
 *
 *  Two rules shape everything below:
 *  - An id that matches no current entry is CARRIED, never dropped. A plugin world vanishes from the
 *    listing while its plugin is disabled, and forgetting its position would silently reshuffle the menu
 *    every time a plugin was toggled.
 *  - A new entry (a freshly enabled plugin) appears at the END of the menu rather than at a position
 *    nobody chose for it. */

import type { NavLayout } from './types';

export const EMPTY_NAV_LAYOUT: NavLayout = { hidden: [], order: [] };

/** Order entries by the saved arrangement and drop the hidden ones. Entries the layout says nothing about
 *  keep their registry order, after everything it does place. */
export function applyNavLayout<T extends { id?: string }>(entries: T[], layout: NavLayout): T[] {
  const hidden = new Set(layout.hidden);
  const rank = new Map(layout.order.map((id, index) => [id, index] as const));
  // An entry without an id cannot be addressed by the layout, so it can never be hidden or ranked and
  // simply keeps its registry position.
  return entries
    .filter((entry) => !(entry.id && hidden.has(entry.id)))
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const rankA = a.entry.id === undefined ? undefined : rank.get(a.entry.id);
      const rankB = b.entry.id === undefined ? undefined : rank.get(b.entry.id);
      if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
      if (rankA !== undefined) return -1;
      if (rankB !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

/** The entries the user hid, in menu order — what the "show hidden" modal lists and counts. */
export function hiddenNavEntries<T extends { id?: string }>(entries: T[], layout: NavLayout): T[] {
  const hidden = new Set(layout.hidden);
  return entries.filter((entry) => !!entry.id && hidden.has(entry.id));
}

/** Bring the stored order up to date with the entries that exist now: unknown ids keep their position,
 *  entries the order has never seen are appended. Editing operations run against this form, so both the
 *  moved entry and its neighbour are guaranteed to be present. */
export function normalizeNavOrder(order: string[], entryIds: string[]): string[] {
  const placed = new Set(order);
  return [...order, ...entryIds.filter((id) => !placed.has(id))];
}

/** Move one entry past its neighbour in the VISIBLE menu. The two ids swap positions in the stored order,
 *  which leaves hidden entries sitting where they are — unhiding one later restores it to the place the
 *  user last put it, instead of dragging it along with a move it was not part of.
 *
 *  Returns the order unchanged when the entry is already at that end. */
export function moveNavEntry(layout: NavLayout, entryIds: string[], id: string, delta: -1 | 1): NavLayout {
  const order = normalizeNavOrder(layout.order, entryIds);
  const hidden = new Set(layout.hidden);
  const visible = order.filter((entryId) => !hidden.has(entryId) && entryIds.includes(entryId));

  const position = visible.indexOf(id);
  const neighbour = position < 0 ? undefined : visible[position + delta];
  if (neighbour === undefined) return { ...layout, order };

  const from = order.indexOf(id);
  const to = order.indexOf(neighbour);
  const next = [...order];
  next[from] = neighbour;
  next[to] = id;
  return { ...layout, order: next };
}

/** Hide or show one entry. Hiding records the id; showing removes it. The order is normalized either way,
 *  so an entry that was never explicitly arranged still has a defined position afterwards. */
export function setNavEntryHidden(layout: NavLayout, entryIds: string[], id: string, hidden: boolean): NavLayout {
  const order = normalizeNavOrder(layout.order, entryIds);
  const next = layout.hidden.filter((entryId) => entryId !== id);
  return { hidden: hidden ? [...next, id] : next, order };
}
