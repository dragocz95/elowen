/** MOVING WITHIN THE PAGE THE READER IS ALREADY ON.
 *
 *  `/settings` and `/account` are presented as page overlays (see `app/@pageOverlay`): a CLIENT
 *  navigation to either route is answered by the overlay, whatever surface it was made from — including
 *  the deck itself. So a row that only changes `?cat=` while the reader is already standing in the deck
 *  would not move the page in front of them; it would route to the address they are already on and put a
 *  fresh mount of the same deck there, losing the section state and the scroll they were reading.
 *
 *  The seam that does move it is the document's own address. A deck page reads `window.location` and
 *  follows `popstate` (modules/account/AccountView.tsx, modules/settings/SettingsView.tsx), the record
 *  anchor reads the same pair (lib/useRowAnchor.ts), and the sidebar highlight follows the announcement
 *  (components/shell/useSidebarRoute.ts). Rewriting the address here is therefore a complete navigation
 *  for everything that cares about it, and it never reaches the router — which is what keeps interception
 *  out of a move that does not leave the page. */

/** The path part of an app href: everything before `?` and `#`. An absolute or external URL keeps its
 *  origin and so never equals a pathname, which is the right answer for one. */
export function hrefPathname(href: string): string {
  const [beforeHash = ''] = href.split('#');
  const [path = ''] = beforeHash.split('?');
  return path;
}

/** Rewrite the address to `href` and announce it, without routing.
 *
 *  `replaceState`, not push: the target is the same page by another spelling, and the overlay these decks
 *  are usually presented in already treats a section that way — Back returns to the surface the deck was
 *  opened from instead of walking back through every section visited inside it.
 *
 *  Next's own history state is carried over rather than dropped: it holds the router tree, and a later
 *  back/forward restores from it. */
export function announceLocation(href: string): void {
  window.history.replaceState(window.history.state, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
