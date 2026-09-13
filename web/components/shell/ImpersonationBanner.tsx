'use client';
import { useEffect, useState } from 'react';
import { UserCog, LogOut } from 'lucide-react';
import { impersonatingAs, stopImpersonation } from '../../lib/token';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../ui/Toast';

/** Full-width bar shown only while an admin is impersonating another user. The readable cookie is a
 *  display hint only; returning atomically exchanges the target session for a fresh admin session. */
export function ImpersonationBanner() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [as, setAs] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  async function leave(): Promise<void> {
    if (leaving) return;
    setLeaving(true);
    try { await stopImpersonation(); }
    catch { setLeaving(false); toast(t.users.stopImpersonateError, 'error'); }
  }
  // Read after mount (cookies aren't available during SSR) — impersonation always follows a full reload.
  useEffect(() => { setAs(impersonatingAs()); }, []);
  if (!as) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-destructive px-4 py-1.5 text-center text-xs font-medium text-background">
      <span className="flex items-center gap-1.5">
        <UserCog size={14} className="shrink-0 text-background" aria-hidden />
        {t.users.impersonatingAs.replace('{name}', as)}
      </span>
      <button
        type="button"
        onClick={() => { void leave(); }}
        disabled={leaving}
        className="inline-flex items-center gap-1 rounded-md border border-background/45 px-2 py-0.5 font-semibold text-background transition-colors hover:bg-background/15 disabled:opacity-50"
      >
        <LogOut size={12} aria-hidden />
        {t.users.stopImpersonating}
      </button>
    </div>
  );
}
