'use client';
import { useEffect, useState } from 'react';
import { UserCog, LogOut } from 'lucide-react';
import { impersonatingAs, stopImpersonation } from '../../lib/token';
import { useTranslation } from '../../lib/i18n';

/** Full-width bar shown only while an admin is impersonating another user ("sign in as"). Reads the
 *  JS-readable hint cookie the BFF sets; the actual session token stays httpOnly. Ending it restores
 *  the admin session and reloads. */
export function ImpersonationBanner() {
  const { t } = useTranslation();
  const [as, setAs] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  // Read after mount (cookies aren't available during SSR) — impersonation always follows a full reload.
  useEffect(() => { setAs(impersonatingAs()); }, []);
  if (!as) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-danger px-4 py-1.5 text-center text-xs font-medium text-bg">
      <span className="flex items-center gap-1.5">
        <UserCog size={14} className="shrink-0 text-bg" aria-hidden />
        {t.users.impersonatingAs.replace('{name}', as)}
      </span>
      <button
        type="button"
        onClick={() => { setLeaving(true); void stopImpersonation(); }}
        disabled={leaving}
        className="inline-flex items-center gap-1 rounded-md border border-bg/45 px-2 py-0.5 font-semibold text-bg transition-colors hover:bg-bg/15 disabled:opacity-50"
      >
        <LogOut size={12} aria-hidden />
        {t.users.stopImpersonating}
      </button>
    </div>
  );
}
