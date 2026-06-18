'use client';
import { useMemo, useState } from 'react';
import { Activity } from 'lucide-react';
import { useActivity } from '../../lib/queries';
import { plotAxis, groupEvents, type AxisEvent, type AxisPoint, type GroupedEvent } from './axis';
import { eventIcon, eventTone } from './eventMeta';
import { Segmented, type SegmentedOption } from '../../components/ui/Segmented';
import { Section } from '../../components/ui/Section';
import { Badge } from '../../components/ui/Badge';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import type { Tone } from '../../components/ui/tone';
import { useTranslation } from '../../lib/i18n';

const WINDOW_HOURS = 12;

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
};

/** "12:05" style UTC clock label. */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
        className={`rounded-full ring-2 ring-surface transition-transform group-hover:scale-125 ${DOT_TONE[tone]}`}
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

function FeedRow({ event }: { event: GroupedEvent }) {
  const Icon = eventIcon(event.type);
  const tone = eventTone(event.type);
  return (
    <div className="flex items-center gap-3 py-2.5 transition-colors hover:bg-elevated -mx-2 px-2 rounded-md" style={{ transitionDuration: 'var(--motion-fast)' }}>
      <Icon className="shrink-0 text-text-muted" size={14} aria-hidden />
      <span className="flex-1 truncate font-mono text-xs text-text">{event.target}</span>
      <Badge tone={tone}>
        {event.detail}
        {event.count > 1 ? <span className="ml-1 opacity-70">×{event.count}</span> : null}
      </Badge>
      <span className="shrink-0 whitespace-nowrap font-mono text-text-muted" style={{ fontSize: 'var(--text-caption)' }}>
        {clock(event.timestamp)}
      </span>
    </div>
  );
}

export function TimelineView() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<string>('all');
  const [view, setView] = useState<string>('axis');
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

  const { points, ticks } = useMemo(() => plotAxis(rawEvents, Date.now(), WINDOW_HOURS), [rawEvents]);
  // Feed: most-recent-first, deduped the same way as the axis.
  const feed = useMemo(() => groupEvents(rawEvents).sort((a, b) => b.timestamp - a.timestamp), [rawEvents]);
  // Swimlanes: one track per target (agent/session/task), busiest-recent first.
  const lanes = useMemo(() => {
    const now = Date.now();
    const byTarget = new Map<string, AxisEvent[]>();
    for (const e of rawEvents) { const list = byTarget.get(e.target) ?? []; list.push(e); byTarget.set(e.target, list); }
    return Array.from(byTarget.entries())
      .map(([target, evs]) => ({ target, points: plotAxis(evs, now, WINDOW_HOURS).points, last: Math.max(...evs.map((e) => e.timestamp)) }))
      .sort((a, b) => b.last - a.last)
      .slice(0, 10);
  }, [rawEvents]);

  const hasData = !q.isLoading && !q.isError && rawEvents.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <Section
        title={t.timeline.activityLast12h}
        icon={Activity}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented options={[{ label: t.timeline.axis, value: 'axis' }, { label: t.timeline.lanes, value: 'lanes' }]} value={view} onChange={setView} />
            <Segmented options={FILTER_OPTIONS} value={filter} onChange={setFilter} />
          </div>
        }
      >
        {q.isLoading ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState message={t.timeline.loadError} onRetry={() => q.refetch()} />
        ) : !hasData ? (
          <EmptyState title={t.timeline.empty} description={t.timeline.emptyDescription} />
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
      </Section>

      <Section title={t.timeline.feed}>
        {q.isLoading ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState message={t.timeline.loadError} onRetry={() => q.refetch()} />
        ) : !hasData ? (
          <EmptyState title={t.timeline.empty} />
        ) : (
          <div data-testid="activity-feed" className="flex flex-col divide-y divide-border">
            {feed.map((e) => (
              <FeedRow key={e.id} event={e} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
