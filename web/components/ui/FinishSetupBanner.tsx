'use client';
import Link from 'next/link';
import { Sparkles, X } from 'lucide-react';
import { useMe, useSystemReadiness } from '../../lib/queries';
import { usePersistentState } from '../../lib/usePersistentState';
import { useTranslation } from '../../lib/i18n';

const DISMISS_VALUES = ['open', 'dismissed'] as const;

/** Dashboard onboarding nudge: shown to the owner (admin) when the embedded brain has no resolvable
 *  provider, so the agent can't answer chat. Gated on the admin-only readiness endpoint's `chat` check —
 *  connect a provider and it self-dismisses. A manual dismissal persists client-side so it doesn't nag,
 *  but the readiness gate is the real off switch. */
export function FinishSetupBanner() {
  const { t } = useTranslation();
  const me = useMe();
  const isAdmin = me.data?.user.is_admin === true;
  const readiness = useSystemReadiness(isAdmin);
  const [state, setState] = usePersistentState<(typeof DISMISS_VALUES)[number]>('elowen.dashboard.finishSetup', 'open', DISMISS_VALUES);

  if (!isAdmin || state === 'dismissed') return null;
  // `checks` is guarded as well as `data`: the payload crosses the network, so its shape is a promise
  // rather than a guarantee, and an answer without the array would take the entire dashboard down over an
  // optional nudge. Missing checks read the same as "nothing known yet" — the banner simply stays away.
  const chatOk = readiness.data?.checks?.find((c) => c.id === 'chat')?.ok;
  if (chatOk !== false) return null; // only render once we know chat is NOT ready

  return (
    <section className="flex items-start gap-3 rounded-lg border border-warning/50 bg-warning/[0.06] p-4">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-warning/15 text-warning">
        <Sparkles size={16} aria-hidden />
      </span>
      <div className="flex flex-1 flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-semibold text-foreground">{t.dashboard.finishSetup.title}</h2>
          <p className="text-sm text-muted-foreground">{t.dashboard.finishSetup.body}</p>
        </div>
        <Link
          href="/settings?cat=brain"
          className="inline-flex h-9 w-fit items-center justify-center gap-2 rounded-md border border-primary bg-primary px-3.5 text-sm font-medium text-bg transition-opacity hover:opacity-90"
        >
          <Sparkles size={14} aria-hidden />{t.dashboard.finishSetup.cta}
        </Link>
      </div>
      <button
        type="button"
        aria-label={t.dashboard.finishSetup.dismiss}
        title={t.dashboard.finishSetup.dismiss}
        onClick={() => setState('dismissed')}
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <X size={16} aria-hidden />
      </button>
    </section>
  );
}
