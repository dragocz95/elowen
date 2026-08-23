'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useBrand } from '../../lib/brand';
import { usePageHeader } from '../../lib/pageHeader';
import { resolveDocumentTitle } from '../../lib/documentTitle';
import { useShellNavigation } from './useShellNavigation';

/** The one place the browser tab is named, mounted once above the auth gate.
 *
 *  It keys off the pathname rather than off a route's `metadata` export: every surface here is client
 *  rendered and navigation happens without a document load, so a server-side title would be written once
 *  and never again. The mount above the auth gate also names the login screen with the synchronously seeded
 *  brand, while `allWorlds` keeps hidden and plugin pages named from the same translated labels as the menu.
 *
 *  This write is safe only because the root metadata deliberately renders NO <title> node. The race fixed
 *  in 1d052eba was an effect fighting a React-owned metadata title; with that second owner removed, React has
 *  nothing to re-commit over this value. The terminal pop-out is excluded because it lives outside the shell
 *  chrome and renders its own route-specific title. */
export function DocumentTitle() {
  const pathname = usePathname();
  const { appName } = useBrand();
  const { allWorlds } = useShellNavigation();
  const headerTitle = usePageHeader()?.header.title;

  useEffect(() => {
    if (pathname?.startsWith('/terminal/')) return;
    document.title = resolveDocumentTitle({ appName, pathname: pathname ?? '', entries: allWorlds, headerTitle });
  }, [appName, pathname, allWorlds, headerTitle]);

  return null;
}
