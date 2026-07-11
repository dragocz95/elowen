'use client';
import Link from 'next/link';
import { ArrowRight, Clock3, Sparkles, WifiOff } from 'lucide-react';
import { useTasks } from '../../lib/queries';
import { taskForSession, agentDisplayName } from '../../lib/agentUtils';
import { useTranslation } from '../../lib/i18n';
import { ElowenPresence } from './ElowenPresence';
import { HomeComposer } from './HomeComposer';
import { useAgentPresence, type AgentPresenceState } from './useAgentPresence';

/** The personal-agent home hero. Runtime data stays ordinary DOM and the original flat mascot stays
 *  untouched; the surrounding presence layers communicate whether Elowen is resting, working or waiting. */
export function HeroNowTile({ now }: { now: number }) {
  const { t, locale } = useTranslation();
  const presence = useAgentPresence();
  const tasks = useTasks();
  const primaryName = presence.primary?.name ?? '';
  const task = primaryName ? taskForSession(tasks.data ?? [], primaryName) : undefined;
  const date = new Date(now);
  const hour = date.getHours();
  const greeting = hour < 12 ? t.dashboard.greetingMorning : hour < 18 ? t.dashboard.greetingAfternoon : t.dashboard.greetingEvening;
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const dateLabel = date.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  const stateLabel = stateText(t.dashboard.presence, presence.state);
  const statusLine = presence.state === 'offline'
    ? t.dashboard.presence.offline
    : presence.waitingCount > 0
    ? t.dashboard.presence.waiting.replace('{count}', String(presence.waitingCount))
    : presence.activeCount > 0
      ? t.dashboard.agentsWorking.replace('{count}', String(presence.activeCount))
      : t.dashboard.allQuiet;

  return (
    <section className="dashboard-hero relative isolate overflow-hidden border-b border-border/80 px-1 py-5 @container sm:px-3 sm:py-7">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_78%_40%,rgb(255_82_54_/_0.1),transparent_35%),linear-gradient(140deg,rgb(255_82_54_/_0.022),transparent_52%)]" aria-hidden />
      <div className="grid min-h-[29rem] items-center gap-7 @3xl:grid-cols-[minmax(0,1.08fr)_minmax(21rem,.92fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="inline-flex w-fit items-center gap-2 text-[11px] font-semibold uppercase tracking-[.13em] text-accent">
                <span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />{t.dashboard.rightNow}
              </span>
              <h1 className="font-display text-4xl font-semibold tracking-[-0.045em] text-text sm:text-5xl">{greeting}</h1>
              <p className="text-sm text-text-muted">{statusLine}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              <span className="font-mono text-xl font-semibold tabular-nums text-text">{time}</span>
              <span className="text-xs capitalize text-text-muted">{dateLabel}</span>
            </div>
          </div>

          {presence.primary ? (
            <Link href={task ? `/tasks?select=${encodeURIComponent(task.id)}` : '/sessions'} className="group flex items-center gap-3 border-y border-border/80 px-1 py-3 transition-[border-color,background-color] hover:border-accent/35 hover:bg-accent/[0.025] sm:px-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-accent/10 text-accent"><Sparkles size={16} aria-hidden /></span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-text">{task?.title ?? agentDisplayName(primaryName)}</span>
                <span className="truncate text-xs text-text-muted">
                  <span>{t.dashboard.byAgent.replace('{agent}', agentDisplayName(primaryName))}</span>
                  <span aria-hidden> · </span>
                  <span>{stateLabel}</span>
                </span>
              </span>
              <ArrowRight size={15} className="shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden />
            </Link>
          ) : (
            <div className="flex items-center gap-3 border-y border-border/80 px-1 py-3 sm:px-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-elevated text-text-muted">
                {presence.state === 'offline' ? <WifiOff size={16} aria-hidden /> : <Clock3 size={16} aria-hidden />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-text">{presence.state === 'offline' ? stateLabel : t.dashboard.resting}</span>
                <span className="text-xs text-text-muted">{presence.state === 'offline' ? t.common.daemonUnreachable : t.dashboard.restingDesc}</span>
              </span>
            </div>
          )}

          <HomeComposer placeholder={t.dashboard.composerPlaceholder} actionLabel={t.dashboard.composerAction} />
        </div>

        <div className="flex min-h-72 items-center justify-center @3xl:min-h-[25rem]">
          <ElowenPresence state={presence.state} label={`${t.common.appName}: ${stateLabel}`} />
        </div>
      </div>
    </section>
  );
}

function stateText(labels: Record<AgentPresenceState, string>, state: AgentPresenceState): string {
  return labels[state];
}
