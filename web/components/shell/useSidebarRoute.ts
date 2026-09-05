'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { entryIsActive, type NavEntry } from './navEntry';
import { subMenuPages } from './navGroups';

/** WHERE THE READER IS, answered once for the whole column.
 *
 *  Two questions are asked of every route and they are not the same one: which SECTION the reader is
 *  inside (the row that paints as the current place, and the sub-menu that has to be open to show it) and
 *  which exact PAGE they are standing on (the single row that carries `aria-current="page"`). Deriving
 *  both here, from the route alone, is what keeps them from disagreeing — a highlight computed in the row
 *  and an open sub-menu computed in the group is how a menu ends up pointing at two places at once.
 *
 *  A page of a configuration deck is addressed as `/settings?cat=<section>`, so the answer cannot come
 *  from the pathname alone; a fragment is treated the same way, for an entry that addresses an anchor. */

/** The addressable parts of a nav href. A bare path carries neither of the other two. */
interface HrefParts {
  path: string;
  /** The deck section, `?cat=` — the one query parameter navigation addresses a page by. Every other
   *  parameter (`?row=`, a filter, a token) is state within a page and must not split it into two rows. */
  cat: string | null;
  hash: string | null;
}

function parseHref(href: string): HrefParts {
  const [beforeHash = '', hash = ''] = href.split('#');
  const [path = '', query = ''] = beforeHash.split('?');
  const cat = query ? new URLSearchParams(query).get('cat') : null;
  return { path, cat, hash: hash === '' ? null : hash };
}

function pathContains(route: string, pathname: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

/** How well an href describes the location — higher is more specific, 0 is no match at all.
 *
 *  The score is the path's own length plus a large constant per addressing part the href actually names
 *  and the location confirms. That ordering matters: `/settings?cat=models` must beat plain `/settings`
 *  while the reader is on the models section, and `/settings` must still win over nothing once they are
 *  on a section no row names. */
export function hrefMatchScore(href: string, pathname: string, search: string, hash = ''): number {
  const target = parseHref(href);
  if (!pathContains(target.path, pathname)) return 0;
  if (target.cat !== null) {
    const current = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('cat');
    if (current !== target.cat) return 0;
  }
  if (target.hash !== null && target.hash !== (hash.startsWith('#') ? hash.slice(1) : hash)) return 0;
  const specificity = (target.cat === null ? 0 : 1000) + (target.hash === null ? 0 : 1000);
  return specificity + target.path.length + (pathname === target.path ? 1 : 0);
}

export interface SidebarRoute {
  /** The entry the reader is inside. Its row paints as the current place. */
  activeId?: string;
  /** The one href in the column that IS the current page. */
  currentHref?: string;
  /** The entry whose sub-menu the route forces open, so the current page is never hidden inside a fold. */
  openId?: string;
}

/** Pure so the rule can be tested against a route rather than against a rendered column. */
export function resolveSidebarRoute(
  entries: readonly NavEntry[],
  pathname: string,
  search = '',
  hash = '',
): SidebarRoute {
  const active = entries.find((entry) => entryIsActive(entry, pathname));
  if (!active) return {};
  const candidates = [
    ...(active.href === undefined ? [] : [active.href]),
    ...(active.subItems ?? []).map((page) => page.href),
  ];
  let currentHref: string | undefined;
  let best = 0;
  for (const href of candidates) {
    const score = hrefMatchScore(href, pathname, search, hash);
    if (score > best) { best = score; currentHref = href; }
  }
  const route: SidebarRoute = { activeId: active.id };
  if (currentHref !== undefined) route.currentHref = currentHref;
  if (subMenuPages(active) && active.id !== undefined) route.openId = active.id;
  return route;
}

/** The live query string and fragment.
 *
 *  `useSearchParams` is the client navigation's answer and the only one that updates when a deck row
 *  pushes `?cat=`. It reads EMPTY on a statically optimized route until that first client navigation,
 *  which is why the document's own URL is read once on mount as well — the same pair `lib/useRowAnchor.ts`
 *  reads, for the same reason. The mount read is dropped as soon as the router has an answer of its own,
 *  so it can never pin the column to the address the tab was opened at. */
function useLocation(): { search: string; hash: string } {
  const searchParams = useSearchParams();
  const routerSearch = searchParams.toString();
  const pathname = usePathname();
  const [initial, setInitial] = useState<{ search: string; hash: string }>({ search: '', hash: '' });
  useEffect(() => {
    setInitial({ search: window.location.search, hash: window.location.hash });
  }, [pathname]);
  return {
    search: routerSearch === '' ? initial.search : routerSearch,
    hash: initial.hash,
  };
}

export function useSidebarRoute(entries: readonly NavEntry[]): SidebarRoute {
  const pathname = usePathname();
  const { search, hash } = useLocation();
  return useMemo(() => resolveSidebarRoute(entries, pathname, search, hash), [entries, pathname, search, hash]);
}
