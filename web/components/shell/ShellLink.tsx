'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentProps } from 'react';
import { announceLocation, hrefPathname } from '../../lib/sameDocumentNavigation';

/** A destination in the SHELL's own navigation — a sidebar row, a sub-item, an entry of the instance
 *  menu, the identity in the top bar.
 *
 *  It is an ordinary `next/link` with ONE decision added, stated here once for every door the shell
 *  offers: a navigation to the pathname the document is already on does not go through the router. It
 *  rewrites the address instead (see lib/sameDocumentNavigation.ts), which is what the page on screen
 *  already listens to.
 *
 *  Without that, `/settings` and `/account` — the two routes presented as intercepted page overlays —
 *  answer a section row clicked ON their own canonical page with a second copy of themselves in an
 *  overlay above it. The decision is about the DOCUMENT, not about those two routes, so no component
 *  has to recognize a pathname by name and none of them can start disagreeing about which routes are
 *  intercepted.
 *
 *  A modified click (new tab, new window, download) and one a caller has already handled are left to the
 *  browser: this changes how the shell moves, not what its links are. */
export function ShellLink({ href, onClick, ...props }: Omit<ComponentProps<typeof Link>, 'href'> & { href: string }) {
  const pathname = usePathname();
  return (
    <Link
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (hrefPathname(href) !== pathname) return;
        event.preventDefault();
        announceLocation(href);
      }}
    />
  );
}
