'use client';
import { Suspense, lazy } from 'react';
import type { TimeSeriesChartProps } from './timeSeriesChartTypes';

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

const Impl = lazy(() => import('./TimeSeriesChartImpl').then((module) => ({ default: module.TimeSeriesChartImpl })));

export function TimeSeriesChart(props: TimeSeriesChartProps) {
  const { data, height = 220, emptyText } = props;
  // Resolved before the lazy boundary: an empty range should not fetch a charting library to say so.
  if (data.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">{emptyText ?? ''}</p>;
  }
  return (
    <Suspense fallback={<div className="animate-pulse rounded-lg bg-muted/40" style={{ height }} aria-hidden />}>
      <Impl {...props} />
    </Suspense>
  );
}
