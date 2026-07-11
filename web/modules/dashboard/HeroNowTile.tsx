'use client';
import Link from 'next/link';
import { ArrowRight, Clock3, Sparkles, WifiOff } from 'lucide-react';
import { useTasks } from '../../lib/queries';
import { taskForSession, agentDisplayName } from '../../lib/agentUtils';
import { useTranslation } from '../../lib/i18n';
import { HomeComposer } from './HomeComposer';
import type { AgentPresence, AgentPresenceState } from './useAgentPresence';

/** The personal-agent home hero. Runtime data stays ordinary DOM and the original flat mascot stays
 *  untouched; the surrounding presence layers communicate whether Elowen is resting, working or waiting. */
export function HeroNowTile({ now, presence }: { now: number; presence: AgentPresence }) {
  const { t, locale } = useTranslation();
  const tasks = useTasks();
  const primaryName = presence.primary?.name ?? '';
  const task = primaryName ? taskForSession(tasks.data ?? [], primaryName) : undefined;
  const date = new Date(now);
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const dateLabel = date.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  const stateLabel = stateText(t.dashboard.presence, presence.state);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col items-start gap-0.5">
        <span className="font-mono text-xl font-semibold tabular-nums text-text">{time}</span>
        <span className="text-xs capitalize text-text-muted">{dateLabel}</span>
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
  );
}

function stateText(labels: Record<AgentPresenceState, string>, state: AgentPresenceState): string {
  return labels[state];
}
