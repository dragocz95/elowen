'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useShellNavigation } from './useShellNavigation';
import { entryIsActive, type NavEntry } from './navEntry';

/** Where the reader is, read off the SAME navigation model the menu renders.
 *
 *  Deliberately not off `modules/registry.ts`: that registry knows only the core worlds, so a breadcrumb
 *  built from it would go blank on every plugin page — which is most of the app on a working instance.
 *  `useShellNavigation()` is the one model that includes them, and it is already mounted by the sidebar,
 *  so this costs a cache read rather than a request.
 *
 *  It reports at most two steps, because that is how deep the model goes: a world, and the page inside it
 *  when the world has several. A world that IS its own page reports one step, and the trail is then the
 *  page's own name rather than a chain repeating it. */
export function Breadcrumb() {
  const pathname = usePathname();
  const { t } = useTranslation();
  const { worlds } = useShellNavigation();

  const world = worlds.find((entry) => entryIsActive(entry, pathname));
  if (!world) return null;
  const pages = world.subItems ?? [];
  const page = pages.length > 1
    ? pages.find((item) => entryIsActive({ ...item, icon: world.icon } as NavEntry, pathname))
    : undefined;

  return (
    <nav aria-label={t.common.breadcrumb} className="page-bar__breadcrumb">
      <ol className="flex min-w-0 items-center gap-1.5">
        <li className="min-w-0">
          {page
            // Only a step that is not the destination is a link: `aria-current` on a link the reader is
            // already standing on is a control that does nothing.
            ? <Link href={world.href ?? '#'} className="truncate text-text-muted transition-colors hover:text-text">{world.label}</Link>
            : <span className="truncate font-medium text-text" aria-current="page">{world.label}</span>}
        </li>
        {page ? (
          <>
            <li aria-hidden className="text-text-subtle"><ChevronRight size={14} /></li>
            <li className="min-w-0"><span className="truncate font-medium text-text" aria-current="page">{page.label}</span></li>
          </>
        ) : null}
      </ol>
    </nav>
  );
}
