'use client';
import { useEffect, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { usePageHeader } from '../../lib/pageHeader';
import { useTranslation } from '../../lib/i18n';

/** Publishes the page title (+ optional count + icon) into the global TopBar, and renders ONLY the
 *  page's own actions/filters row (and optional subtitle) below the bar. The title itself no longer
 *  renders inline — it lives in the always-visible top strip — so pages get a stable heading up top
 *  while their filters stay with the content. If a page has no children/subtitle, nothing renders here. */
export function ModuleHeader({ title, count, icon: Icon, children, subtitle }: { title: string; count?: number; icon?: LucideIcon; children?: ReactNode; subtitle?: string }) {
  // Depend on the stable setHeader only — the context VALUE changes whenever the header state does
  // (which this very effect writes), so listing it in the deps would re-run the effect after its own
  // update and loop forever, starving the transition-based router navigation.
  const setHeader = usePageHeader()?.setHeader;
  const { t } = useTranslation();
  const appName = t.common.appName;
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
      {/* One-line toolbar: the filters/actions row never wraps — it scrolls horizontally on overflow
          (matching the settings pill-row precedent) so every page's header stays a single, consistent
          line. [&>*]:shrink-0 keeps each control at its natural width; pb-1 -mb-1 keeps focus rings from
          being clipped by overflow-x-auto. */}
      {children ? (
        <div className="flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto scrollbar-none pb-1 -mb-1 [&>*]:shrink-0">
          {children}
        </div>
      ) : null}
    </div>
  );
}
