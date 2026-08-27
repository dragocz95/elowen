'use client';
import { useEffect, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { usePageHeader } from '../../lib/pageHeader';

/** Publishes the page title (+ optional count + icon) into the shell masthead, and renders only the
 *  page's actions/filters below it. If a page has no children/subtitle, nothing renders here.
 *
 *  The browser tab is NOT set here. It is named once by the shell (components/shell/DocumentTitle) off
 *  the navigation model, so every route — including the plugin pages that never mount this component —
 *  is titled by the same rule. What this publishes is the fallback that mechanism reads for a page the
 *  navigation names nowhere. */
export function ModuleHeader({ title, count, icon: Icon, children, subtitle }: { title: string; count?: number; icon?: LucideIcon; children?: ReactNode; subtitle?: string }) {
  // Depend on the stable setHeader only — the context VALUE changes whenever the header state does
  // (which this very effect writes), so listing it in the deps would re-run the effect after its own
  // update and loop forever, starving the transition-based router navigation.
  const setHeader = usePageHeader()?.setHeader;
  useEffect(() => {
    setHeader?.({ title, count, icon: Icon });
    return () => setHeader?.({});
  }, [title, count, Icon, setHeader]);

  if (!children && !subtitle) return null;
  return (
    // `children` being present is not the same as `children` rendering something: an idle AutoSaveStatus
    // is an empty live region. The `.module-header` classes let the stylesheet collapse the wrapper (and
    // its margin) when nothing inside it is actually visible — see workspace-shell.css.
    <div className="module-header mb-6 flex flex-col gap-2">
      {subtitle ? <p className="text-sm text-text-muted">{subtitle}</p> : null}
      {/* Responsive toolbar: filter/action groups wrap as whole controls, while controls that contain
          their own collections (project pills, segmented filters) may wrap internally. Keeping every
          direct child bounded to the row prevents one long group from creating body-level overflow. */}
      {children ? (
        <div className="module-header__toolbar flex min-w-0 flex-wrap items-center justify-end gap-2 [&>*]:max-w-full">
          {children}
        </div>
      ) : null}
    </div>
  );
}
