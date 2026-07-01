'use client';
import Link from 'next/link';
import { useState, useEffect, useMemo } from 'react';
import { Rocket, Plus } from 'lucide-react';
import { useTasks, useSessions, useSessionInfos, useMissions, useSessionSignals, useModelUsage, usePendingAsks, useEscalations } from '../../lib/queries';
import { usePauseMission, useResumeMission, useDisengage } from '../../lib/mutations';
import { currentMonthBounds } from './metrics';
import { buildUsageSummary } from '../stats/usageBars';
import { NeedsInputBanner } from '../../components/ui/NeedsInputBanner';
import { SignalsRow } from './SignalsRow';
import { AgentConstellation } from './AgentConstellation';
import { LiveMissions } from './LiveMissionCard';
import { EventStream } from './EventStream';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';

/** A clock that re-renders every 30s (enough for an HH:MM display, and to keep the month window live). */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function DashboardView() {
  const { t, locale } = useTranslation();
  const tasks = useTasks();
  const sessionNames = useSessions();
  const sessionInfos = useSessionInfos();
  const missions = useMissions();
  const signals = useSessionSignals();
  const pendingAsks = usePendingAsks();
  const escalations = useEscalations();
  const pause = usePauseMission();
  const resume = useResumeMission();
  const disengage = useDisengage();
  const { toast } = useToast();
  const now = useNow();

  const monthBounds = useMemo(() => currentMonthBounds(now.getTime()), [now]);
  const monthlyUsage = useModelUsage(undefined, monthBounds);
  const monthlySummary = buildUsageSummary(monthlyUsage.data);

  // The two live signals that actually demand attention: live agents, and decisions a human owes.
  // "Agents active" counts every live agent session (a session only exists while its agent runs) —
  // not just those with a derived 'working' signal, so an agent that's booting, prompted or between
  // signals still reads as active rather than the dashboard falsely going "all quiet".
  const agentsActive = (sessionInfos.data ?? []).filter((s) => s.role === 'agent').length;
  const decisionsWaiting = (pendingAsks.data?.length ?? 0) + escalations.length;

  const hour = now.getHours();
  const greeting = hour < 12 ? t.dashboard.greetingMorning : hour < 18 ? t.dashboard.greetingAfternoon : t.dashboard.greetingEvening;
  const timeStr = `${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dateStr = now.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  const statusLine = agentsActive > 0
    ? t.dashboard.agentsWorking.replace('{count}', String(agentsActive))
    : t.dashboard.allQuiet;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <NeedsInputBanner />

      {/* ── Hero: greeting + live clock on a clean flat panel ── */}
      <section>
        <div className="flex flex-col gap-5 rounded-2xl border border-border bg-surface p-6 sm:p-7" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h1 className="font-display text-3xl font-semibold tracking-tight text-text">{greeting}</h1>
              <p className="text-sm text-text-muted">{statusLine}</p>
            </div>
            <div className="flex flex-col items-end">
              <span className="hero-clock font-mono text-3xl font-semibold tabular-nums">{timeStr}</span>
              <span className="text-xs capitalize text-text-muted">{dateStr}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/tasks?new=1" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-accent bg-accent px-3.5 text-sm font-medium text-white transition-opacity hover:opacity-90"><Plus size={14} aria-hidden />{t.tasks.newTask}</Link>
            <Link href="/tasks?new=1" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-elevated px-3.5 text-sm font-medium text-text transition-colors hover:border-border-strong"><Rocket size={14} aria-hidden />{t.missions.newMission}</Link>
          </div>
        </div>
      </section>

      {/* ── The three signals that matter right now ───────────── */}
      <SignalsRow agentsActive={agentsActive} decisionsWaiting={decisionsWaiting} monthCost={monthlySummary.totalCostLabel} />

      {/* ── Agent constellation: live agents as a living map ──── */}
      <AgentConstellation sessions={sessionInfos.data ?? []} signals={signals} tasks={tasks.data ?? []} />

      {/* ── Live missions ─────────────────────────────────────── */}
      <LiveMissions
        missions={missions.data ?? []}
        tasks={tasks.data ?? []}
        sessionNames={sessionNames.data ?? []}
        signals={signals}
        onPause={(id) => pause.mutate(id, { onSuccess: () => toast(t.missions.pausedMsg), onError: (e) => toast(String(e), 'error') })}
        onResume={(id) => resume.mutate(id, { onSuccess: () => toast(t.missions.resumed), onError: (e) => toast(String(e), 'error') })}
        onDisengage={(id) => disengage.mutate(id, { onSuccess: () => toast(t.missions.disengaged), onError: (e) => toast(String(e), 'error') })}
        isLoading={missions.isLoading}
        isError={missions.isError}
        onRetry={() => missions.refetch()}
      />

      {/* ── Event stream ──────────────────────────────────────── */}
      <EventStream />
    </div>
  );
}
