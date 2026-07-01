'use client';
import Link from 'next/link';
import { useState, useEffect, useMemo } from 'react';
import { Rocket, ArrowRight, Plus, Radio, Sparkles, Boxes, FolderGit2, Pause, Play, Power, Gauge, Layers, Cpu, ShieldCheck, Coins, type LucideIcon } from 'lucide-react';
import { useTasks, useSessions, useMissions, useSessionSignals, useConfig, useProjects, useModelUsage } from '../../lib/queries';
import { usePauseMission, useResumeMission, useDisengage } from '../../lib/mutations';
import { deriveDashboardMetrics, currentMonthBounds } from './metrics';
import { buildUsageSummary, type UsageSummary } from '../stats/usageBars';
import { Badge } from '../../components/ui/Badge';
import { StatCard } from '../../components/ui/StatCard';
import type { Tone } from '../../components/ui/tone';
import { NeedsInputBanner } from '../../components/ui/NeedsInputBanner';
import { ProgressRibbon } from '../../components/ui/ProgressRibbon';
import { AgentStatusDot } from '../../components/ui/AgentStatusDot';
import { IconButton } from '../../components/ui/IconButton';
import { CapacityMeter } from '../../components/ui/CapacityMeter';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useSessionPane } from '../../lib/useSessionPane';
import { tailSnippet, taskSessionName, taskForSession, taskExec, agentDisplayName } from '../../lib/agentUtils';
import { allModels } from '../../lib/execPresets';
import { useSessionStall } from '../../lib/useSessionStall';
import { sessionActivity } from '../../lib/sessionActivity';
import { epicCapacity } from '../../lib/taskTree';
import { ModelIcon } from '../../components/ui/ModelIcon';
import type { Task, DerivedSignal, Mission } from '../../lib/types';

/** A single live agent lane: status pulse, model icon, name, current activity line. */
function LiveLane({ name, task }: { name: string; task?: Task }) {
  const { t } = useTranslation();
  const { tail } = useSessionPane(name, 4);
  const exec = taskExec(task?.labels);
  const line = tailSnippet(tail) || '…';
  const { state: stall, silenceSec } = useSessionStall(name, true);
  const activity = sessionActivity(tail);
  const activityTone = activity === 'error' ? 'danger' : activity === 'prompted' ? 'warning' : activity === 'unknown' ? 'muted' : 'accent';
  return (
    <Link href="/sessions" className="flex items-center gap-2.5 rounded-md border border-border bg-bg px-3 py-2 transition-colors hover:border-border-strong">
      <AgentStatusDot live size="sm" stall={stall} silenceSec={silenceSec} />
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-elevated">
        {exec ? <ModelIcon name={exec} size={13} /> : <Radio size={12} className="text-text-muted" aria-hidden />}
      </span>
      <span className="shrink-0 font-mono text-xs text-text">{agentDisplayName(name)}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">{line}</span>
      <Badge tone={activityTone as Tone}>{t.activity[activity]}</Badge>
    </Link>
  );
}

/** The 5th overview card: this calendar month's usage — most-used model (by tokens), total tokens,
 *  total cost. A fixed, non-user-selectable "this month" window (see `currentMonthBounds` in
 *  `metrics.ts`) — unlike the Tasks/Stats `DateRangeFilter`, there's no filter control here. Shares
 *  the other overview cards' outer shell for visual consistency but needs three stacked lines, so it
 *  isn't built on `StatCard` itself. */
function MonthlyUsageCard({ summary }: { summary: UsageSummary }) {
  const { t } = useTranslation();
  const top = summary.rows[0];
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
      <Coins size={18} className="text-text-muted" aria-hidden />
      <div className="flex flex-col gap-2">
        <div>
          <div className="flex items-center gap-1.5 font-mono text-lg font-semibold leading-none text-text">
            {top ? <ModelIcon name={top.exec} size={16} /> : null}
            <span className="truncate">{top ? top.exec : '—'}</span>
          </div>
          <span className="text-[11px] uppercase tracking-wider text-text-muted">{t.dashboard.statTopModel}</span>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border pt-2 font-mono text-xs tabular-nums text-text">
          <span title={t.stats.cardTotalTokens}>{summary.totalTokensLabel}</span>
          <span title={t.stats.cardTotalCost}>{summary.totalCostLabel}</span>
        </div>
      </div>
    </div>
  );
}

/** A label·value chip for the configuration row, led by a faint icon. */
function ConfigPill({ label, value, icon: Icon }: { label: string; value: string; icon: LucideIcon }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-elevated px-3 py-1.5 text-xs">
      <Icon size={13} className="shrink-0 text-text-muted" aria-hidden />
      <span className="text-text-muted">{label}</span>
      <span className="font-medium text-text">{value}</span>
    </span>
  );
}

/** A clock that re-renders every 30s (enough for an HH:MM display). */
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
  const sessions = useSessions();
  const missions = useMissions();
  const signals = useSessionSignals();
  const config = useConfig();
  const projects = useProjects();
  const pause = usePauseMission();
  const resume = useResumeMission();
  const disengage = useDisengage();
  const { toast } = useToast();
  const now = useNow();

  const metrics = deriveDashboardMetrics(tasks.data, sessions.data, missions.data);
  const live = (sessions.data ?? []).slice(0, 6);
  const taskFor = (s: string): Task | undefined => taskForSession(tasks.data ?? [], s);

  // Stable inventory counts (non-zero even when nothing is running) for the big overview cards.
  const modelCount = allModels(config.data?.customModels ?? [], config.data?.hiddenPresets ?? []).length;
  const projectCount = (projects.data ?? []).length;
  const monthBounds = useMemo(() => currentMonthBounds(now.getTime()), [now]);
  const monthlyUsage = useModelUsage(undefined, monthBounds);
  const monthlySummary = buildUsageSummary(monthlyUsage.data);

  const hour = now.getHours();
  const greeting = hour < 12 ? t.dashboard.greetingMorning : hour < 18 ? t.dashboard.greetingAfternoon : t.dashboard.greetingEvening;
  const timeStr = `${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dateStr = now.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  const statusLine = metrics.liveSessions > 0
    ? t.dashboard.agentsWorking.replace('{count}', String(metrics.liveSessions))
    : t.dashboard.allQuiet;

  const cfg = config.data;
  const engine = cfg?.autopilot.pilotExec || t.dashboard.cfgRelay;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <NeedsInputBanner />

      {/* ── Hero: greeting + live clock, aurora glow behind a glass panel ── */}
      <section className="hero-aurora">
        <div className="hero-glass flex flex-col gap-5 p-6 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h1 className="text-3xl font-semibold tracking-tight text-text">{greeting}</h1>
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

      {/* ── System overview: big stat cards ───────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-muted">{t.dashboard.systemOverview}</h2>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-5">
          <StatCard value={projectCount} label={t.dashboard.statProjects} icon={FolderGit2} />
          <StatCard value={modelCount} label={t.dashboard.models} icon={Boxes} />
          <StatCard value={metrics.activeMissions} label={t.dashboard.activeMissions} icon={Rocket} />
          <StatCard value={metrics.liveSessions} label={t.dashboard.statAgents} icon={Radio} />
          <MonthlyUsageCard summary={monthlySummary} />
        </div>
      </section>

      {/* ── Live agents (only when any are running) ───────────── */}
      {live.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-muted">{t.dashboard.liveAgents}</h2>
          <div className="flex flex-col gap-2">
            {live.map((s) => <LiveLane key={s} name={s} task={taskFor(s)} />)}
          </div>
        </section>
      )}

      {/* ── Autopilot ─────────────────────────────────────────── */}
      <AutopilotSpotlight
        missions={missions.data ?? []}
        tasks={tasks.data ?? []}
        sessionNames={sessions.data ?? []}
        signals={signals}
        onPause={(id) => pause.mutate(id, { onSuccess: () => toast(t.missions.pausedMsg), onError: (e) => toast(String(e), 'error') })}
        onResume={(id) => resume.mutate(id, { onSuccess: () => toast(t.missions.resumed), onError: (e) => toast(String(e), 'error') })}
        onDisengage={(id) => disengage.mutate(id, { onSuccess: () => toast(t.missions.disengaged), onError: (e) => toast(String(e), 'error') })}
        isLoading={missions.isLoading}
        isError={missions.isError}
        onRetry={() => missions.refetch()}
      />

      {/* ── Configuration ─────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-muted">{t.dashboard.configuration}</h2>
          <Link href="/settings" className="inline-flex items-center gap-1 text-xs font-medium text-accent transition-opacity hover:opacity-80">{t.dashboard.viewAll}<ArrowRight size={12} aria-hidden /></Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ConfigPill icon={Gauge} label={t.dashboard.cfgAutonomy} value={cfg?.defaults.autonomy ?? '—'} />
          <ConfigPill icon={Layers} label={t.dashboard.cfgMaxSessions} value={String(cfg?.defaults.maxSessions ?? '—')} />
          <ConfigPill icon={Cpu} label={t.dashboard.cfgEngine} value={engine} />
          <ConfigPill icon={ShieldCheck} label={t.dashboard.cfgReview} value={cfg?.autopilot.reviewOnDone ? t.dashboard.on : t.dashboard.off} />
        </div>
      </section>
    </div>
  );
}

/** The running phase for a mission: the first in_progress child (phases run sequentially). */
function currentRunningPhase(kids: Task[], sessionNames: string[]): Task | null {
  for (const k of kids) {
    if (k.status !== 'in_progress') continue;
    const s = taskSessionName(k);
    if (s && sessionNames.includes(s)) return k;
  }
  return null;
}

function MissionSpotlightRow({ mission, epic, kids, sessionNames, signals, onPause, onResume, onDisengage }: {
  mission: Mission;
  epic?: Task;
  kids: Task[];
  sessionNames: string[];
  signals: Record<string, DerivedSignal>;
  onPause: () => void;
  onResume: () => void;
  onDisengage: () => void;
}) {
  const { t } = useTranslation();
  const paused = mission.state === 'paused';
  const disengaged = mission.state === 'disengaged';
  const runningPhase = currentRunningPhase(kids, sessionNames);
  const sessionName = runningPhase ? taskSessionName(runningPhase) : null;
  const live = !!(sessionName && sessionNames.includes(sessionName));
  const signal = sessionName ? signals[sessionName] : undefined;
  const stall = useSessionStall(sessionName ?? '', live && !!sessionName);
  const cap = epicCapacity(kids, sessionNames, mission.max_sessions);

  return (
    <div className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-elevated">
      <div className="flex items-center gap-2">
        <Link href="/tasks" className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{epic?.title ?? mission.epic_id}</span>
        </Link>
        {!disengaged && !paused ? <CapacityMeter running={cap.running} max={cap.max} /> : null}
        <Badge tone={disengaged ? 'muted' : paused ? 'warning' : 'accent'}>{paused ? t.missions.statePaused : disengaged ? t.missions.stateDisengaged : t.missions.stateActive}</Badge>
      </div>
      <div className="flex items-center gap-2">
        <ProgressRibbon phases={kids} className="flex-1" />
      </div>
      {runningPhase ? (
        <div className="flex items-center gap-2 text-[11px] text-text-muted">
          <AgentStatusDot signal={signal} live={live} size="sm" stall={stall.state} silenceSec={stall.silenceSec} />
          <span className="truncate">{runningPhase.title}</span>
        </div>
      ) : (
        <div className="text-[11px] text-text-muted">{t.missions.noTasks}</div>
      )}
      <div className="flex items-center gap-1">
        {disengaged ? null
          : paused ? <IconButton icon={Play} label={t.missions.resume} onClick={onResume} />
          : <IconButton icon={Pause} label={t.missions.pause} onClick={onPause} />}
        <IconButton icon={Power} label={t.missions.disengage} variant="danger" onClick={onDisengage} />
      </div>
    </div>
  );
}

function AutopilotSpotlight({ missions, tasks, sessionNames, signals, onPause, onResume, onDisengage, isLoading, isError, onRetry }: {
  missions: Mission[];
  tasks: Task[];
  sessionNames: string[];
  signals: Record<string, DerivedSignal>;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDisengage: (id: string) => void;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const active = missions.filter((m) => m.state !== 'disengaged');

  return (
    <section className="flex flex-col rounded-lg border border-border bg-surface" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2"><Rocket size={15} className="text-text-muted" aria-hidden /><h2 className="text-sm font-medium text-text">{t.dashboard.autopilotSpotlight}</h2></div>
        <Link href="/tasks" className="inline-flex items-center gap-1 text-xs font-medium text-accent transition-opacity hover:opacity-80">{t.dashboard.viewAll}<ArrowRight size={12} aria-hidden /></Link>
      </div>
      <p className="flex items-center gap-1.5 px-4 py-2 text-[11px] text-text-muted"><Sparkles size={12} className="shrink-0 text-text-muted" aria-hidden />{t.dashboard.autopilotSpotlightDesc}</p>
      {isLoading ? <div className="p-4"><LoadingState /></div>
        : isError ? <div className="p-4"><ErrorState message={t.common.daemonUnreachable} onRetry={onRetry} /></div>
        : active.length === 0 ? <EmptyState title={t.dashboard.noActiveMissions} icon={Rocket} />
        : (
          <div className="flex flex-col divide-y divide-border">
            {active.map((m) => {
              const epic = tasks.find((x) => x.id === m.epic_id);
              const kids = tasks.filter((x) => x.parent_id === m.epic_id);
              return (
                <MissionSpotlightRow
                  key={m.id}
                  mission={m}
                  epic={epic}
                  kids={kids}
                  sessionNames={sessionNames}
                  signals={signals}
                  onPause={() => onPause(m.id)}
                  onResume={() => onResume(m.id)}
                  onDisengage={() => onDisengage(m.id)}
                />
              );
            })}
          </div>
        )}
    </section>
  );
}
