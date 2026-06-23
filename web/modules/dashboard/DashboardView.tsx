'use client';
import Link from 'next/link';
import { ListChecks, Rocket, ArrowRight, Plus, Radio, CircleCheckBig, Pause, Play, Power, Zap, Circle, LoaderCircle, Ban, Sparkles, type LucideIcon } from 'lucide-react';
import { useTasks, useSessions, useMissions, useSessionSignals } from '../../lib/queries';
import { usePauseMission, useResumeMission, useDisengage } from '../../lib/mutations';
import { deriveDashboardMetrics } from './metrics';
import { statusTone } from './statusTone';
import { Badge } from '../../components/ui/Badge';
import type { Tone } from '../../components/ui/tone';
import { OutcomeBadge } from '../../components/ui/OutcomeBadge';
import { NeedsInputBanner } from '../../components/ui/NeedsInputBanner';
import { ProgressRibbon } from '../../components/ui/ProgressRibbon';
import { AgentStatusDot } from '../../components/ui/AgentStatusDot';
import { IconButton } from '../../components/ui/IconButton';
import { CapacityMeter } from '../../components/ui/CapacityMeter';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useSessionPane } from '../../lib/useSessionPane';
import { tailSnippet, taskSessionName, taskForSession } from '../../lib/agentUtils';
import { parseTs } from '../../lib/format';
import { useSessionStall } from '../../lib/useSessionStall';
import { sessionActivity } from '../../lib/sessionActivity';
import { epicCapacity } from '../../lib/taskTree';
import { taskExec } from '../../lib/agentUtils';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { taskTypeMeta, statusLabel } from '../tasks/taskMeta';
import type { Task, DerivedSignal, Mission } from '../../lib/types';

/** A single live agent lane in the hero: status pulse, model icon, name, current activity line. */
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
      <span className="shrink-0 font-mono text-xs text-text">{name}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">{line}</span>
      <Badge tone={activityTone as Tone}>{t.activity[activity]}</Badge>
    </Link>
  );
}

function Metric({ value, label, tone, icon: Icon }: { value: number; label: string; tone?: 'accent' | 'danger'; icon?: LucideIcon }) {
  return (
    <span className="flex items-baseline gap-1.5">
      {Icon ? <Icon size={12} className="shrink-0 self-center text-text-muted" aria-hidden /> : null}
      <span className={`font-mono text-xl tabular-nums ${tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent' : 'text-text'}`}>{value}</span>
      <span className="text-[11px] uppercase tracking-wide text-text-muted">{label}</span>
    </span>
  );
}

export function DashboardView() {
  const { t } = useTranslation();
  const tasks = useTasks();
  const sessions = useSessions();
  const missions = useMissions();
  const signals = useSessionSignals();
  const pause = usePauseMission();
  const resume = useResumeMission();
  const disengage = useDisengage();
  const { toast } = useToast();

  const metrics = deriveDashboardMetrics(tasks.data, sessions.data, missions.data);
  const MISSION_STATE_LABEL: Record<string, string> = { active: t.missions.stateActive, paused: t.missions.paused, disengaged: t.missions.stateDisengaged, stalled: t.missions.stateStalled };

  const live = (sessions.data ?? []).slice(0, 6);
  const taskFor = (s: string): Task | undefined => taskForSession(tasks.data ?? [], s);
  const recent = (tasks.data ?? []).filter((x) => x.type !== 'epic').slice(0, 6);
  // Last 6 closed tasks, newest first, for the outcomes column.
  const outcomes = (tasks.data ?? [])
    .filter((x) => x.status === 'closed' && x.type !== 'epic')
    .sort((a, b) => (parseTs(b.closed_at) ?? 0) - (parseTs(a.closed_at) ?? 0))
    .slice(0, 6);

  return (
    <div className="flex w-full flex-col gap-5">
      <NeedsInputBanner />

      {/* ── Hero: NOW ─────────────────────────────────────────── */}
      <section className="rounded-lg border border-border border-t-2 border-t-accent/40 bg-surface p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-widest text-text-muted"><Zap size={12} className="text-accent" aria-hidden />{t.dashboard.now}</span>
          <span className="h-5 w-px bg-border" aria-hidden />
          <Metric value={metrics.inProgress} label={t.dashboard.inProgress} tone="accent" icon={LoaderCircle} />
          <Metric value={metrics.open} label={t.dashboard.open} icon={Circle} />
          <Metric value={metrics.blocked} label={t.dashboard.blocked} tone={metrics.blocked > 0 ? 'danger' : undefined} icon={Ban} />
          <Metric value={metrics.liveSessions} label={t.dashboard.liveSessions} icon={Radio} />
          <Metric value={metrics.activeMissions} label={t.dashboard.activeMissions} icon={Rocket} />
        </div>

        <div className="mt-4 flex flex-col gap-2">
          {live.length > 0
            ? live.map((s) => <LiveLane key={s} name={s} task={taskFor(s)} />)
            : <div className="flex flex-col items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted"><Radio size={14} aria-hidden />{t.dashboard.nothingRunning}</div>}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Link href="/tasks?new=1" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-accent bg-accent px-3.5 text-sm font-medium text-white transition-opacity hover:opacity-90"><Plus size={14} aria-hidden />{t.tasks.newTask}</Link>
          <Link href="/tasks?new=1" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-elevated px-3.5 text-sm font-medium text-text transition-colors hover:border-border-strong"><Rocket size={14} aria-hidden />{t.missions.newMission}</Link>
        </div>
      </section>

      {/* ── Workspace: recent tasks · missions ───────────────────── */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* recent tasks */}
        <section className="flex flex-col rounded-lg border border-border bg-surface" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2"><ListChecks size={15} className="text-text-muted" aria-hidden /><h2 className="text-sm font-medium text-text">{t.page.tasks}</h2></div>
            <Link href="/tasks" className="inline-flex items-center gap-1 text-xs font-medium text-accent transition-opacity hover:opacity-80">{t.dashboard.viewAll}<ArrowRight size={12} aria-hidden /></Link>
          </div>
          {tasks.isLoading ? <div className="p-4"><LoadingState /></div>
            : tasks.isError ? <div className="p-4"><ErrorState message={t.common.daemonUnreachable} onRetry={() => tasks.refetch()} /></div>
            : recent.length === 0 ? <EmptyState title={t.tasks.empty} icon={ListChecks} />
            : (
              <div className="flex flex-col divide-y divide-border">
                {recent.map((task) => {
                  const Icon = taskTypeMeta(task.type).icon;
                  return (
                    <Link key={task.id} href="/tasks" className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-elevated">
                      <Icon size={14} className="shrink-0 text-text-muted" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-sm text-text">{task.title}</span>
                      <Badge tone={statusTone(task.status)}>{statusLabel(t, task.status)}</Badge>
                    </Link>
                  );
                })}
              </div>
            )}
        </section>

        {/* missions */}
        <section className="flex flex-col rounded-lg border border-border bg-surface" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2"><Rocket size={15} className="text-text-muted" aria-hidden /><h2 className="text-sm font-medium text-text">{t.page.missions}</h2></div>
            <Link href="/tasks" className="inline-flex items-center gap-1 text-xs font-medium text-accent transition-opacity hover:opacity-80">{t.dashboard.viewAll}<ArrowRight size={12} aria-hidden /></Link>
          </div>
          {missions.isLoading ? <div className="p-4"><LoadingState /></div>
            : missions.isError ? <div className="p-4"><ErrorState message={t.common.daemonUnreachable} onRetry={() => missions.refetch()} /></div>
            : !missions.data || missions.data.length === 0 ? <EmptyState title={t.missions.empty} icon={Rocket} />
            : (
              <div className="flex flex-col divide-y divide-border">
                {missions.data.map((m) => {
                  const epic = tasks.data?.find((x) => x.id === m.epic_id);
                  const kids = (tasks.data ?? []).filter((x) => x.parent_id === m.epic_id);
                  const done = kids.filter((x) => x.status === 'closed' || x.status === 'cancelled').length;
                  const liveKids = kids.filter((x) => x.status === 'in_progress');
                  const needs = liveKids.filter((x) => { const s = taskSessionName(x); return s ? signals[s]?.type === 'needs_input' : false; }).length;
                  return (
                    <Link key={m.id} href="/tasks" className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-elevated">
                      <span className="min-w-0 flex-1 truncate text-sm text-text">{epic?.title ?? m.epic_id}</span>
                      {needs > 0 ? <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-warning" title={t.agent.needsInput}><span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />{needs}</span> : null}
                      {liveKids.length > 0 ? <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-success" title={t.agent.working}><span className="live-dot h-1.5 w-1.5 rounded-full bg-success" style={{ ['--live-ring' as string]: 'color-mix(in srgb, var(--color-success) 50%, transparent)' }} aria-hidden />{liveKids.length}</span> : null}
                      <span className="shrink-0 font-mono text-[11px] text-text-muted">{done}/{kids.length}</span>
                      {m.state !== 'disengaged' ? (() => { const cap = epicCapacity(kids, sessions.data ?? [], m.max_sessions); return <CapacityMeter running={cap.running} max={cap.max} />; })() : null}
                      <Badge tone={m.state === 'disengaged' ? 'muted' : 'accent'}>{MISSION_STATE_LABEL[m.state] ?? m.state}</Badge>
                    </Link>
                  );
                })}
              </div>
            )}
        </section>
      </div>

      {/* ── Autopilot spotlight ──────────────────────────────────── */}
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

      {/* ── Recent outcomes ──────────────────────────────────────── */}
      {outcomes.length > 0 && (
        <section className="flex flex-col rounded-lg border border-border bg-surface" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2"><CircleCheckBig size={15} className="text-text-muted" aria-hidden /><h2 className="text-sm font-medium text-text">{t.dashboard.recentOutcomes}</h2></div>
          </div>
          <div className="flex flex-col divide-y divide-border">
            {outcomes.map((task) => (
              <Link key={task.id} href={`/tasks?select=${encodeURIComponent(task.id)}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-elevated">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text">{task.title}</span>
                  <span className="block truncate text-[11px] text-text-muted">{task.result_summary?.trim() || t.tasks.noSummary}</span>
                </span>
                <OutcomeBadge outcome={task.outcome} />
              </Link>
            ))}
          </div>
        </section>
      )}
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
    <section className="flex flex-col rounded-lg border border-border border-t-2 border-t-accent/40 bg-surface" style={{ boxShadow: 'var(--shadow-card)' }}>
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
