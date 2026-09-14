'use client';
import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';

/** The one bar the app draws for a single reading against a ceiling that exists.
 *
 *  `Sparkline` is its sibling: that one is a shape over a series and scales to its own peak, which is
 *  exactly wrong here. A meter's whole meaning is the part of the bar that is NOT filled, so the domain
 *  has to be the ceiling and not the datum. Recharts is told that outright — the same thing the system
 *  dials do with `PolarAngleAxis domain={[0, 100]}` — because a single datum otherwise fills the track
 *  whatever it says.
 *
 *  This is the charting library's bar, not a div with a width percentage: the register draws CPU, memory
 *  and disk with one grammar, and a reading with a real denominator is a chart rather than a piece of
 *  layout dressed up as one.
 *
 *  It owns its own accessibility. The SVG is `aria-hidden` for the reason every chart in this codebase is
 *  — a screen reader should get the figure, not a description of a rectangle — so the progressbar role,
 *  its bounds and its spoken text live on the wrapper, where they describe the reading itself. */

/** Recharts turns its keyboard layer on by default, which puts `role="application"` and a focus stop on
 *  the root svg. Inside an `aria-hidden` wrapper that is a fault rather than a feature, and these sit
 *  inside cards that are themselves links. */
const CHART_A11Y = { accessibilityLayer: false } as const;

/** Half the thinnest bar this draws, so the ends are round without the radius exceeding the rectangle it
 *  is applied to — recharts does not clamp it, and an oversized radius folds the path in on itself. The
 *  wrapper's own `rounded-full` is what guarantees the capsule at any height the caller asks for. */
const TRACK_RADIUS = 2;

/** A real but tiny fraction still shows a sliver, so a meter that is barely used never reads as
 *  untouched. Recharts sizes this in pixels, which is the right unit for "visible at all" and holds
 *  whether the bar is 40px wide on a phone or 200px on a desk. */
const MIN_VISIBLE_PX = 2;

export function MeterBar({ percent, colour, label, valueText, className = 'h-1' }: {
  /** Already clamped to 0..100 by the caller, which owns what its own ceiling means. */
  percent: number;
  /** A CSS colour, as `Sparkline` takes one: the threshold ramp belongs to the caller's domain rather
   *  than to the drawing. */
  colour: string;
  /** The accessible name of the reading — "CPU", "RAM", "Disk". */
  label: string;
  /** What a screen reader says instead of "42 percent": the same sentence the sighted reader gets. */
  valueText: string;
  /** Height and width belong to the caller; these sit in cards and drawers of different sizes. */
  className?: string;
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-valuetext={valueText}
      className={className}
    >
      <div aria-hidden className="h-full w-full overflow-hidden rounded-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            {...CHART_A11Y}
            layout="vertical"
            data={[{ reading: percent }]}
            margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
            barCategoryGap={0}
          >
            {/* The ceiling, stated. Without it one datum is its own maximum and every meter reads full.
             *  `hide` only stops an axis being PAINTED — it still reserves its default 60px of width and
             *  30px of height, which silently shrank every bar to 84 % of the track it sits in. Zeroing
             *  both is what makes the plot area the whole track, so a reading of 42 draws 42 % of it. */}
            <XAxis type="number" domain={[0, 100]} hide height={0} />
            <YAxis type="category" hide width={0} />
            <Bar
              dataKey="reading"
              fill={colour}
              radius={TRACK_RADIUS}
              minPointSize={MIN_VISIBLE_PX}
              background={{ fill: 'var(--color-border)', radius: TRACK_RADIUS }}
              // Never animated, exactly as `Sparkline` and the system dials are not. These are re-read on
              // a poll, and a register of them replaying a grow-from-zero every thirty seconds is motion
              // nobody asked for; it also means the bar a reader sees is always the figure beside it and
              // never a frame on the way there. With nothing in motion there is nothing to reduce.
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
