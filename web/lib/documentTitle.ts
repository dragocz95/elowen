/** How the browser tab is named, for every route the app serves.
 *
 *  The name of a page is NOT a second list maintained next to the menu: it is read off the navigation
 *  model the shell already builds (`useShellNavigation`), so a core world, a plugin world and a plugin's
 *  own pages are titled by exactly the label the menu shows for them — in the reader's own language, and
 *  without a page list here that rots the moment a page is added or a plugin is enabled.
 *
 *  A page the navigation names nowhere (a non-admin landing on /settings, a plugin missing from the
 *  listing) falls back to the title the page publishes into the masthead, and finally to the bare
 *  product name. */

import type { NavEntry } from '../components/shell/navEntry';

/** The one separator between the product name and the page name. Shared so no surface invents its own. */
const TITLE_SEPARATOR = ' — ';

/** "<Product> — <Page>", or the bare product name when the page has no name of its own. */
export function formatDocumentTitle(appName: string, page?: string): string {
  return page ? `${appName}${TITLE_SEPARATOR}${page}` : appName;
}

/** Every address the navigation knows a name for. An entry answers for its own href, for the routes it
 *  declares itself active on (a plugin world's base, so any page under it still carries the world's
 *  name), and for each of its sub-pages. Sub-pages come first so that a tie on length — a world whose
 *  href IS its first page — resolves to the more specific of the two. */
function namedRoutes(entries: readonly NavEntry[]): { route: string; label: string }[] {
  return entries.flatMap((entry) => [
    ...(entry.subItems ?? []).map((sub) => ({ route: sub.href, label: sub.label })),
    ...(entry.href ? [{ route: entry.href, label: entry.label }] : []),
    ...(entry.activeRoutes ?? []).map((route) => ({ route, label: entry.label })),
  ]);
}

function routeMatches(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

/** The navigation's own name for this address: the LONGEST matching route wins, so a plugin's page
 *  (/p/work/kanban) is named by that page and a detail view beneath it (/p/work/tasks/12) inherits the
 *  page it belongs to rather than the world's base. */
export function navPageTitle(entries: readonly NavEntry[], pathname: string): string | undefined {
  let best: { route: string; label: string } | undefined;
  for (const candidate of namedRoutes(entries)) {
    if (!routeMatches(pathname, candidate.route)) continue;
    if (!best || candidate.route.length > best.route.length) best = candidate;
  }
  return best?.label;
}

export function resolveDocumentTitle({ appName, pathname, entries, headerTitle }: {
  appName: string;
  pathname: string;
  entries: readonly NavEntry[];
  headerTitle?: string;
}): string {
  const page = navPageTitle(entries, pathname) ?? (headerTitle?.trim() || undefined);
  return formatDocumentTitle(appName, page);
}
