'use client';
import { Terminal } from 'lucide-react';
import { ControlSurfaceDocument } from '../ui/ControlSurface';
import { useTranslation } from '../../lib/i18n';
import { useBrand } from '../../lib/brand';

/** What the web shows on a box where the installer has not finished yet — no admin account exists, so
 *  there is nobody to sign in as. Setup itself lives in the terminal installer, so the only useful thing
 *  the browser can do is name the command and get out of the way. Showing the login form instead would
 *  leave a visitor guessing at credentials that were never created. */
export function SetupPending() {
  const { t } = useTranslation();
  const brand = useBrand();
  return (
    <div className="flex h-screen items-center justify-center bg-background p-6">
      <ControlSurfaceDocument className="animate-pop-in flex w-full max-w-md flex-col gap-4 p-8">
        <img src={brand.logoSrc} alt={brand.appName} className="logo-adaptive mx-auto h-auto w-64" />
        <h1 className="text-center text-sm uppercase tracking-wide text-muted-foreground">{t.auth.setupPendingTitle}</h1>
        <p className="text-center text-xs leading-relaxed text-muted-foreground">{t.auth.setupPendingBody}</p>
        <div className="flex items-center justify-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
          <Terminal size={13} className="shrink-0 text-muted-foreground" aria-hidden />
          <code>elowen setup</code>
        </div>
        <p className="text-center text-tiny text-muted-foreground">{t.auth.setupPendingHint}</p>
      </ControlSurfaceDocument>
    </div>
  );
}
