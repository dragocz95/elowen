'use client';
import { useEffect, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { usePageHeader } from '../../lib/pageHeader';
import { useBrand } from '../../lib/brand';

/** Publishes the page title (+ optional count + icon) into the shell masthead, and renders only the
 *  page's actions/filters below it. If a page has no children/subtitle, nothing renders here. */
export function ModuleHeader({ title, count, icon: Icon, children, subtitle }: { title: string; count?: number; icon?: LucideIcon; children?: ReactNode; subtitle?: string }) {
  // Depend on the stable setHeader only — the context VALUE changes whenever the header state does
  // (which this very effect writes), so listing it in the deps would re-run the effect after its own
  // update and loop forever, starving the transition-based router navigation.
  const setHeader = usePageHeader()?.setHeader;
  const { appName } = useBrand();
  useEffect(() => {
    setHeader?.({ title, count, icon: Icon });
    // Reflect the page in the browser tab — "Elowen — <Page>". Every route funnels its title through
    // this one component, so the whole app gets per-page titles here with no per-page effects. Cleanup
    // resets to the bare app name so a chromeless/next route never inherits a stale title.
    document.title = title ? `${appName} — ${title}` : appName;
    return () => {
      setHeader?.({});
      document.title = appName;
    };
  }, [title, count, Icon, setHeader, appName]);

  if (!children && !subtitle) return null;
  return (
    <div className="mb-6 flex flex-col gap-2">
      {subtitle ? <p className="text-sm text-text-muted">{subtitle}</p> : null}
      {/* Responsive toolbar: filter/action groups wrap as whole controls, while controls that contain
          their own collections (project pills, segmented filters) may wrap internally. Keeping every
          direct child bounded to the row prevents one long group from creating body-level overflow. */}
      {children ? (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 [&>*]:max-w-full">
          {children}
        </div>
      ) : null}
    </div>
  );
}
