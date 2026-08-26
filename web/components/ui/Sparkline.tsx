'use client';
import { useId } from 'react';
import {
  Area, AreaChart, Bar, BarChart, Cell, Line, LineChart, ResponsiveContainer,
} from 'recharts';

/** The one mini series the whole app draws.
 *
 *  It replaced three separate implementations of the same picture — a Recharts area for today's hours,
 *  a hand-rolled SVG polyline for the month, and CSS columns for the last seven days. They disagreed on
 *  everything a reader notices: stroke weight, whether the curve was smoothed, how a flat series looked.
 *
 *  A sparkline is a shape, not a readout: no axis, no tooltip, no legend. The number it belongs to is
 *  always printed next to it, so the chart stays `aria-hidden` and a screen reader gets that figure
 *  rather than a description of a line. Anything that needs a hover is a real chart and belongs
 *  elsewhere.
 *
 *  Scaling is the library's job. Every previous version normalised to its own peak by hand, twice with
 *  the identical three lines of arithmetic; Recharts derives the same domain from the data. */

export type SparkVariant = 'area' | 'line' | 'bar';

export function Sparkline({ values, colour, variant = 'area', highlightLast = false, className }: {
  values: number[];
  colour: string;
  variant?: SparkVariant;
  /** Bars only: the most recent column carries the accent and the rest recede — used where the series
   *  ends at "now" and that last value is the one being reported next to it. */
  highlightLast?: boolean;
  /** Height and width belong to the caller: these sit inside cards of very different sizes. */
  className?: string;
}) {
  const gradientId = useId();

  // A flat or single-point series has no shape to show, and drawing it produces a straight line that
  // reads as a measurement rather than as the absence of one.
  if (values.length < 2 || !values.some((v) => v > 0)) return null;

  const data = values.map((v, i) => ({ i, v }));
  const last = data.length - 1;

  return (
    <div aria-hidden className={className}>
      <ResponsiveContainer width="100%" height="100%">
        {variant === 'bar' ? (
          <BarChart data={data} margin={{ top: 1, right: 0, bottom: 0, left: 0 }} barCategoryGap={1}>
            {/* A zero-height bar would vanish and make the series look shorter than it is. */}
            <Bar dataKey="v" isAnimationActive={false} minPointSize={2} radius={[1, 1, 0, 0]}>
              {data.map((d) => (
                <Cell
                  key={d.i}
                  fill={highlightLast && d.i !== last ? 'var(--color-border-strong)' : colour}
                  fillOpacity={highlightLast && d.i !== last ? 0.7 : 1}
                />
              ))}
            </Bar>
          </BarChart>
        ) : variant === 'line' ? (
          <LineChart data={data} margin={{ top: 2, right: 1, bottom: 1, left: 1 }}>
            <Line
              dataKey="v" type="monotone" stroke={colour} strokeWidth={1.25}
              dot={false} isAnimationActive={false}
            />
          </LineChart>
        ) : (
          <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colour} stopOpacity={0.35} />
                <stop offset="100%" stopColor={colour} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              dataKey="v" type="monotone" stroke={colour} strokeWidth={1.25}
              fill={`url(#${gradientId})`} dot={false} isAnimationActive={false}
            />
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
