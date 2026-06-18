'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Rocket, Plus, Pause, Play, Power, GitBranch } from 'lucide-react';
import { useMissions, useTasks, useMissionDetail, useSessionSignals } from '../../lib/queries';
import { usePauseMission, useResumeMission, useDisengage } from '../../lib/mutations';
import type { Mission } from '../../lib/types';
import type { Tone } from '../../components/ui/tone';
import { taskSessionName } from '../../lib/agentUtils';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { IconButton } from '../../components/ui/IconButton';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { NeedsInputBanner } from '../../components/ui/NeedsInputBanner';
import { ProgressRibbon } from '../../components/ui/ProgressRibbon';
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

// Missions split into rail groups by lifecycle state.
const GROUP_ORDER = ['active', 'paused', 'disengaged'] as const;
type Group = (typeof GROUP_ORDER)[number];
const groupOf = (state: string): Group => (state === 'paused' ? 'paused' : state === 'disengaged' ? 'disengaged' : 'active');

export function MissionsView() {
  const missions = useMissions();
  const tasks = useTasks();
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
        : !missions.data?.length ? <EmptyState title={t.missions.empty} description={t.missions.emptyDescription} icon={Rocket} />
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
  const { t } = useTranslation();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // A different mission resets the selected node.
  useEffect(() => { setSelectedTaskId(null); }, [missionId]);

  if (detail.isLoading) return <LoadingState />;
  if (detail.isError) return <ErrorState message={t.common.daemonUnreachable} onRetry={() => detail.refetch()} />;
  if (!detail.data) return null;

  const d = detail.data;
  const STATE_LABEL: Record<string, string> = { active: t.missions.stateActive, paused: t.missions.statePaused, disengaged: t.missions.stateDisengaged };

  // Live tmux sessions belonging to this mission's tasks (labels live on the full task records).
  const fullById = new Map((allTasks.data ?? []).map((x) => [x.id, x]));
  const missionSessions = d.tasks
    .map((mt) => fullById.get(mt.id))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .map((x) => taskSessionName(x))
    .filter((s): s is string => !!s);

  return (
    <div className="flex flex-col gap-4">
      {/* Compact header + inline metric strip */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Rocket size={16} className="shrink-0 text-text-muted" aria-hidden />
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-text">{d.epic?.title ?? d.mission.epic_id}</h2>
          <Badge tone="accent">{d.mission.autonomy}</Badge>
          <Badge tone={STATE_TONE(d.mission.state)}>{STATE_LABEL[d.mission.state] ?? d.mission.state}</Badge>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <Metric label={t.missions.total} value={d.progress.total} />
          <Metric label={t.missions.done} value={d.progress.closed} />
          <Metric label={t.missions.inProgress} value={d.progress.inProgress} tone={d.progress.inProgress > 0 ? 'accent' : 'muted'} />
          <Metric label={t.missions.blocked} value={d.progress.blocked} tone={d.progress.blocked > 0 ? 'danger' : 'muted'} />
        </div>
      </div>

      {/* Needs-human-attention strip, scoped to this mission's live sessions */}
      <NeedsInputBanner sessions={missionSessions} />

      {/* DAG canvas as hero */}
      <div className="rounded-xl border border-border border-t-2 border-t-accent/40 bg-surface p-3" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
          <GitBranch size={13} aria-hidden />
          {t.missions.taskFlow}
        </div>
        {d.tasks.length === 0
          ? <EmptyState title={t.missions.noTasks} />
          : <DependencyGraph tasks={d.tasks} deps={d.deps} onSelect={setSelectedTaskId} />}
      </div>

      {/* Selected-task detail panel — full task detail resolved by id */}
      <div className="rounded-lg border border-border bg-surface p-4">
        {selectedTaskId ? <TaskDetailPane taskId={selectedTaskId} /> : (
          <p className="py-2 text-center text-sm text-text-muted">{t.missions.selectTaskHint}</p>
        )}
      </div>
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

