'use client';
import { usePathname } from 'next/navigation';
import { useBrand } from '../../lib/brand';
import { usePageHeader } from '../../lib/pageHeader';
import { resolveDocumentTitle } from '../../lib/documentTitle';
import { useShellNavigation } from './useShellNavigation';

/** The one place the browser tab is named, mounted once by the shell.
 *
 *  It keys off the pathname rather than off a route's `metadata` export: every surface here is client
 *  rendered and navigation happens without a document load, so a server-side title would be written once
 *  and never again. A single mount above the routes also means the title follows a locale change, a
 *  plugin being enabled and a client-side navigation on its own, with no per-page copy to keep in step.
 *
 *  The title is RENDERED, never written into `document.title` from an effect: React owns the <title>
 *  node (the layout renders one of its own through Next metadata) and re-commits it, so an imperative
 *  write is reverted the moment React commits — measured on /projects before this was a rendered node.
 *
 *  `allWorlds` deliberately, not `worlds`: hiding an entry from the menu is an arrangement choice and
 *  must not leave that page's tab unnamed.
 *
 *  The product name comes from the brand context, which the server seeds into the shell synchronously —
 *  so a white-labelled instance never flashes "Elowen" before its own name resolves. */
export function DocumentTitle() {
  const pathname = usePathname();
  const { appName } = useBrand();
  const { allWorlds } = useShellNavigation();
  const headerTitle = usePageHeader()?.header.title;
  return <title>{resolveDocumentTitle({ appName, pathname: pathname ?? '', entries: allWorlds, headerTitle })}</title>;
}
