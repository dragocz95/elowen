'use client';
import { Cell, Pie, PieChart } from 'recharts';

/** ONE reading against a ceiling, drawn as a ring instead of a bar.
 *
 *  Three of these stand side by side on a Project card, and that is the whole reason for the shape. A row
 *  of three horizontal meters reads as a list to be worked through one line at a time; three rings of the
 *  same size read as one instrument with three needles, which is what a reader scanning a register for
 *  the project that is misbehaving is actually doing. The figure sits in the hole, so the value and the
 *  proportion occupy the same 52 px rather than competing for a card's inline budget.
 *
 *  It is the charting library's pie, not an SVG circle with a dash offset: the app already draws its
 *  donuts with Recharts (`PulseRing`), and one grammar for arcs is worth more than the dozen lines this
 *  saves. What it does NOT inherit from `PulseRing` is a tooltip or a legend — a register cell is not a
 *  dashboard tile, and a hover card over a card that is itself openable would be a control inside a
 *  control.
 *
 *  Sized in pixels rather than through `ResponsiveContainer`. A responsive chart measures its box in an
 *  effect and draws nothing until it has, which on a register of cards is a visible reflow on first
 *  paint and the exact geometry shift this redesign exists to remove. A fixed square is identical in the
 *  first commit and in the hundredth. */

/** The square the ring is drawn in. Three of them plus the strip's gaps fit the narrowest card the app
 *  supports (320 px viewport, ~272 px card), and the hole is wide enough for `100%` at 11 px. */
const DONUT_SIZE = 52;
const OUTER_RADIUS = 25;
const INNER_RADIUS = 18;

/** Recharts turns its keyboard layer on by default, which puts `role="application"` and a focus stop on
 *  the root svg. These sit inside cards that already own their own tab stop, and the drawing is hidden
 *  from assistive technology anyway — the wrapper carries the reading.
 *
 *  `rootTabIndex` is the SECOND one, and it is easy to miss: `Pie` puts `tabindex="0"` on its own layer
 *  independently of the chart's accessibility layer. Three rings on each of a dozen cards would have put
 *  thirty-six unreachable-by-name stops between a reader and the next project. */
const CHART_A11Y = { accessibilityLayer: false } as const;
const PIE_A11Y = { rootTabIndex: -1 } as const;

/** The quiet remainder. The app's border token, so a ring reads as part of the same instrument family as
 *  the progress rails rather than as a second skin. */
const TRACK_COLOUR = 'var(--color-border)';

/** A real but tiny fraction still shows an arc, so a resource that is barely used never reads as
 *  untouched. Stated in percent because that is the ring's own unit: 2 % of the circle is about 7°, which
 *  survives at 52 px.
 *
 *  It applies to a fraction that has something in it and to nothing else. A reading of exactly zero is
 *  drawn as no arc at all, because the whole meaning of a meter is the part that is NOT filled. */
const MIN_VISIBLE_PERCENT = 2;

export function MetricDonut({ percent, colour, label, valueText, centre }: {
  /** The reading, or `null` when nothing has been measured. `null` draws the track alone: a ring with no
   *  arc is an honest "not known", where an arc of zero would be a claim that the resource is idle.
   *
   *  Out-of-range and non-finite figures are the caller's mistake and are not drawn as one: the ring
   *  clamps what it can and treats what it cannot make sense of as unmeasured. */
  percent: number | null;
  /** A CSS colour. The threshold ramp belongs to the caller's domain rather than to the drawing. */
  colour: string;
  /** The accessible name of the reading — "CPU", "RAM", "Disk". */
  label: string;
  /** The full sentence: what a screen reader gets instead of "42 percent" of an unnamed thing, including
   *  the exact used and total figures and which ceiling they are measured against. */
  valueText: string;
  /** What sits in the hole. The caller owns it, because what is useful there differs per resource. */
  centre: string;
}) {
  const reading = percent === null || !Number.isFinite(percent) ? null : Math.min(100, Math.max(0, percent));
  const drawn = reading === null || reading <= 0 ? 0 : Math.max(reading, MIN_VISIBLE_PERCENT);
  // Zero-value entries are removed rather than handed to Recharts, which would emit a degenerate sector
  // path for them. At 0 that is the arc, at 100 it is the track, and in both cases what is left is one
  // complete ring rather than a full ring with a hairline artifact sitting on top of it.
  const slices = [
    ...(drawn > 0 ? [{ key: 'arc', value: drawn, fill: colour, className: 'metric-donut-arc' }] : []),
    ...(drawn < 100 ? [{ key: 'track', value: 100 - drawn, fill: TRACK_COLOUR, className: 'metric-donut-track' }] : []),
  ];
  const measured = reading !== null;
  return (
    <span
      data-metric-donut={measured ? 'reading' : 'unknown'}
      // A measurement is a progressbar and announces its bounds; a ring with nothing in it is not one, so
      // it is an image whose name is the sentence the sighted reader gets. Neither invents a value.
      {...(measured
        ? { role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(reading), 'aria-valuetext': valueText }
        : { role: 'img', 'aria-label': valueText })}
      className="relative block shrink-0"
      style={{ width: DONUT_SIZE, height: DONUT_SIZE }}
    >
      {/* A screen reader that walked into the chart would describe sectors instead of reading the figure,
          and the centred value below is the same text the wrapper already announces. */}
      <span aria-hidden className="block">
        <PieChart {...CHART_A11Y} width={DONUT_SIZE} height={DONUT_SIZE}>
          <Pie
            {...PIE_A11Y}
            data={slices}
            dataKey="value"
            cx="50%"
            cy="50%"
            innerRadius={INNER_RADIUS}
            outerRadius={OUTER_RADIUS}
            // Twelve o'clock, clockwise: the direction every dial in the app reads, and the one a reader
            // assumes without being told.
            startAngle={90}
            endAngle={-270}
            stroke="none"
            // Never animated, exactly as the system dials are not. These are re-read on
            // a poll, and a register replaying a sweep-from-zero every thirty seconds is motion nobody
            // asked for; it also means the arc on screen is always the figure beside it rather than a
            // frame on the way there. With nothing in motion there is nothing to reduce.
            isAnimationActive={false}
          >
            {slices.map((slice) => <Cell key={slice.key} fill={slice.fill} className={slice.className} />)}
          </Pie>
        </PieChart>
      </span>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] font-semibold leading-none tabular-nums text-foreground"
      >
        {centre}
      </span>
    </span>
  );
}
