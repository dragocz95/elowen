'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Rocket, Plus, Pause, Play, Power, GitBranch, ArrowRight, AlertTriangle } from 'lucide-react';
import { useMissions, useTasks, useMissionDetail, useSessionSignals, useConfig } from '../../lib/queries';
import { usePauseMission, useResumeMission, useDisengage } from '../../lib/mutations';
import type { Mission, MissionTask, MissionDeps, Task, DerivedSignal } from '../../lib/types';
import type { Tone } from '../../components/ui/tone';
import { taskSessionName, taskAgentName } from '../../lib/agentUtils';
import { epicCapacity } from '../../lib/taskTree';
import { useSessions } from '../../lib/queries';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { IconButton } from '../../components/ui/IconButton';
import { AgentStatusDot } from '../../components/ui/AgentStatusDot';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { NeedsInputBanner } from '../../components/ui/NeedsInputBanner';
import { ProgressRibbon } from '../../components/ui/ProgressRibbon';
import { CapacityMeter } from '../../components/ui/CapacityMeter';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { TaskDetailPane } from '../tasks/TaskDetailPane';
import { DependencyGraph } from './DependencyGraph';
import { EngageModal } from './EngageModal';

/** Count of a mission's live children and how many are waiting for input. */
function missionLive(kids: { id: string; status: string; labels?: string[] }[], signals: Record<string, { type: string }>): { live: number; needs: number } {
  const liveKids = kids.filter((k) => k.status === 'in_progress');
  const needs = liveKids.filter((k) => { const s = taskSessionName(k); return s ? signals[s]?.type === 'needs_input' : false; }).length;
  return { live: liveKids.length, needs };
}

/** A dependency is a fail-gate when its source closed with outcome 'fail' or was cancelled. */
function isFailGate(dep: MissionTask): boolean {
  if (dep.status === 'cancelled') return true;
  if (dep.status === 'closed' && dep.outcome === 'fail') return true;
  return false;
}

/** Resolve the current running phase and the next ready/open phase of a mission.
 *  Purely derived from the mission's tasks + deps + live session signals — no backend calls.
 *  - current = the in_progress phase (prefer one whose session is live; else the first in_progress).
 *  - next = the first open phase whose deps are all terminal and none is a fail-gate, ordered
 *    by creation sequence (oldest first). Falls back to the first non-terminal open phase. */
function missionSpotlight(
  tasks: MissionTask[],
  deps: MissionDeps[],
): { current: MissionTask | null; next: MissionTask | null; failedUpstream: MissionTask[] } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depsOf = new Map<string, string[]>();
  for (const d of deps) {
    if (byId.has(d.taskId) && byId.has(d.dependsOnId)) {
      const list = depsOf.get(d.taskId) ?? [];
      list.push(d.dependsOnId);
      depsOf.set(d.taskId, list);
    }
  }
  const isTerminal = (s: string) => s === 'closed' || s === 'cancelled';

  const current = tasks.find((t) => t.status === 'in_progress') ?? null;

  const failedUpstream: MissionTask[] = [];
  for (const t of tasks) {
    const ds = depsOf.get(t.id) ?? [];
    if (ds.some((id) => { const dep = byId.get(id); return dep ? isFailGate(dep) : false; })) failedUpstream.push(t);
  }

  const next = tasks
    .find((t) => t.status === 'open' && (depsOf.get(t.id) ?? []).every((id) => { const dep = byId.get(id); return dep ? isTerminal(dep.status) && !isFailGate(dep) : false; }))
    ?? tasks.find((t) => t.status === 'open' && !isTerminal(t.status))
    ?? null;

  return { current, next, failedUpstream };
}

// Missions split into rail groups by lifecycle state.
const GROUP_ORDER = ['active', 'paused', 'disengaged'] as const;
type Group = (typeof GROUP_ORDER)[number];
const groupOf = (state: string): Group => (state === 'paused' ? 'paused' : state === 'disengaged' ? 'disengaged' : 'active');

export function MissionsView() {
  const missions = useMissions();
  const tasks = useTasks();
  const sessions = useSessions();
  const signals = useSessionSignals();
  const pause = usePauseMission();
  const resume = useResumeMission();
  const disengage = useDisengage();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [engaging, setEngaging] = useState(false);

  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => { if (params.get('new') === '1') { setEngaging(true); router.replace('/missions'); } }, [params, router]);

  const epicTitle = (epicId: string) => tasks.data?.find((task) => task.id === epicId)?.title ?? epicId;

  const grouped = useMemo(() => {
    const map: Record<Group, Mission[]> = { active: [], paused: [], disengaged: [] };
    for (const m of missions.data ?? []) map[groupOf(m.state)].push(m);
    return map;
  }, [missions.data]);

  // Auto-select the first active mission once data lands and nothing is picked yet.
  useEffect(() => {
    if (selectedId || !missions.data?.length) return;
    const first = grouped.active[0] ?? grouped.paused[0] ?? missions.data[0];
    if (first) setSelectedId(first.id);
  }, [missions.data, grouped, selectedId]);

  const GROUP_LABEL: Record<Group, string> = { active: t.missions.groupActive, paused: t.missions.groupPaused, disengaged: t.missions.groupDisengaged };

  return (
    <>
      <ModuleHeader title={t.page.missions} count={missions.data?.length} icon={Rocket}>
        <Button variant="accent" icon={Plus} onClick={() => setEngaging(true)}>{t.missions.newMission}</Button>
      </ModuleHeader>

      {missions.isLoading ? <LoadingState />
        : missions.isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={() => missions.refetch()} />
        : !missions.data?.length ? <EmptyState title={t.missions.empty} description={t.missions.emptyDescription} icon={Rocket} action={<Button variant="accent" icon={Plus} onClick={() => setEngaging(true)}>{t.missions.newMission}</Button>} />
        : (
          <div className="flex flex-col gap-6 md:flex-row md:items-start">
            {/* Left rail — mission list grouped by state */}
            <nav
              aria-label={t.page.missions}
              className="flex shrink-0 flex-col gap-4 md:sticky md:top-[57px] md:w-[280px]"
            >
              {GROUP_ORDER.map((g) => {
                const items = grouped[g];
                if (!items.length) return null;
                return (
                  <div key={g} className="flex flex-col gap-1.5">
                    <span className="px-1 text-[11px] font-medium uppercase tracking-wide text-text-muted">{GROUP_LABEL[g]}</span>
                    {items.map((m) => {
                      const kids = (tasks.data ?? []).filter((task) => task.parent_id === m.epic_id);
                      const done = kids.filter((task) => task.status === 'closed' || task.status === 'cancelled').length;
                      const total = kids.length;
                      const paused = m.state === 'paused';
                      const disengaged = m.state === 'disengaged';
                      const isActive = selectedId === m.id;
                      return (
                        <div
                          key={m.id}
                          role="button"
                          tabIndex={0}
                          aria-pressed={isActive}
                          onClick={() => setSelectedId(m.id)}
                          onKeyDown={(e) => { if (e.key === 'Enter') setSelectedId(m.id); }}
                          className={`group flex cursor-pointer flex-col gap-1.5 rounded-lg border px-3 py-2.5 transition-colors ${
                            isActive ? 'border-accent bg-accent/[0.06]' : 'border-border bg-surface hover:bg-elevated/50'
                          }`}
                          style={{ transitionDuration: 'var(--motion-fast)' }}
                        >
                          <div className="flex items-start gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{epicTitle(m.epic_id)}</span>
                            <Badge tone={disengaged ? 'muted' : 'accent'}>{disengaged ? t.missions.stateDisengaged : paused ? t.missions.statePaused : m.autonomy}</Badge>
                          </div>
                          <div className="flex items-center gap-2">
                            <ProgressRibbon phases={kids} className="flex-1" />
                            <span className="shrink-0 font-mono text-[11px] text-text-muted">{t.missions.progressDone.replace('{done}', String(done)).replace('{total}', String(total))}</span>
                          </div>
                          {(() => { const { live, needs } = missionLive(kids, signals); return (live > 0 || needs > 0) ? (
                            <div className="flex items-center gap-2">
                              {needs > 0 ? <span className="flex items-center gap-1 text-[11px] font-medium text-warning" title={t.agent.needsInput}><span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />{needs}</span> : null}
                              {live > 0 ? <span className="flex items-center gap-1 text-[11px] font-medium text-success" title={t.agent.working}><span className="live-dot h-1.5 w-1.5 rounded-full bg-success" style={{ ['--live-ring' as string]: 'color-mix(in srgb, var(--color-success) 50%, transparent)' }} aria-hidden />{live}</span> : null}
                            </div>
                          ) : null; })()}
                          {!disengaged ? (() => { const cap = epicCapacity(kids, sessions.data ?? [], m.max_sessions); return <CapacityMeter running={cap.running} max={cap.max} />; })() : null}
                          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                            {paused
                              ? <IconButton icon={Play} label={t.missions.resume} onClick={() => resume.mutate(m.id, { onSuccess: () => toast(t.missions.resumed), onError: (e) => toast(String(e), 'error') })} />
                              : <IconButton icon={Pause} label={t.missions.pause} onClick={() => pause.mutate(m.id, { onSuccess: () => toast(t.missions.pausedMsg), onError: (e) => toast(String(e), 'error') })} />}
                            <ActionMenu
                              label={t.missions.disengage}
                              items={[{ label: t.missions.disengage, icon: Power, tone: 'danger', onSelect: () => disengage.mutate(m.id, { onSuccess: () => toast(t.missions.disengaged), onError: (e) => toast(String(e), 'error') }) }]}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </nav>

            {/* Right workspace — DAG-as-page for the selected mission */}
            <div className="min-w-0 flex-1">
              {selectedId
                ? <MissionWorkspace missionId={selectedId} />
                : <div className="flex items-center justify-center rounded-lg border border-border bg-surface py-20 text-sm text-text-muted">{t.missions.selectMissionHint}</div>}
            </div>
          </div>
        )}

      {engaging && <EngageModal onClose={() => setEngaging(false)} />}
    </>
  );
}

const STATE_TONE = (state: string): Tone => (state === 'disengaged' ? 'muted' : state === 'paused' ? 'warning' : 'accent');

function MissionWorkspace({ missionId }: { missionId: string }) {
  const detail = useMissionDetail(missionId);
  const allTasks = useTasks();
  const sessions = useSessions();
  const signals = useSessionSignals();
  const { data: config } = useConfig();
  const pause = usePauseMission();
  const resume = useResumeMission();
  const disengage = useDisengage();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // A different mission resets the selected node.
  useEffect(() => { setSelectedTaskId(null); }, [missionId]);

  if (detail.isLoading) return <LoadingState />;
  if (detail.isError) return <ErrorState message={t.common.daemonUnreachable} onRetry={() => detail.refetch()} />;
  if (!detail.data) return null;

  const d = detail.data;
  const STATE_LABEL: Record<string, string> = { active: t.missions.stateActive, paused: t.missions.statePaused, disengaged: t.missions.stateDisengaged };
  const paused = d.mission.state === 'paused';
  const disengagedFlag = d.mission.state === 'disengaged';

  // Read-only "current config" line: planner + overseer + default autonomy.
  const plannerModel = config?.autopilot?.model ?? '—';
  const overseerModel = config?.autopilot?.overseerModel || plannerModel;
  const defaultAutonomy = config?.defaults?.autonomy ?? '—';
  const configLine = t.missions.configSummary
    .replace('{planner}', plannerModel)
    .replace('{overseer}', overseerModel)
    .replace('{autonomy}', defaultAutonomy);

  // Live tmux sessions belonging to this mission's tasks (labels live on the full task records).
  const fullById = new Map((allTasks.data ?? []).map((x) => [x.id, x]));
  const missionSessions = d.tasks
    .map((mt) => fullById.get(mt.id))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .map((x) => taskSessionName(x))
    .filter((s): s is string => !!s);

  const spotlight = missionSpotlight(d.tasks, d.deps);
  const showFailBanner = spotlight.failedUpstream.length > 0;

  const selectPhase = (id: string | null) => setSelectedTaskId(id);

  return (
    <div className="flex flex-col gap-4">
      {/* Compact header + inline metric strip */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Rocket size={16} className="shrink-0 text-text-muted" aria-hidden />
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-text">{d.epic?.title ?? d.mission.epic_id}</h2>
          <Badge tone="accent">{d.mission.autonomy}</Badge>
          <Badge tone={STATE_TONE(d.mission.state)}>{STATE_LABEL[d.mission.state] ?? d.mission.state}</Badge>
          {d.mission.state !== 'disengaged' ? (() => { const cap = epicCapacity(d.tasks, sessions.data ?? [], d.mission.max_sessions); return <CapacityMeter running={cap.running} max={cap.max} />; })() : null}
        </div>
        <p className="text-[11px] text-text-muted" title={t.missions.configSummaryTitle}>{configLine}</p>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <Metric label={t.missions.total} value={d.progress.total} />
          <Metric label={t.missions.done} value={d.progress.closed} />
          <Metric label={t.missions.inProgress} value={d.progress.inProgress} tone={d.progress.inProgress > 0 ? 'accent' : 'muted'} />
          <Metric label={t.missions.blocked} value={d.progress.blocked} tone={d.progress.blocked > 0 ? 'danger' : 'muted'} />
        </div>
      </div>

      {/* Phase spotlight: current phase + arrow + next phase, with mission controls */}
      <PhaseSpotlight
        missionId={d.mission.id}
        state={d.mission.state}
        current={spotlight.current}
        next={spotlight.next}
        fullById={fullById}
        signals={signals}
        sessions={new Set(sessions.data ?? [])}
        paused={paused}
        disengaged={disengagedFlag}
        onSelectPhase={selectPhase}
        onPause={() => pause.mutate(missionId, { onSuccess: () => toast(t.missions.pausedMsg), onError: (e) => toast(String(e), 'error') })}
        onResume={() => resume.mutate(missionId, { onSuccess: () => toast(t.missions.resumed), onError: (e) => toast(String(e), 'error') })}
        onDisengage={() => disengage.mutate(missionId, { onSuccess: () => toast(t.missions.disengaged), onError: (e) => toast(String(e), 'error') })}
      />

      {/* Upstream-fail warning banner */}
      {showFailBanner ? (
        <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/[0.06] p-3 text-sm text-danger" role="alert">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>{t.missions.upstreamFailBanner}</span>
        </div>
      ) : null}

      {/* Needs-human-attention strip, scoped to this mission's live sessions */}
      <NeedsInputBanner sessions={missionSessions} />

      {/* Side-by-side on lg+: DAG on the left, selected-phase detail on the right (sticky aside). */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-5">
        {/* Left — DAG canvas */}
        <div className="rounded-xl border border-border border-t-2 border-t-accent/40 bg-surface p-3 lg:min-w-0 lg:flex-1" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
            <GitBranch size={13} aria-hidden />
            {t.missions.taskFlow}
          </div>
          {d.tasks.length === 0
            ? <EmptyState title={t.missions.noTasks} />
            : <DependencyGraph tasks={d.tasks} deps={d.deps} onSelect={setSelectedTaskId} />}
        </div>

        {/* Right — persistent detail pane, sticky on lg+, independent scroll */}
        <aside className="min-w-0 lg:w-[420px] lg:shrink-0 lg:sticky lg:top-[57px] lg:max-h-[calc(100vh-73px)] lg:overflow-y-auto">
          <div className="rounded-lg border border-border bg-surface p-4" style={{ boxShadow: 'var(--shadow-card)' }}>
            {selectedTaskId ? <TaskDetailPane taskId={selectedTaskId} /> : (
              <p className="py-2 text-center text-sm text-text-muted">{t.missions.selectTaskHint}</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function PhaseSpotlight({
  missionId, state, current, next, fullById, signals, sessions, paused, disengaged, onSelectPhase, onPause, onResume, onDisengage,
}: {
  missionId: string;
  state: string;
  current: MissionTask | null;
  next: MissionTask | null;
  fullById: Map<string, Task>;
  signals: Record<string, DerivedSignal>;
  sessions: Set<string>;
  paused: boolean;
  disengaged: boolean;
  onSelectPhase: (id: string) => void;
  onPause: () => void;
  onResume: () => void;
  onDisengage: () => void;
}) {
  const { t } = useTranslation();
  const currentFull = current ? fullById.get(current.id) : null;
  const nextFull = next ? fullById.get(next.id) : null;
  const currentSession = currentFull ? taskSessionName(currentFull) : null;
  const currentLive = currentSession ? sessions.has(currentSession) : false;
  const currentSignal = currentSession ? signals[currentSession] : undefined;
  const currentAgent = currentFull ? taskAgentName(currentFull) : null;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3" data-mission-id={missionId}>
      {/* Current phase */}
      <button
        type="button"
        disabled={!current}
        onClick={() => current && onSelectPhase(current.id)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-elevated/40 px-3 py-2 text-left transition-colors enabled:hover:border-accent/50 enabled:hover:bg-elevated disabled:opacity-60"
        style={{ transitionDuration: 'var(--motion-fast)' }}
        title={current ? current.title : t.missions.spotlightNoCurrent}
      >
        <span className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-text-muted">{t.missions.spotlightCurrent}</span>
          <span className="flex items-center gap-1.5 min-w-0">
            {current ? <AgentStatusDot signal={currentSignal} live={currentLive} size="sm" /> : null}
            <span className="truncate text-sm font-semibold text-text">{current ? current.title : t.missions.spotlightNoCurrent}</span>
          </span>
          {currentAgent ? (
            <span className="text-[11px] text-text-muted">{t.missions.spotlightAgent}: <span className="font-mono">{currentAgent}</span></span>
          ) : null}
        </span>
      </button>

      {/* Arrow */}
      <ArrowRight size={16} className="shrink-0 text-text-muted" aria-hidden />

      {/* Next phase */}
      <button
        type="button"
        disabled={!next}
        onClick={() => next && onSelectPhase(next.id)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-elevated/40 px-3 py-2 text-left transition-colors enabled:hover:border-accent/50 enabled:hover:bg-elevated disabled:opacity-60"
        style={{ transitionDuration: 'var(--motion-fast)' }}
        title={next ? next.title : t.missions.spotlightNoNext}
      >
        <span className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-text-muted">{t.missions.spotlightNext}</span>
          <span className="truncate text-sm font-semibold text-text">{next ? next.title : t.missions.spotlightNoNext}</span>
        </span>
      </button>

      {/* Mission controls */}
      {!disengaged ? (
        <div className="flex items-center gap-1">
          {paused
            ? <IconButton icon={Play} label={t.missions.resume} onClick={onResume} />
            : <IconButton icon={Pause} label={t.missions.pause} onClick={onPause} />}
          <ActionMenu
            label={t.missions.disengage}
            items={[{ label: t.missions.disengage, icon: Power, tone: 'danger', onSelect: onDisengage }]}
          />
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value, tone = 'muted' }: { label: string; value: number; tone?: 'muted' | 'accent' | 'danger' }) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent' : 'text-text';
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={`font-mono text-lg font-semibold tabular-nums ${color}`}>{value}</span>
      <span className="text-xs text-text-muted">{label}</span>
    </span>
  );
}

