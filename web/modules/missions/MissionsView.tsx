'use client';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Rocket, Plus, Pause, Play, Power, GitBranch, ArrowRight, AlertTriangle, ListChecks, CheckCircle2, LoaderCircle, Ban, Cpu, PlayCircle, SkipForward, type LucideIcon } from 'lucide-react';
import { useMissions, useTasks, useMissionDetail, useSessionSignals, useConfig } from '../../lib/queries';
import { usePauseMission, useResumeMission, useDisengage } from '../../lib/mutations';
import type { MissionTask, MissionDeps, Task, DerivedSignal } from '../../lib/types';
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
import { CapacityMeter } from '../../components/ui/CapacityMeter';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { TaskDetailPane } from '../tasks/TaskDetailPane';
import { TaskFlow } from './TaskFlow';
import { ActiveMissionsBar } from './ActiveMissionsBar';
import { isFailGate, isTerminal } from './missionUtils';
import { EngageModal } from './EngageModal';
import { AddPhaseModal } from './AddPhaseModal';

/** Resolve the current running phase and the next ready/open phase of a mission, derived purely
 *  from its tasks + deps + live signals. */
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

export function MissionsView() {
  const missions = useMissions();
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [engaging, setEngaging] = useState(false);

  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => { if (params.get('new') === '1') { setEngaging(true); router.replace('/missions'); } }, [params, router]);

  // Auto-select a mission once data lands (active first), if nothing is picked yet.
  useEffect(() => {
    if (selectedId || !missions.data?.length) return;
    const rank: Record<string, number> = { active: 0, paused: 1, disengaged: 2 };
    const first = [...missions.data].sort((a, b) => (rank[a.state] ?? 0) - (rank[b.state] ?? 0))[0];
    if (first) setSelectedId(first.id);
  }, [missions.data, selectedId]);

  return (
    <>
      <ModuleHeader title={t.page.missions} count={missions.data?.length} icon={Rocket}>
        <Button variant="accent" icon={Plus} onClick={() => setEngaging(true)}>{t.missions.newMission}</Button>
      </ModuleHeader>

      {missions.isLoading ? <LoadingState />
        : missions.isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={() => missions.refetch()} />
        : !missions.data?.length ? <EmptyState title={t.missions.empty} description={t.missions.emptyDescription} icon={Rocket} action={<Button variant="accent" icon={Plus} onClick={() => setEngaging(true)}>{t.missions.newMission}</Button>} />
        : (
          <div className="flex flex-col gap-6">
            {/* Active missions — horizontal bar across the top */}
            <ActiveMissionsBar missions={missions.data} selectedId={selectedId} onSelect={setSelectedId} />

            {/* Selected mission workspace — full width below the bar */}
            {selectedId
              ? <MissionWorkspace missionId={selectedId} />
              : <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-surface py-20 text-sm text-text-muted"><Rocket size={14} className="shrink-0 text-text-muted/50" aria-hidden />{t.missions.selectMissionHint}</div>}
          </div>
        )}

      {engaging && <EngageModal onClose={() => setEngaging(false)} />}
    </>
  );
}

const STATE_TONE = (state: string): Tone => (state === 'disengaged' ? 'muted' : (state === 'paused' || state === 'stalled') ? 'warning' : 'accent');

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
  const [addingPhase, setAddingPhase] = useState(false);

  // A different mission resets the selected node.
  useEffect(() => { setSelectedTaskId(null); }, [missionId]);

  if (detail.isLoading) return <LoadingState />;
  if (detail.isError) return <ErrorState message={t.common.daemonUnreachable} onRetry={() => detail.refetch()} />;
  if (!detail.data) return null;

  const d = detail.data;
  const STATE_LABEL: Record<string, string> = { active: t.missions.stateActive, paused: t.missions.statePaused, disengaged: t.missions.stateDisengaged, stalled: t.missions.stateStalled };
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
          <Button variant="ghost" icon={Plus} onClick={() => setAddingPhase(true)}>{t.missions.addPhase}</Button>
        </div>
        <p className="flex items-center gap-1.5 text-[11px] text-text-muted" title={t.missions.configSummaryTitle}><Cpu size={11} className="shrink-0 text-text-muted" aria-hidden />{configLine}</p>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <Metric label={t.missions.total} value={d.progress.total} icon={ListChecks} />
          <Metric label={t.missions.done} value={d.progress.closed} icon={CheckCircle2} />
          <Metric label={t.missions.inProgress} value={d.progress.inProgress} tone={d.progress.inProgress > 0 ? 'accent' : 'muted'} icon={LoaderCircle} />
          <Metric label={t.missions.blocked} value={d.progress.blocked} tone={d.progress.blocked > 0 ? 'danger' : 'muted'} icon={Ban} />
        </div>
      </div>

      {/* Phase spotlight: current phase + arrow + next phase, with mission controls */}
      <PhaseSpotlight
        missionId={d.mission.id}
        current={spotlight.current}
        next={spotlight.next}
        fullById={fullById}
        signals={signals}
        sessions={new Set(sessions.data ?? [])}
        paused={paused}
        disengaged={disengagedFlag}
        onSelectPhase={setSelectedTaskId}
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

      {/* TOK ÚKOLŮ — full-width flow whose pills auto-shrink to fit */}
      <div className="rounded-xl border border-border border-t-2 border-t-accent/40 bg-surface p-3" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
          <GitBranch size={13} aria-hidden />
          {t.missions.taskFlow}
        </div>
        {d.tasks.length === 0
          ? <EmptyState title={t.missions.noTasks} />
          : <TaskFlow tasks={d.tasks} deps={d.deps} selectedId={selectedTaskId} onSelect={setSelectedTaskId} />}
      </div>

      {/* Selected-phase detail — below the flow, full width */}
      <div className="rounded-lg border border-border bg-surface p-4" style={{ boxShadow: 'var(--shadow-card)' }}>
        {selectedTaskId ? <TaskDetailPane taskId={selectedTaskId} /> : (
          <p className="flex items-center justify-center gap-2 py-2 text-center text-sm text-text-muted"><ListChecks size={14} className="shrink-0 text-text-muted/50" aria-hidden />{t.missions.selectTaskHint}</p>
        )}
      </div>

      {addingPhase && <AddPhaseModal epicId={d.epic?.id ?? d.mission.epic_id} onClose={() => setAddingPhase(false)} />}
    </div>
  );
}

function PhaseSpotlight({
  missionId, current, next, fullById, signals, sessions, paused, disengaged, onSelectPhase, onPause, onResume, onDisengage,
}: {
  missionId: string;
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
          <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-text-muted"><PlayCircle size={11} className="shrink-0 text-text-muted" aria-hidden />{t.missions.spotlightCurrent}</span>
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
          <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-text-muted"><SkipForward size={11} className="shrink-0 text-text-muted" aria-hidden />{t.missions.spotlightNext}</span>
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

function Metric({ label, value, tone = 'muted', icon: Icon }: { label: string; value: number; tone?: 'muted' | 'accent' | 'danger'; icon?: LucideIcon }) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent' : 'text-text';
  return (
    <span className="flex items-baseline gap-1.5">
      {Icon ? <Icon size={14} className="shrink-0 self-center text-text-muted" aria-hidden /> : null}
      <span className={`font-mono text-lg font-semibold tabular-nums ${color}`}>{value}</span>
      <span className="text-xs text-text-muted">{label}</span>
    </span>
  );
}
