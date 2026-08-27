'use client';
import Link from 'next/link';
import { ArrowRight, Clock3, Sparkles, WifiOff } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useBrand } from '../../lib/brand';
import { HeroCosmos } from './HeroCosmos';
import { HomeComposer } from './HomeComposer';
import type { Presence, PresenceState } from './usePresence';

/** What the instance is doing right now, over the composer that starts the next turn — with the orbital
 *  field beside it.
 *
 *  The greeting, the status line and the clock that used to open this tile now live in the page's
 *  WorkspaceHero (DashboardView): they are the page's title block, and having a second <h1> inside the
 *  first surface below it meant the dashboard announced itself twice. What is left is the part that is
 *  genuinely a working surface — who is mid-turn, and the box you type into.
 *
 *  The "what is it working on" row used to name a tmux agent session and deep-link to the task it was
 *  assigned. Both belonged to the `agents`/`work` plugins. What replaces them is the same fact from a
 *  source that survived: the pulse names the person mid-turn and carries their conversation title, so
 *  the row still says who is doing what and now links to the conversation itself. */
export function HeroNowTile({ now, presence }: { now: number; presence: Presence }) {
  const { t } = useTranslation();
  const { appName } = useBrand();

  const stateLabel = stateText(t.dashboard.presence, presence.state);

  return (
    <section className="relative isolate overflow-hidden px-1 py-5 @container @sm:px-3 @sm:py-7">
      <div
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            'radial-gradient(circle at 78% 40%, rgb(var(--accent-rgb) / 0.1), transparent 35%),'
            + ' linear-gradient(140deg, rgb(var(--accent-rgb) / 0.022), transparent 52%)',
        }}
        aria-hidden
      />
      {/* No min-height below the orbit threshold. The grid used to reserve 29rem at every width — a
          figure chosen when the whole app was rendered at ~72% — which on a phone was half a screen of
          nothing above the fold. Room is reserved only where the two-column field is actually drawn. */}
      <div className="grid items-center gap-6 @3xl:min-h-[22rem] @3xl:grid-cols-[minmax(0,1fr)_minmax(20rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {presence.primary ? (
            <Link href="/chat" className="group flex items-center gap-3 rounded-2xl border border-accent/15 bg-accent/[0.04] px-4 py-3 shadow-[0_0_24px_rgb(var(--accent-rgb)_/_0.07)] transition-[border-color,background-color] hover:border-accent/40 hover:bg-accent/[0.07]">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-accent/10 text-accent"><Sparkles size={16} aria-hidden /></span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                {/* The title is empty between turns even while `working` is true, so the person's name
                    is the fallback rather than a blank row. */}
                <span className="truncate text-sm font-medium text-text">{presence.primary.title || presence.primary.label}</span>
                <span className="truncate text-xs text-text-muted">
                  <span>{t.dashboard.byPerson.replace('{person}', presence.primary.label)}</span>
                  <span aria-hidden> · </span>
                  <span>{stateLabel}</span>
                </span>
              </span>
              <ArrowRight size={15} className="shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden />
            </Link>
          ) : (
            <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-elevated text-text-muted">
                {presence.state === 'offline' ? <WifiOff size={16} aria-hidden /> : <Clock3 size={16} aria-hidden />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-text">{presence.state === 'offline' ? stateLabel : t.dashboard.resting.replace('{agentName}', appName)}</span>
                <span className="text-xs text-text-muted">{presence.state === 'offline' ? t.common.daemonUnreachable : t.dashboard.restingDesc}</span>
              </span>
            </div>
          )}

          <HomeComposer placeholder={t.dashboard.composerPlaceholder} actionLabel={t.dashboard.composerAction.replace('{agentName}', appName)} />
        </div>

        <div className="flex flex-col justify-center @3xl:min-h-[18rem] @3xl:self-stretch">
          <HeroCosmos now={now} state={presence.state} presenceLabel={`${appName}: ${stateLabel}`} />
        </div>
      </div>
    </section>
  );
}

function stateText(labels: Record<PresenceState, string>, state: PresenceState): string {
  return labels[state];
}
