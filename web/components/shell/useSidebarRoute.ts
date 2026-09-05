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

/** The live query string and fragment, from the two sources that each see half the truth.
 *
 *  `useSearchParams` is the ROUTER's answer. It is immediate on a client navigation — which is what a
 *  sub-item click is — but it reads empty on a statically optimized route until that first navigation,
 *  and it never learns about a section a deck page switches to itself: those rewrite the address with
 *  `history.replaceState` and announce it with a synthetic `popstate`, which the router does not observe.
 *
 *  The ADDRESS BAR is the other source. It is read on mount, on every arrival, and on every `popstate`,
 *  and while it holds an answer it wins — it is the document's actual URL. The router's answer takes over
 *  again the moment it changes, so a stale reading can never pin the column to an address the reader has
 *  already left. This is the same pair `lib/useRowAnchor.ts` reads, for the same reason. */
function useLocation(): { search: string; hash: string } {
  const searchParams = useSearchParams();
  const routerSearch = searchParams.toString();
  const pathname = usePathname();
  // The reading carries the route it was taken on. An effect cannot run before the render that follows a
  // navigation, so without that stamp the column would paint one frame of the previous section every time
  // a sub-item is clicked; with it, a reading the router has already overtaken is simply not used.
  const route = `${pathname}?${routerSearch}`;
  const [address, setAddress] = useState<{ search: string; hash: string; route: string } | null>(null);
  useEffect(() => {
    const read = () => setAddress({ search: window.location.search.replace(/^\?/, ''), hash: window.location.hash, route });
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, [route]);
  const current = address !== null && address.route === route ? address : null;
  return {
    search: current?.search ?? routerSearch,
    hash: current?.hash ?? '',
  };
}

export function useSidebarRoute(entries: readonly NavEntry[]): SidebarRoute {
  const pathname = usePathname();
  const { search, hash } = useLocation();
  return useMemo(() => resolveSidebarRoute(entries, pathname, search, hash), [entries, pathname, search, hash]);
}
