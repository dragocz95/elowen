'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, ChevronDown, ArrowUpRight, Clock, MessageSquareText, Columns3, Rocket } from 'lucide-react';
import { useActivity, useTasks, useConfig, useSessions } from '../../lib/queries';
import { plotAxis, groupEvents, type AxisEvent, type AxisPoint, type GroupedEvent } from './axis';
import { eventIcon, eventTone } from './eventMeta';
import { taskExec } from '../../lib/taskExec';
import { execModel } from '../../lib/modelProvider';
import { useSessionPane } from '../sessions/useSessionPane';
import { parseAnsi } from '../sessions/ansi';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { Segmented, type SegmentedOption } from '../../components/ui/Segmented';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Section } from '../../components/ui/Section';
import { Badge } from '../../components/ui/Badge';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import type { Tone } from '../../components/ui/tone';
import type { Task } from '../../lib/types';
import { useTranslation } from '../../lib/i18n';
import { usePersistentState } from '../../lib/usePersistentState';

const WINDOW_MAX_HOURS = 168; // cap the axis window at one week

/** Parse either ISO ("2026-06-17T12:05:00Z") or SQLite ("2026-06-17 12:05:00") ts → epoch ms. */
function parseTs(ts: string): number {
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
  return Date.parse(iso);
}

const DOT_TONE: Record<Tone, string> = {
  accent: 'bg-accent',
  danger: 'bg-danger',
  muted: 'bg-text-muted',
  default: 'bg-text-muted',
  success: 'bg-success',
  warning: 'bg-warning',
};

/** "12:05" style UTC clock label. */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Colour a feed badge by its detail (status/signal), not just the event kind. */
function detailTone(detail: string): Tone {
  switch (detail) {
    case 'complete': case 'open': return 'success';      // green
    case 'working': case 'in_progress': case 'needs_input': return 'warning'; // amber
    case 'closed': case 'blocked': return 'danger';        // red
    case 'active': return 'accent';
    default: return 'muted';
  }
}

function AxisMarker({ point }: { point: AxisPoint }) {
  const tone = eventTone(point.type);
  // Scale the dot with the collapsed count so busy runs read as heavier.
  const size = Math.min(16, 8 + Math.floor(Math.log2(point.count + 1)) * 2);
  const tip = `${point.target} · ${point.detail} · ${clock(point.timestamp)}${point.count > 1 ? ` · ×${point.count}` : ''}`;
  return (
    <div
      className="group absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${point.frac * 100}%` }}
    >
      <div
        data-testid="axis-dot"
        className={`animate-pop-in rounded-full border-2 border-surface transition-transform group-hover:scale-125 ${DOT_TONE[tone]}`}
        style={{ width: size, height: size, transitionDuration: 'var(--motion-fast)' }}
        aria-label={tip}
      />
      {/* Hover tooltip */}
      <div
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-elevated px-2.5 py-1.5 text-xs text-text group-hover:block"
        style={{ boxShadow: 'var(--shadow-raised)' }}
      >
        <span className="font-mono text-text">{point.target}</span>
        <span className="text-text-muted"> · {point.detail} · {clock(point.timestamp)}</span>
        {point.count > 1 ? <span className="text-text-muted"> · ×{point.count}</span> : null}
      </div>
    </div>
  );
}

function TimelineTrack({ points, ticks }: { points: AxisPoint[]; ticks: { label: string; frac: number }[] }) {
  return (
    <div className="relative w-full select-none">
      {/* Plot area with hour gridlines + baseline */}
      <div className="relative h-12">
        {/* Hour gridlines (one per tick) */}
        {ticks.map((t) => (
          <div
            key={t.label}
            className="absolute inset-y-0 w-px bg-border/50"
            style={{ left: `${t.frac * 100}%` }}
            aria-hidden
          />
        ))}
        {/* Baseline */}
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" aria-hidden />
        {/* "Now" edge with a live pulse */}
        <div className="absolute inset-y-0 right-0 w-px bg-accent/40" aria-hidden>
          <span className="live-dot absolute -top-0.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-accent" style={{ ['--live-ring' as string]: 'color-mix(in srgb, var(--color-info) 50%, transparent)' }} />
        </div>
        {/* Markers */}
        {points.map((p) => (
          <AxisMarker key={p.id} point={p} />
        ))}
      </div>
      {/* Hour tick labels */}
      <div className="relative mt-1.5 h-4">
        {ticks.map((t) => (
          <span
            key={t.label}
            data-testid="axis-tick"
            className="absolute -translate-x-1/2 font-mono text-text-muted"
            style={{ left: `${t.frac * 100}%`, fontSize: 'var(--text-caption)' }}
          >
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function Lane({ target, points, ticks }: { target: string; points: AxisPoint[]; ticks: { label: string; frac: number }[] }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 truncate font-mono text-[11px] text-text-muted" title={target}>{target}</span>
      <div className="relative h-7 flex-1">
        {ticks.map((t) => <div key={t.label} className="absolute inset-y-0 w-px bg-border/40" style={{ left: `${t.frac * 100}%` }} aria-hidden />)}
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border/60" aria-hidden />
        {points.map((p) => <AxisMarker key={p.id} point={p} />)}
      </div>
    </div>
  );
}

/** Small "Autopilot" tag for feed cards whose task is an autopilot phase (an epic child). */
function AutopilotChip() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-tiny font-medium text-accent" title={t.timeline.autopilot}>
      <Rocket size={11} aria-hidden />{t.timeline.autopilot}
    </span>
  );
}

/** Collapsible per-target group: header (model icon + latest status) that expands to the event list.
 *  Re-renders live as `events` updates, even while open (open state is keyed by target). */
function FeedGroup({ target, title, events, exec, href, summary, autopilot, open, onToggle }: { target: string; title?: string; events: GroupedEvent[]; exec?: string; href?: string; summary?: string; autopilot?: boolean; open: boolean; onToggle: () => void }) {
  const latest = events[0]; // newest-first
  const LatestIcon = eventIcon(latest.type);
  const total = events.reduce((s, e) => s + e.count, 0);
  return (
    <div className="relative shrink-0 overflow-hidden rounded-lg border border-border bg-surface">
      {href ? <Link href={href} className="absolute right-9 top-2.5 z-10 text-text-muted transition-colors hover:text-accent" aria-label={target}><ArrowUpRight size={15} aria-hidden /></Link> : null}
      <button type="button" onClick={onToggle} aria-expanded={open} className="relative flex w-full items-center gap-3 px-3 py-2.5 pr-14 text-left transition-colors hover:bg-elevated">
        <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border-2 border-border bg-elevated">
          {exec ? <ModelIcon name={exec} size={38} /> : <LatestIcon size={30} className="text-text-muted" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-text">{title || target}</div>
          {(title || total > 1) ? (
            <div className="truncate font-mono text-[11px] text-text-muted">{[title ? target : null, total > 1 ? `×${total}` : null].filter(Boolean).join(' · ')}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {autopilot ? <AutopilotChip /> : null}
          <Badge tone={detailTone(latest.detail)}>{latest.detail}</Badge>
          {exec ? <span className="inline-flex items-center gap-1 rounded-md border border-border bg-elevated px-1.5 py-0.5 font-mono text-tiny text-text-muted"><ModelIcon name={exec} size={11} />{execModel(exec)}</span> : null}
        </div>
        <ChevronDown size={15} className={`absolute right-3 top-2.5 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        <span className="absolute bottom-2.5 right-3 font-mono text-text-muted" style={{ fontSize: 'var(--text-caption)' }}>{clock(latest.timestamp)}</span>
      </button>
      {open && (
        <div className="divide-y divide-border border-t border-border">
          {summary ? <p className="px-4 py-2 text-[11px] leading-snug text-text-muted">{summary}</p> : null}
          {events.map((e) => {
            const Icon = eventIcon(e.type);
            return (
              <div key={e.id} className="flex items-center gap-3 py-2 pl-4 pr-3">
                <Icon size={13} className="shrink-0 text-text-muted" aria-hidden />
                <Badge tone={detailTone(e.detail)}>{e.detail}{e.count > 1 ? <span className="ml-1 opacity-70">×{e.count}</span> : null}</Badge>
                <span className="ml-auto shrink-0 font-mono text-text-muted" style={{ fontSize: 'var(--text-caption)' }}>{clock(e.timestamp)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Live variant for a running session: header shows what the agent is doing *right now*
 *  (last line of its tmux pane, polled every 2s); expanded shows the live terminal tail. */
function LiveFeedGroup({ target, title, exec, href, ts, autopilot, open, onToggle }: { target: string; title?: string; exec?: string; href?: string; ts: number; autopilot?: boolean; open: boolean; onToggle: () => void }) {
  const { tail } = useSessionPane(target, 24);
  const lines = parseAnsi(tail).map((s) => s.text).join('').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  const current = lines[lines.length - 1] ?? '…';
  return (
    <div className="relative shrink-0 overflow-hidden rounded-lg border border-accent/40 bg-surface">
      {href ? <Link href={href} className="absolute right-9 top-2.5 z-10 text-text-muted transition-colors hover:text-accent" aria-label={target}><ArrowUpRight size={15} aria-hidden /></Link> : null}
      <button type="button" onClick={onToggle} aria-expanded={open} className="relative flex w-full items-center gap-3 px-3 py-2.5 pr-14 text-left transition-colors hover:bg-elevated">
        <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border-2 border-border bg-elevated">
          {exec ? <ModelIcon name={exec} size={38} /> : <Activity size={30} className="text-accent" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-text">{title || target}</div>
          <div className="truncate text-[11px] text-text-muted">{current}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {autopilot ? <AutopilotChip /> : null}
          <Badge tone="warning">working</Badge>
          {exec ? <span className="inline-flex items-center gap-1 rounded-md border border-border bg-elevated px-1.5 py-0.5 font-mono text-tiny text-text-muted"><ModelIcon name={exec} size={11} />{execModel(exec)}</span> : null}
        </div>
        <ChevronDown size={15} className={`absolute right-3 top-2.5 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        <span className="absolute bottom-2.5 right-3 font-mono text-text-muted" style={{ fontSize: 'var(--text-caption)' }}>{clock(ts)}</span>
      </button>
      {open && (
        <pre className="tail-live max-h-80 overflow-auto whitespace-pre-wrap break-all border-t border-border bg-bg p-2.5 font-mono text-xs leading-relaxed text-text-muted">
          {tail ? parseAnsi(tail).map((s, i) => <span key={i} style={s.color ? { color: s.color } : undefined}>{s.text}</span>) : '…'}
        </pre>
      )}
    </div>
  );
}

export function TimelineView() {
  const { t } = useTranslation();
  const tasks = useTasks();
  const sessions = useSessions();
  const { data: config } = useConfig();
  const [filter, setFilter] = usePersistentState<string>('orca.timeline.filter', 'all', ['all', 'task', 'mission', 'signal']);
  const [view, setView] = usePersistentState<string>('orca.timeline.view', 'axis', ['axis', 'lanes']);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const type = filter === 'all' ? undefined : filter;
  const q = useActivity(type);

  const FILTER_OPTIONS: SegmentedOption[] = [
    { label: t.timeline.filterAll, value: 'all' },
    { label: t.timeline.filterTasks, value: 'task' },
    { label: t.timeline.filterMissions, value: 'mission' },
    { label: t.timeline.filterSignals, value: 'signal' },
  ];

  const rawEvents = useMemo<AxisEvent[]>(
    () =>
      (q.data ?? []).flatMap((e) => {
        const t = parseTs(e.ts);
        if (Number.isNaN(t)) return [];
        return [{ id: String(e.id), type: e.type, target: e.target, detail: e.detail, timestamp: t }];
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
  // Feed: most-recent-first, deduped the same way as the axis.
  const feed = useMemo(() => groupEvents(rawEvents).sort((a, b) => b.timestamp - a.timestamp), [rawEvents]);
  // Resolve a target (task id or orca-<agent> session) → its task record.
  const taskForTarget = (target: string): Task | undefined =>
    tasks.data?.find((t) => t.id === target)
    ?? (target.startsWith('orca-') ? tasks.data?.find((t) => (t.labels ?? []).includes(`agent:${target.slice('orca-'.length)}`)) : undefined);
  const execForTarget = (target: string): string | undefined => {
    const found = taskForTarget(target);
    return found ? (taskExec(found.labels) || config?.defaults?.exec || undefined) : undefined;
  };
  // A mission target is "m-<epicId>" — resolve its epic's title so the feed shows that, not a raw id.
  const epicIdForMission = (target: string): string | null => (target.startsWith('m-') ? target.slice(2) : null);
  const titleForTarget = (target: string): string | undefined => {
    const epicId = epicIdForMission(target);
    if (epicId) return tasks.data?.find((t) => t.id === epicId)?.title;
    return taskForTarget(target)?.title;
  };
  // Autopilot work = an epic child (has a parent_id) or a mission target — tag both in the feed.
  const autopilotForTarget = (target: string): boolean => !!epicIdForMission(target) || !!taskForTarget(target)?.parent_id;
  // Cross-link a feed group to the right detail surface (task / sessions / missions).
  const hrefForGroup = (g: { target: string; events: GroupedEvent[] }): string | undefined => {
    const task = taskForTarget(g.target);
    if (task) return `/tasks?select=${encodeURIComponent(task.id)}`;
    if (g.target.startsWith('orca-')) return '/sessions';
    if (g.events[0]?.type === 'mission') return '/missions';
    return undefined;
  };
  // Result summary for a closed task target, shown when its feed group is expanded.
  const summaryForGroup = (target: string): string | undefined => {
    const task = taskForTarget(target);
    return task && (task.status === 'closed' || task.status === 'cancelled') ? (task.result_summary?.trim() || undefined) : undefined;
  };
  // Group the feed per target (agent/task/mission) → collapsible cards, newest activity first.
  const feedGroups = useMemo(() => {
    const byTarget = new Map<string, GroupedEvent[]>();
    for (const e of feed) { const l = byTarget.get(e.target) ?? []; l.push(e); byTarget.set(e.target, l); }
    return Array.from(byTarget.entries())
      .map(([target, events]) => ({ target, events, last: events[0]?.timestamp ?? 0 }))
      .sort((a, b) => b.last - a.last);
  }, [feed]);
  const toggleGroup = (target: string) => setOpenGroups((s) => { const n = new Set(s); n.has(target) ? n.delete(target) : n.add(target); return n; });
  const liveSet = useMemo(() => new Set(sessions.data ?? []), [sessions.data]);
  // Swimlanes: one track per target (agent/session/task), busiest-recent first.
  const lanes = useMemo(() => {
    const now = Date.now();
    const byTarget = new Map<string, AxisEvent[]>();
    for (const e of rawEvents) { const list = byTarget.get(e.target) ?? []; list.push(e); byTarget.set(e.target, list); }
    return Array.from(byTarget.entries())
      .map(([target, evs]) => ({ target, points: plotAxis(evs, now, windowHours).points, last: Math.max(...evs.map((e) => e.timestamp)) }))
      .sort((a, b) => b.last - a.last)
      .slice(0, 10);
  }, [rawEvents, windowHours]);

  const hasData = !q.isLoading && !q.isError && rawEvents.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <ModuleHeader title={t.page.timeline} icon={Activity}>
        <Segmented options={[{ label: t.timeline.axis, value: 'axis', icon: Activity }, { label: t.timeline.lanes, value: 'lanes', icon: Columns3 }]} value={view} onChange={setView} />
        <Segmented options={FILTER_OPTIONS} value={filter} onChange={setFilter} />
      </ModuleHeader>

      {/* Hero: the lane/axis plot — orca's signature surface */}
      <section className="rounded-lg border border-border border-t-2 border-t-accent/40 bg-surface p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-text-muted"><Clock size={12} className="shrink-0 text-text-muted" aria-hidden />{windowLabel}</div>
        {q.isLoading ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState message={t.timeline.loadError} onRetry={() => q.refetch()} />
        ) : !hasData ? (
          <EmptyState title={t.timeline.empty} description={t.timeline.emptyDescription} icon={Activity} />
        ) : view === 'lanes' ? (
          <div className="flex flex-col gap-2.5">
            {lanes.map((l) => <Lane key={l.target} target={l.target} points={l.points} ticks={ticks} />)}
            <div className="relative mt-1 ml-[7.75rem] h-4">
              {ticks.map((t) => (
                <span key={t.label} className="absolute -translate-x-1/2 font-mono text-text-muted" style={{ left: `${t.frac * 100}%`, fontSize: 'var(--text-caption)' }}>{t.label}</span>
              ))}
            </div>
          </div>
        ) : (
          <TimelineTrack points={points} ticks={ticks} />
        )}
      </section>

      <Section title={t.timeline.feed} icon={MessageSquareText}>
        {q.isLoading ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState message={t.timeline.loadError} onRetry={() => q.refetch()} />
        ) : !hasData ? (
          <EmptyState title={t.timeline.empty} icon={Activity} />
        ) : (
          <div data-testid="activity-feed" className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto pr-0.5">
            {feedGroups.map((g) => (
              liveSet.has(g.target) ? (
                <LiveFeedGroup
                  key={g.target}
                  target={g.target}
                  title={titleForTarget(g.target)}
                  exec={execForTarget(g.target)}
                  href={hrefForGroup(g)}
                  ts={g.last}
                  autopilot={autopilotForTarget(g.target)}
                  open={openGroups.has(g.target)}
                  onToggle={() => toggleGroup(g.target)}
                />
              ) : (
                <FeedGroup
                  key={g.target}
                  target={g.target}
                  title={titleForTarget(g.target)}
                  events={g.events}
                  exec={execForTarget(g.target)}
                  href={hrefForGroup(g)}
                  summary={summaryForGroup(g.target)}
                  autopilot={autopilotForTarget(g.target)}
                  open={openGroups.has(g.target)}
                  onToggle={() => toggleGroup(g.target)}
                />
              )
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
