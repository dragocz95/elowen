'use client';

/** WHERE CLOSING A PAGE OVERLAY GOES.
 *
 *  `/settings` and `/account` are pages presented as overlays, so closing one means leaving the address
 *  rather than dismissing a dialog: the reader goes back to the surface they opened it from. That is a
 *  history step, and history is exactly what a cold load does not have — open `/settings` in a fresh tab
 *  and `history.back()` either does nothing at all or hands the reader to whatever was in the tab before
 *  the app. The first leaves the close control looking broken; the second leaves the app entirely.
 *
 *  So the close asks whether this document has navigated ANYWHERE since it loaded. If it has, there is a
 *  surface of this app's behind the current entry and stepping back returns to it; if it has not, the
 *  overlay IS the arrival and the reader is sent to a real page instead.
 *
 *  It is a counter rather than a flag on `history.state`: the router owns that object and the decks
 *  rewrite it on every section change (`lib/sameDocumentNavigation.ts`), so a marker inside it would be
 *  one more thing that has to survive every one of those rewrites. And it is a counter rather than a
 *  comparison of `history.length`, which cannot tell this app's entries from the ones the tab already had. */

/** How many client navigations this document has made. Zero means the reader is still standing on the
 *  address the document loaded with. */
let navigations = 0;

/** Record one client navigation. Called by the shell whenever the route changes — never for a same-page
 *  address rewrite, which does not add an entry to step back to. */
export function noteAppNavigation(): void {
  navigations += 1;
}

/** Whether closing can step back into this app instead of out of it. */
export function hasAppHistoryBehind(): boolean {
  return navigations > 0;
}

/** Where a page overlay closes to when there is nothing behind it. The app's own landing route rather
 *  than `/`, which only redirects here and would cost the reader a second navigation to watch. */
export const PAGE_OVERLAY_FALLBACK_ROUTE = '/dash';
