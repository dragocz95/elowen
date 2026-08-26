'use client';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TimeSeriesChartProps, TimeSeriesSeries } from './TimeSeriesChart';

/** The Recharts half of `TimeSeriesChart`, split out so the library only ever arrives in its own async
 *  chunk. The wrapper is what everything imports; nothing should import this module directly. */

interface TooltipEntry { dataKey?: string | number; value?: number | string | null }

function ChartTooltip({ active, label, payload, series }: {
  active?: boolean;
  label?: string;
  payload?: TooltipEntry[];
  series: TimeSeriesSeries[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 shadow-[var(--shadow-raised)]">
      <div className="mb-1 truncate font-mono text-[11px] text-text-muted">{label}</div>
      {series.map((entry) => {
        const point = payload.find((row) => row.dataKey === entry.key);
        if (point?.value == null) return null;
        return (
          <div key={entry.key} className="flex items-center gap-2 whitespace-nowrap text-xs">
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-sm" style={{ background: entry.colour }} />
            <span className="text-text-muted">{entry.label}</span>
            <span className="ml-auto font-mono tabular-nums text-text">{entry.format(Number(point.value))}</span>
          </div>
        );
      })}
    </div>
  );
}

export function TimeSeriesChartImpl({ data, series, height = 220, ariaLabel }: TimeSeriesChartProps) {
  const usesRightAxis = series.some((entry) => entry.axis === 'right');
  // Ticks are the whole point of promoting a sparkline to a chart, but two units on one canvas cannot
  // share a scale: tokens run to millions and cost to single dollars. Each axis therefore formats with
  // its own series' formatter.
  const axisFormatter = (axis: 'left' | 'right') => {
    const owner = series.find((entry) => (entry.axis ?? 'left') === axis);
    return (value: number) => (owner ? owner.format(value) : String(value));
  };

  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="flex min-w-0 flex-wrap items-center gap-4 text-xs text-text-muted">
        {series.map((entry) => (
          <span key={entry.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-2 rounded-sm" style={{ background: entry.colour }} />
            {entry.label}
          </span>
        ))}
      </figcaption>
      <div style={{ height }} className="min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} accessibilityLayer={false}>
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: 'var(--color-border)' }}
              minTickGap={24}
            />
            <YAxis
              yAxisId="left"
              width={52}
              tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={axisFormatter('left')}
            />
            {usesRightAxis ? (
              <YAxis
                yAxisId="right"
                orientation="right"
                width={52}
                tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={axisFormatter('right')}
              />
            ) : null}
            <Tooltip
              cursor={{ fill: 'var(--color-elevated)', opacity: 0.35 }}
              content={<ChartTooltip series={series} />}
            />
            {series.map((entry) => (entry.variant === 'line' ? (
              <Line
                key={entry.key}
                yAxisId={entry.axis ?? 'left'}
                type="monotone"
                dataKey={entry.key}
                stroke={entry.colour}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3 }}
                isAnimationActive={false}
              />
            ) : (
              <Bar
                key={entry.key}
                yAxisId={entry.axis ?? 'left'}
                dataKey={entry.key}
                fill={entry.colour}
                radius={[2, 2, 0, 0]}
                isAnimationActive={false}
              />
            )))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {/* The chart itself is a picture. This is the same data as text, so a screen reader gets figures
          rather than a description of a shape. */}
      <ul className="sr-only">
        {data.map((point) => (
          <li key={point.label}>
            {point.label}: {series.map((entry) => {
              const value = point[entry.key];
              return `${entry.label} ${value == null ? '—' : entry.format(Number(value))}`;
            }).join(', ')}
          </li>
        ))}
      </ul>
      {ariaLabel ? <span className="sr-only">{ariaLabel}</span> : null}
    </figure>
  );
}
