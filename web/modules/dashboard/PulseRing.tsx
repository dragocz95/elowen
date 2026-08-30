'use client';
import { useRef, useState } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

/** The shared ring the pulse tile draws four times.
 *
 *  Four cuts rather than one, because on this instance a single cut lies by omission: one person owns
 *  essentially every token, so a per-person ring is a solid circle that says nothing, while the split
 *  by surface — scheduled work against the CLI against the browser — is the shape that actually moves.
 *  Each ring answers a different question and carries its own hover card.
 *
 *  Everything here is presentation. A ring knows nothing about people, surfaces or tokens; it takes
 *  slices with a value and a colour and asks its caller to render the card. That is what keeps the four
 *  visually identical — a second hand-rolled donut would drift in radius, padding and hover behaviour
 *  within a release or two. */

/** Recharts sizes a pie by `min(width, height)`. Four across the full page width leaves a ~338px
 *  column, so height alone decides how big the arc gets and this is the only dial worth turning. It
 *  stays under the two-column width (~216px) as well, where the column takes over as the limit and
 *  the ring simply tracks it down. */
const RING_HEIGHT = 220;
/** Must match the `w-60` on {@link CardShell}: the flip-to-the-left decision needs the real width, and
 *  measuring the card would mean rendering it first just to find out where to put it. */
const CARD_WIDTH = 240;

export interface RingSlice<T> {
  /** Stable identity for React, never the label: a rename must not remount the slice. */
  key: string;
  label: string;
  value: number;
  colour: string;
  datum: T;
}

interface TooltipPayload<T> {
  active?: boolean;
  payload?: { payload?: { slice: RingSlice<T>; share: number } }[];
  render?: (datum: T, share: number, colour: string) => React.ReactNode;
}

/** Recharts hands the tooltip its own payload shape; this unwraps it so callers never see Recharts. */
function RingTooltip<T>({ active, payload, render }: TooltipPayload<T>) {
  const entry = payload?.[0]?.payload;
  if (!active || !entry || !render) return null;
  return <>{render(entry.slice.datum, entry.share, entry.slice.colour)}</>;
}

export function PulseRing<T>({ title, slices, centerValue, centerLabel, renderCard, emptyLabel }: {
  title: string;
  slices: RingSlice<T>[];
  centerValue: string;
  centerLabel: string;
  renderCard: (datum: T, share: number, colour: string) => React.ReactNode;
  emptyLabel: string;
}) {
  const total = slices.reduce((n, s) => n + s.value, 0);
  // A zero-value slice is an invisible arc that still swallows a hover, so it never reaches the ring.
  const drawn = slices
    .filter((s) => s.value > 0)
    .map((slice) => ({ slice, share: total > 0 ? (slice.value / total) * 100 : 0 }));

  /** Recharts anchors a pie tooltip to the CENTRE of the active sector, not to the pointer, so the card
   *  parks in roughly the same spot however you approach the ring and stops feeling attached to what it
   *  describes. Feeding it an explicit position from the pointer is the only way to fix that.
   *
   *  The card flips to the left of the cursor once the pointer passes the middle, which is what keeps a
   *  240px card from hanging off the edge of a quarter-width column. */
  const boxRef = useRef<HTMLDivElement>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const trackPointer = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    setPointer({ x: x > box.width / 2 ? x - CARD_WIDTH - 16 : x + 16, y: y - 12 });
  };

  return (
    <section className="flex flex-col items-center" aria-label={title}>
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {drawn.length === 0 ? (
        <div
          className="flex w-full items-center justify-center text-[11px] text-subtle-foreground"
          style={{ height: RING_HEIGHT }}
        >
          {emptyLabel}
        </div>
      ) : (
        <>
          <div
            ref={boxRef}
            className="relative w-full"
            style={{ height: RING_HEIGHT }}
            onMouseMove={trackPointer}
            onMouseLeave={() => setPointer(null)}
          >
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={drawn}
                  dataKey={(d: { slice: RingSlice<T> }) => d.slice.value}
                  innerRadius="64%"
                  outerRadius="92%"
                  paddingAngle={drawn.length > 1 ? 2 : 0}
                  strokeWidth={0}
                  isAnimationActive={false}
                >
                  {drawn.map((d) => <Cell key={d.slice.key} fill={d.slice.colour} />)}
                </Pie>
                <Tooltip
                  content={<RingTooltip<T> render={renderCard} />}
                  // Anchored to the pointer rather than to the sector centre — see `trackPointer`.
                  {...(pointer ? { position: pointer } : {})}
                  // Let it hang outside the chart box: the ring is only a quarter of the row wide, and
                  // clamping the card inside would push it back over the arc it describes.
                  allowEscapeViewBox={{ x: true, y: true }}
                  // The card is large; animating it between slices reads as lag rather than polish.
                  isAnimationActive={false}
                  wrapperStyle={{ zIndex: 20, outline: 'none' }}
                />
              </PieChart>
            </ResponsiveContainer>

            {/* The headline figure sits in the hole. Pointer-events off so it never steals a hover. */}
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-mono text-xl leading-none tabular-nums text-foreground">{centerValue}</span>
              <span className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">{centerLabel}</span>
            </div>
          </div>

          {/* Recharts sectors expose hover well but not a reliable keyboard target. Native disclosure rows
              keep every slice name and the same detail card reachable without inventing another popover. */}
          <ul className="mt-2 flex min-w-0 w-full flex-col gap-1">
            {drawn.map(({ slice, share }) => (
              <li key={slice.key}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: slice.colour }} />
                    <span className="min-w-0 flex-1 truncate text-left">{slice.label}</span>
                    <span className="font-mono tabular-nums">{share.toFixed(1)} %</span>
                  </summary>
                  <div className="mt-2 flex min-w-0 justify-center [&>*]:max-w-full">{renderCard(slice.datum, share, slice.colour)}</div>
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
