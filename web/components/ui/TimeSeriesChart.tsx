'use client';
import { Suspense, lazy } from 'react';

/** The real chart, where `Sparkline` is the shape.
 *
 *  Sparkline draws a figure you read the number beside; this one answers "which day, and how much" —
 *  so it carries ticks, a cursor tooltip and a legend, and it accepts two series in DIFFERENT units on
 *  their own axes. Tokens run to millions and cost to single dollars: normalising each to its own peak,
 *  which is what the hand-rolled versions did, makes two bars the same height mean nothing.
 *
 *  Recharts arrives through a lazy import on purpose. It measured ~376 KB uncompressed, and this
 *  component is published to plugin bundles through the UI runtime — a static import would drag the
 *  library into the chunk that Account and Settings already pull in for everything else. */

export interface TimeSeriesPoint {
  /** The category shown on the x axis and in the tooltip heading. */
  label: string;
  [key: string]: string | number | null;
}

export interface TimeSeriesSeries {
  /** Key into each point. */
  key: string;
  label: string;
  /** Any CSS colour; a `var(--color-…)` token keeps the series on theme. */
  colour: string;
  variant?: 'bar' | 'line';
  /** Which axis this series is measured against. Two series in one unit should share one axis. */
  axis?: 'left' | 'right';
  /** Locale formatting belongs to the caller — the chart never guesses a currency or a number format. */
  format: (value: number) => string;
}

export interface TimeSeriesChartProps {
  data: TimeSeriesPoint[];
  series: TimeSeriesSeries[];
  height?: number;
  emptyText?: string;
  ariaLabel?: string;
}

const Impl = lazy(() => import('./TimeSeriesChartImpl').then((module) => ({ default: module.TimeSeriesChartImpl })));

export function TimeSeriesChart(props: TimeSeriesChartProps) {
  const { data, height = 220, emptyText } = props;
  // Resolved before the lazy boundary: an empty range should not fetch a charting library to say so.
  if (data.length === 0) {
    return <p className="py-10 text-center text-sm text-text-muted">{emptyText ?? ''}</p>;
  }
  return (
    <Suspense fallback={<div className="animate-pulse rounded-lg bg-elevated/40" style={{ height }} aria-hidden />}>
      <Impl {...props} />
    </Suspense>
  );
}
