'use client';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { Rocket, Plus } from 'lucide-react';
import { useSessionInfos } from '../../lib/queries';
import { NeedsInputBanner } from '../../components/ui/NeedsInputBanner';
import { HeroNowTile } from './HeroNowTile';
import { DecisionsTile, SpendTile, AgentsTile, CronTile } from './SignalTiles';
import { ActivityTile } from './ActivityTile';
import { TodayTasksTile } from './TodayTasksTile';
import { useTranslation } from '../../lib/i18n';
import type { SessionInfo } from '../../lib/types';

/** A clock that re-renders every 30s (enough for an HH:MM display, keeps the month window + elapsed live). */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** The dashboard: a bento home for a single Orca agent — "what is my agent doing right now, what does
 *  it need from me, what did it get done". A 2×2 hero (live work) anchors a grid of colored-chip tiles:
 *  decisions waiting, this month's spend, active agents, the next scheduled run, the activity feed and
 *  today's tasks. Mission control (constellation, mission engage/pause) lives in Tasks now, not here. */
export function DashboardView() {
  const { t, locale } = useTranslation();
  const infos = useSessionInfos();
  const now = useNow();
  const nowMs = now.getTime();

  const agentsActive = (infos.data ?? []).filter((s: SessionInfo) => s.role === 'agent').length;
  const hour = now.getHours();
  const greeting = hour < 12 ? t.dashboard.greetingMorning : hour < 18 ? t.dashboard.greetingAfternoon : t.dashboard.greetingEvening;
  const statusLine = agentsActive > 0 ? t.dashboard.agentsWorking.replace('{count}', String(agentsActive)) : t.dashboard.allQuiet;
  const timeStr = `${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dateStr = now.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <NeedsInputBanner />

      {/* Header: greeting + live clock + quick launch */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <h1 className="font-display text-3xl font-semibold tracking-tight text-text">{greeting}</h1>
            <p className="text-sm text-text-muted">{statusLine}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/tasks?new=1" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-accent bg-accent px-3.5 text-sm font-medium text-white transition-opacity hover:opacity-90"><Plus size={14} aria-hidden />{t.tasks.newTask}</Link>
            <Link href="/tasks?new=1" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-elevated px-3.5 text-sm font-medium text-text transition-colors hover:border-border-strong"><Rocket size={14} aria-hidden />{t.missions.newMission}</Link>
          </div>
        </div>
        <div className="flex flex-col items-end">
          <span className="hero-clock font-mono text-3xl font-semibold tabular-nums">{timeStr}</span>
          <span className="text-xs capitalize text-text-muted">{dateStr}</span>
        </div>
      </header>

      {/* Bento grid: hero (2×2) + signal tiles (1×1) + activity/today (2×1). Spans collapse on narrow
          containers — @4xl is the full 4-col bento, @xl a 2-col stack, base a single column. */}
      <div className="@container">
        <div className="grid auto-rows-[minmax(9.25rem,auto)] grid-cols-1 gap-3.5 @xl:grid-cols-2 @4xl:grid-cols-4">
          <HeroNowTile now={nowMs} />
          <DecisionsTile />
          <SpendTile now={nowMs} />
          <AgentsTile />
          <CronTile now={nowMs} />
          <ActivityTile />
          <TodayTasksTile now={nowMs} />
        </div>
      </div>
    </div>
  );
}
