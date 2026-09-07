/** How the one navigation model is laid out down the sidebar: which rows sit in which labelled group,
 *  and which row is the trailing account item under the separator.
 *
 *  The grouping is a PRESENTATION rule over the model, not a second model. Every entry here is still the
 *  same customizable entry the layout addresses by id (`lib/navLayout.ts`) — hiding, restoring and
 *  reordering are untouched — only the region it is drawn in differs. That is deliberately the same
 *  arrangement the column had before, with the two named regions kept and a first, unlabelled block of
 *  landing destinations split off the front, which is how the reference dashboard opens its own menu.
 *
 *  It is a pure function so the partition is unit-testable without mounting a column. */
import type { NavEntry } from './navEntry';

/** The groups, in the order they are drawn. `primary` carries no label: it is where the reader lands,
 *  and a header over the first two rows of a menu names nothing the rows do not already say. */
export type SidebarGroupId = 'primary' | 'work' | 'instance';

const SIDEBAR_GROUP_ORDER: readonly SidebarGroupId[] = ['primary', 'work', 'instance'];

/** Where you arrive. Everything the app opens on, before any of the work. */
const PRIMARY_ENTRY_IDS = ['home', 'chat'];
/** Administering the instance rather than working in it — and what the instance has to say for itself:
 *  the release notes of the version it runs (the bundled changelog plugin) sit here, not among the work
 *  (owner decision, 7 Sep 2026). Everything else is admin-only. */
const INSTANCE_ENTRY_IDS = ['settings', 'users', 'plugin-changelog'];
/** The account, drawn last, directly under the block above it — the reference's "Manage account". It is
 *  an ordinary entry, so it is still hidden, restored and reordered like the rest; only its region is fixed. */
const ACCOUNT_ENTRY_ID = 'account';

interface SidebarGroup {
  readonly id: SidebarGroupId;
  readonly entries: readonly NavEntry[];
}

export interface SidebarLayout {
  /** The labelled groups, in draw order, with empty ones already dropped. */
  readonly groups: readonly SidebarGroup[];
  /** The account row, when the reader has not hidden it. */
  readonly account?: NavEntry;
}

function groupOf(entry: NavEntry): SidebarGroupId {
  if (entry.id !== undefined && PRIMARY_ENTRY_IDS.includes(entry.id)) return 'primary';
  if (entry.id !== undefined && INSTANCE_ENTRY_IDS.includes(entry.id)) return 'instance';
  // Plugin worlds and every core world that is not a landing page or an administration page. This is the
  // open end of the partition on purpose: a plugin installed tomorrow lands in the work group without
  // anything here having to learn its name.
  return 'work';
}

/** Partition the visible entries into the column's regions, preserving the user's own order inside each.
 *
 *  The sequence handed in is the one the reader is looking at, so a menu the user has rearranged keeps
 *  that arrangement within a group. Reordering ACROSS groups still writes the global order the layout
 *  stores; it simply cannot move a destination into the administration block, which is a region rather
 *  than a position. */
export function sidebarLayout(entries: readonly NavEntry[]): SidebarLayout {
  const buckets = new Map<SidebarGroupId, NavEntry[]>(SIDEBAR_GROUP_ORDER.map((id) => [id, []]));
  let account: NavEntry | undefined;
  for (const entry of entries) {
    if (entry.id === ACCOUNT_ENTRY_ID) { account = entry; continue; }
    buckets.get(groupOf(entry))!.push(entry);
  }
  const groups = SIDEBAR_GROUP_ORDER
    .map<SidebarGroup>((id) => ({ id, entries: buckets.get(id)! }))
    .filter((group) => group.entries.length > 0);
  return account ? { groups, account } : { groups };
}

/** The pages an entry contributes as an inline sub-menu, or null when it is a plain destination.
 *
 *  One sub-item is not a sub-menu: `projects` names its own single page, so a disclosure over one child
 *  repeating the parent's label discloses nothing. Two or more is a real sub-menu, and then EVERY page
 *  goes inside it — including the one the entry's own `href` points at, which is why the parent is a
 *  disclosure button rather than a link. Splitting the first page onto the parent is what would make it
 *  reachable only by guessing. */
export function subMenuPages(entry: NavEntry): NavEntry['subItems'] | null {
  return entry.subItems && entry.subItems.length > 1 ? entry.subItems : null;
}
