'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, Clock, Columns3, ArrowUpRight, FileDiff } from 'lucide-react';
import { useActivity, useProjectChanged, useProjectChanges, useProjects, useProjectsCommits, useTasks } from '../../lib/queries';
import { parseTs } from '../../lib/format';
import { ChangesOverTime } from './ChangesOverTime';
import { plotAxis, type AxisEvent, type AxisPoint } from './axis';
import { eventIcon, markerTone } from './eventMeta';
import { Segmented, type SegmentedOption } from '../../components/ui/Segmented';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { ProjectPill } from '../../components/ui/ProjectPill';
import type { Task } from '../../lib/types';
import { PatchView } from '../projects/editor/PatchView';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import type { Tone } from '../../components/ui/tone';
import { useTranslation } from '../../lib/i18n';
import { usePersistentState } from '../../lib/usePersistentState';

const WINDOW_MAX_HOURS = 168; // cap the axis window at one week

const TONE_DOT: Record<Tone, string> = {
  accent: 'bg-accent', danger: 'bg-danger', success: 'bg-success',
  warning: 'bg-warning', muted: 'bg-text-muted', default: 'bg-text-muted',
};
const TONE_TEXT: Record<Tone, string> = {
  accent: 'text-accent', danger: 'text-danger', success: 'text-success',
  warning: 'text-warning', muted: 'text-text-muted', default: 'text-text-muted',
};
/** Soft tinted bubble (border + fill) for an icon in the given tone. */
const TONE_BUBBLE: Record<Tone, string> = {
  accent: 'border-accent/40 bg-accent/10 text-accent',
  danger: 'border-danger/40 bg-danger/10 text-danger',
  success: 'border-success/40 bg-success/10 text-success',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  muted: 'border-border bg-elevated text-text-muted',
  default: 'border-border bg-elevated text-text-muted',
};

/** "12:05" style clock label. */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A target like "orca-ab12cd34" / "m-orca-ep" → the task id we can drill into ("orca-ab12cd34"),
 *  or null when the target isn't a task (mission/session). Mirrors the event→project linkage. */
function taskIdOf(p: { type: string; target: string }): string | null {
  return p.type === 'task' || p.type === 'review' ? p.target : null;
}

export interface Display { label: string; projectId: number | null }

/** Resolve an event's raw target into a human label + the project it belongs to, so the timeline
 *  reads "Refactor the parser" / "Juno" instead of "orca-ab12cd34" / "orca-Juno":
 *   - mission `m-<epicId>` → the epic's title
 *   - task/review (target = task id) → the task title
 *   - signal (agent session `orca-<name>`) → the agent name + its worker task's project
 *  Falls back to the raw target (and the event's own project) when nothing resolves. */
function resolveDisplay(p: { type: string; target: string; projectId?: number | null }, byId: Map<string, Task>, byAgent: Map<string, Task>, byLabel: Map<string, string>): Display {
  // Prefer the live task/epic title; fall back to the label snapshotted on the event at write time
  // (so a deleted task still reads as a name instead of a raw orca-<id>), then the raw target.
  if (p.target.startsWith('m-')) {
    const epic = byId.get(p.target.slice(2));
    return { label: epic?.title ?? byLabel.get(p.target) ?? p.target, projectId: epic?.project_id ?? p.projectId ?? null };
  }
  if (p.type === 'task' || p.type === 'review') {
    const t = byId.get(p.target);
    return { label: t?.title ?? byLabel.get(p.target) ?? p.target, projectId: p.projectId ?? t?.project_id ?? null };
  }
  if (p.target.startsWith('orca-')) {
    const name = p.target.slice('orca-'.length);
    const t = byAgent.get(name);
    return { label: name, projectId: t?.project_id ?? p.projectId ?? null };
  }
  return { label: p.target, projectId: p.projectId ?? null };
}

function AxisMarker({ point, label, onPick }: { point: AxisPoint; label: string; onPick: (p: AxisPoint) => void }) {
  const tone = markerTone(point.type, point.detail);
  // Scale the dot with the collapsed count so busy runs read as heavier.
  const size = Math.min(20, 11 + Math.floor(Math.log2(point.count + 1)) * 2);
  const tip = `${label} · ${point.detail} · ${clock(point.timestamp)}${point.count > 1 ? ` · ×${point.count}` : ''}`;
  return (
    <div
      className="group absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${point.frac * 100}%` }}
    >
      <button
        type="button"
        data-testid="axis-dot"
        onClick={() => onPick(point)}
        className={`block animate-pop-in cursor-pointer rounded-full border-2 border-surface shadow-sm transition-transform hover:scale-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${TONE_DOT[tone]}`}
        style={{ width: size, height: size, transitionDuration: 'var(--motion-fast)' }}
        aria-label={tip}
      />
      {/* Hover tooltip — wraps to a fixed max width (long task titles), and anchors to the marker's
          near edge when it sits at the start/end of the axis so it never clips off the side. */}
      <div
        role="tooltip"
        className={`pointer-events-none absolute bottom-full z-10 mb-2 hidden w-max max-w-[18rem] whitespace-normal break-words rounded-md border border-border bg-elevated px-2.5 py-1.5 text-xs text-text group-hover:block ${point.frac < 0.12 ? 'left-0' : point.frac > 0.88 ? 'right-0' : 'left-1/2 -translate-x-1/2'}`}
        style={{ boxShadow: 'var(--shadow-raised)' }}
      >
        <span className="text-text">{label}</span>
        <span className="text-text-muted"> · {point.detail} · {clock(point.timestamp)}</span>
        {point.count > 1 ? <span className="text-text-muted"> · ×{point.count}</span> : null}
      </div>
    </div>
  );
}

function TimelineTrack({ points, ticks, resolve, onPick }: { points: AxisPoint[]; ticks: { label: string; frac: number }[]; resolve: (p: AxisPoint) => Display; onPick: (p: AxisPoint) => void }) {
  return (
    <div className="relative w-full select-none">
      <div className="relative h-16">
        {ticks.map((t) => (
          <div key={t.label} className="absolute inset-y-0 w-px bg-border/50" style={{ left: `${t.frac * 100}%` }} aria-hidden />
        ))}
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" aria-hidden />
        {/* "Now" edge with a live pulse */}
        <div className="absolute inset-y-0 right-0 w-px bg-accent/40" aria-hidden>
          <span className="live-dot absolute -top-0.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-accent" style={{ ['--live-ring' as string]: 'color-mix(in srgb, var(--color-info) 50%, transparent)' }} />
        </div>
        {points.map((p) => <AxisMarker key={p.id} point={p} label={resolve(p).label} onPick={onPick} />)}
      </div>
      <div className="relative mt-1.5 h-4">
        {ticks.map((t) => (
          <span key={t.label} data-testid="axis-tick" className="absolute -translate-x-1/2 font-mono text-text-muted" style={{ left: `${t.frac * 100}%`, fontSize: 'var(--text-caption)' }}>
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A swimlane: a big tinted icon for the lane's latest kind, a human label (agent name / task or
 *  epic title) with its project pill, the latest status, and the event track. Clicking a marker
 *  drills into that event. */
function Lane({ points, ticks, resolve, onPick }: { points: AxisPoint[]; ticks: { label: string; frac: number }[]; resolve: (p: AxisPoint) => Display; onPick: (p: AxisPoint) => void }) {
  const latest = points.reduce((a, b) => (b.timestamp > a.timestamp ? b : a), points[0]!);
  const Icon = eventIcon(latest.type);
  const tone = markerTone(latest.type, latest.detail);
  const { label, projectId } = resolve(latest);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5">
      <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 ${TONE_BUBBLE[tone]}`}>
        <Icon size={24} aria-hidden />
      </span>
      <div className="w-44 shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-text" title={label}>{label}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className={`shrink-0 text-[11px] ${TONE_TEXT[tone]}`}>{latest.detail}</span>
          <ProjectPill projectId={projectId ?? undefined} />
        </div>
      </div>
      <div className="relative h-9 flex-1">
        {ticks.map((t) => <div key={t.label} className="absolute inset-y-0 w-px bg-border/40" style={{ left: `${t.frac * 100}%` }} aria-hidden />)}
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border/60" aria-hidden />
        {points.map((p) => <AxisMarker key={p.id} point={p} label={resolve(p).label} onPick={onPick} />)}
      </div>
    </div>
  );
}

/** Big-icon stat card for the summary strip. */
function StatCard({ tone, count, label }: { tone: Tone; count: number; label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-3">
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 text-lg font-semibold ${TONE_BUBBLE[tone]}`}>
        {count}
      </span>
      <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</span>
    </div>
  );
}

/** Drill-down: full event detail + the project's working-tree diff (for task/review events that
 *  carry a project). Reuses the existing PatchView so diff rendering stays single-source. */
function EventDetail({ point, display, onClose }: { point: AxisPoint; display: Display; onClose: () => void }) {
  const { t } = useTranslation();
  const Icon = eventIcon(point.type);
  const tone = markerTone(point.type, point.detail);
  const projectId = display.projectId;
  const taskId = taskIdOf(point);
  const changed = useProjectChanged(projectId);
  const changes = useProjectChanges(projectId, true);
  return (
    <Modal title={display.label} description={`${point.detail} · ${clock(point.timestamp)}`} icon={Icon} size="lg" onClose={onClose}>
      <div className="flex h-full flex-col gap-4 overflow-hidden p-5">
        <div className="flex flex-wrap items-start gap-3">
          <span className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border-2 ${TONE_BUBBLE[tone]}`}>
            <Icon size={30} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={tone}>{point.detail}</Badge>
              {point.count > 1 ? <span className="text-xs text-text-muted">×{point.count}</span> : null}
              <ProjectPill projectId={projectId ?? undefined} />
            </div>
            <div className="mt-1 text-sm font-medium text-text">{display.label}</div>
          </div>
          {taskId ? (
            <Link href={`/tasks?select=${encodeURIComponent(taskId)}`} className="inline-flex w-full shrink-0 items-center justify-center gap-1 rounded-md border border-border bg-elevated px-2.5 py-1.5 text-xs text-text transition-colors hover:text-accent sm:w-auto sm:justify-start">
              <ArrowUpRight size={14} aria-hidden />{t.timeline.openTask}
            </Link>
          ) : null}
        </div>

        {changed.data?.changed?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {changed.data.changed.slice(0, 12).map((f) => (
              <span key={f} className="inline-flex items-center gap-1 rounded-md border border-border bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-text-muted">
                <FileDiff size={11} aria-hidden />{f}
              </span>
            ))}
          </div>
        ) : null}

        {projectId ? (
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
            {changes.isLoading ? <LoadingState /> : <PatchView diff={changes.data?.diff ?? ''} empty={t.timeline.noChanges} />}
          </div>
        ) : (
          <p className="rounded-lg border border-border bg-elevated p-4 text-center text-sm text-text-muted">{t.timeline.noChanges}</p>
        )}
      </div>
    </Modal>
  );
}

export function TimelineView() {
  const { t } = useTranslation();
  const [filter, setFilter] = usePersistentState<string>('orca.timeline.filter', 'all', ['all', 'task', 'mission', 'signal', 'review']);
  const [view, setView] = usePersistentState<string>('orca.timeline.view', 'axis', ['axis', 'lanes']);
  const [picked, setPicked] = useState<AxisPoint | null>(null);
  const type = filter === 'all' ? undefined : filter;
  const q = useActivity(type);
  const tasks = useTasks();

  // Index tasks two ways so a raw event target reads as a human label: by id (task/review/mission
  // epic) and by the worker session name carried in an `agent:<name>` label (signal events).
  const { byId, byAgent } = useMemo(() => {
    const byId = new Map<string, Task>();
    const byAgent = new Map<string, Task>();
    for (const task of tasks.data ?? []) {
      byId.set(task.id, task);
      const agent = task.labels?.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
      if (agent) byAgent.set(agent, task);
    }
    return { byId, byAgent };
  }, [tasks.data]);
  // target → label snapshotted on its events, so a deleted task/epic still shows its name.
  const byLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of q.data ?? []) if (e.label) m.set(e.target, e.label);
    return m;
  }, [q.data]);
  const resolve = useMemo(() => (p: { type: string; target: string; projectId?: number | null }) => resolveDisplay(p, byId, byAgent, byLabel), [byId, byAgent, byLabel]);

  const FILTER_OPTIONS: SegmentedOption[] = [
    { label: t.timeline.filterAll, value: 'all' },
    { label: t.timeline.filterTasks, value: 'task' },
    { label: t.timeline.filterMissions, value: 'mission' },
    { label: t.timeline.filterSignals, value: 'signal' },
    { label: t.timeline.filterReviews, value: 'review' },
  ];

  const rawEvents = useMemo<AxisEvent[]>(
    () =>
      (q.data ?? []).flatMap((e) => {
        const ts = parseTs(e.ts);
        if (ts == null) return [];
        return [{ id: String(e.id), type: e.type, target: e.target, detail: e.detail, timestamp: ts, projectId: e.project_id }];
      }),
    [q.data],
  );

  // Window = the available data span, capped at one week. Falls back to 12h when empty,
  // and zooms in when all events are recent (so a few-minute run isn't lost on a week axis).
  const windowHours = useMemo(() => {
    if (rawEvents.length === 0) return 12;
    const earliest = Math.min(...rawEvents.map((e) => e.timestamp));
    const spanH = (Date.now() - earliest) / 3_600_000;
    return Math.min(WINDOW_MAX_HOURS, Math.max(1, Math.ceil(spanH)));
  }, [rawEvents]);
  const windowLabel = windowHours >= 144 ? t.timeline.activityWeek
    : windowHours >= 36 ? t.timeline.activityDays.replace('{n}', String(Math.round(windowHours / 24)))
    : t.timeline.activityHours.replace('{n}', String(Math.round(windowHours)));

  const { points, ticks } = useMemo(() => plotAxis(rawEvents, Date.now(), windowHours), [rawEvents, windowHours]);

  // Summary: count the in-window points by kind, with review split into approved/escalated.
  const stats = useMemo(() => {
    const s = { task: 0, mission: 0, signal: 0, approved: 0, escalated: 0 };
    for (const p of points) {
      if (p.type === 'review') p.detail.startsWith('escalated') ? s.escalated++ : s.approved++;
      else if (p.type === 'task') s.task++;
      else if (p.type === 'mission') s.mission++;
      else if (p.type === 'signal') s.signal++;
    }
    return s;
  }, [points]);

  // Swimlanes: one track per target (agent/session/task), busiest-recent first.
  const lanes = useMemo(() => {
    const now = Date.now();
    const byTarget = new Map<string, AxisEvent[]>();
    for (const e of rawEvents) { const list = byTarget.get(e.target) ?? []; list.push(e); byTarget.set(e.target, list); }
    return Array.from(byTarget.entries())
      .map(([target, evs]) => ({ target, points: plotAxis(evs, now, windowHours).points, last: Math.max(...evs.map((e) => e.timestamp)) }))
      .filter((l) => l.points.length > 0)
      .sort((a, b) => b.last - a.last)
      .slice(0, 10);
  }, [rawEvents, windowHours]);

  const hasData = !q.isLoading && !q.isError && rawEvents.length > 0;

  // Merge every accessible project's commit history into one "changes over time" stream below the
  // axis (activity events don't carry a project id, so we scan the projects the user can see).
  const projects = useProjects();
  const projectIds = useMemo(() => (projects.data ?? []).map((p) => p.id), [projects.data]);
  const commitsQ = useProjectsCommits(projectIds, windowHours);

  const STAT_CARDS: { tone: Tone; count: number; label: string }[] = [
    { tone: 'accent', count: stats.task, label: t.timeline.filterTasks },
    { tone: 'accent', count: stats.mission, label: t.timeline.filterMissions },
    { tone: 'success', count: stats.approved, label: t.timeline.approved },
    { tone: 'danger', count: stats.escalated, label: t.timeline.escalated },
    { tone: 'muted', count: stats.signal, label: t.timeline.filterSignals },
  ];

  return (
    <div className="flex flex-col gap-4">
      <ModuleHeader title={t.page.timeline} icon={Activity}>
        <Segmented options={[{ label: t.timeline.axis, value: 'axis', icon: Activity }, { label: t.timeline.lanes, value: 'lanes', icon: Columns3 }]} value={view} onChange={setView} />
        <Segmented options={FILTER_OPTIONS} value={filter} onChange={setFilter} />
      </ModuleHeader>

      {/* Summary strip: big-icon kind counts for the window */}
      {hasData ? (
        <div data-testid="timeline-summary" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          {STAT_CARDS.map((s) => <StatCard key={s.label} tone={s.tone} count={s.count} label={s.label} />)}
        </div>
      ) : null}

      {/* Hero: the lane/axis plot — orca's signature surface */}
      <section className="rounded-lg border border-border border-t-2 border-t-accent/40 bg-surface p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-text-muted"><Clock size={12} className="shrink-0 text-text-muted" aria-hidden />{windowLabel}</div>
          {hasData ? <span className="hidden text-[11px] text-text-muted sm:inline">{t.timeline.markerHint}</span> : null}
        </div>
        {q.isLoading ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState message={t.timeline.loadError} onRetry={() => q.refetch()} />
        ) : !hasData ? (
          <EmptyState title={t.timeline.empty} description={t.timeline.emptyDescription} icon={Activity} />
        ) : view === 'lanes' ? (
          <div className="flex flex-col gap-2.5">
            {lanes.map((l) => <Lane key={l.target} points={l.points} ticks={ticks} resolve={resolve} onPick={setPicked} />)}
            <div className="relative mt-1 ml-[10.25rem] h-4">
              {ticks.map((tk) => (
                <span key={tk.label} className="absolute -translate-x-1/2 font-mono text-text-muted" style={{ left: `${tk.frac * 100}%`, fontSize: 'var(--text-caption)' }}>{tk.label}</span>
              ))}
            </div>
          </div>
        ) : (
          <TimelineTrack points={points} ticks={ticks} resolve={resolve} onPick={setPicked} />
        )}
      </section>

      {/* Changes over time: the commit stream + most-touched files for the same window */}
      {hasData ? (
        <ChangesOverTime
          commits={commitsQ.commits}
          windowStart={Date.now() - windowHours * 3_600_000}
          now={Date.now()}
          multiProject={projectIds.length > 1}
        />
      ) : null}

      {picked ? <EventDetail point={picked} display={resolve(picked)} onClose={() => setPicked(null)} /> : null}
    </div>
  );
}
