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

/** Read a layout that came from outside the app (the browser's own cache of the last known one). Anything
 *  that is not two lists of ids is rejected outright rather than partially trusted — the menu falls back
 *  to registry order, which is always safe. */
export function parseNavLayout(raw: unknown): NavLayout | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { hidden, order } = raw as { hidden?: unknown; order?: unknown };
  const ids = (value: unknown): string[] | null =>
    Array.isArray(value) && value.every((id) => typeof id === 'string') ? (value as string[]) : null;
  const hiddenIds = ids(hidden);
  const orderIds = ids(order);
  return hiddenIds && orderIds ? { hidden: hiddenIds, order: orderIds } : null;
}

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

/** Drop one entry at a position in the VISIBLE menu — what dragging a row commits. Like `moveNavEntry`
 *  it only rewrites the slots visible entries already occupy, so hidden entries keep their place and
 *  come back where the user left them. `toIndex` is clamped, so a drag past either end simply parks the
 *  entry at that end. */
export function reorderNavEntry(layout: NavLayout, entryIds: string[], id: string, toIndex: number): NavLayout {
  const order = normalizeNavOrder(layout.order, entryIds);
  const hidden = new Set(layout.hidden);
  const isVisible = (entryId: string) => !hidden.has(entryId) && entryIds.includes(entryId);
  const visible = order.filter(isVisible);

  const from = visible.indexOf(id);
  const to = Math.max(0, Math.min(visible.length - 1, toIndex));
  if (from < 0 || from === to) return { ...layout, order };

  const resequenced = [...visible];
  resequenced.splice(from, 1);
  resequenced.splice(to, 0, id);

  const next = [...order];
  let slot = 0;
  for (let index = 0; index < next.length; index++) {
    if (isVisible(next[index])) next[index] = resequenced[slot++];
  }
  return { ...layout, order: next };
}

/** Hide or show one entry. Hiding records the id; showing removes it.
 *
 *  The order is deliberately left ALONE. Hiding says nothing about arrangement, and writing an order out
 *  of a hide would commit the menu to one — which on a surface that sorts by its own rule (the rail's
 *  spatial axis) re-sorts every remaining entry the first time anything is hidden. An untouched order
 *  keeps every surface free to arrange itself as it always did. */
export function setNavEntryHidden(layout: NavLayout, id: string, hidden: boolean): NavLayout {
  const next = layout.hidden.filter((entryId) => entryId !== id);
  return { hidden: hidden ? [...next, id] : next, order: layout.order };
}
