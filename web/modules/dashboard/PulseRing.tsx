'use client';
import { useRef, useState } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { LucideIcon } from 'lucide-react';

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
  value: number;
  colour: string;
  datum: T;
}

/** One labelled line inside a hover card. The icon carries the identity — the same reasoning as the
 *  activity feed's tool marks, where a mark reads faster than the word it replaces. */
export function CardRow({ icon: Icon, label, children }: {
  icon: LucideIcon; label: string; children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-5">
      <Icon size={12} className="shrink-0 translate-y-0.5 text-text-subtle" aria-hidden />
      <span className="text-text-muted">{label}</span>
      <span className="ml-auto min-w-0 truncate text-right font-mono tabular-nums text-text">{children}</span>
    </div>
  );
}

/** The frame every hover card sits in, so all four look like one component rather than four. */
export function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-60 rounded-xl border border-border bg-surface/95 p-3 shadow-xl backdrop-blur">
      {children}
    </div>
  );
}

/** The card header shared by the three non-person rings: a colour chip, a name, and the share. */
export function CardHead({ colour, title, share, icon: Icon }: {
  colour: string; title: string; share: number; icon?: LucideIcon;
}) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colour }} />
      {Icon ? <Icon size={13} className="shrink-0 text-text-muted" aria-hidden /> : null}
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight text-text">{title}</span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-muted">{share.toFixed(1)} %</span>
    </div>
  );
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
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">{title}</h3>
      {drawn.length === 0 ? (
        <div
          className="flex w-full items-center justify-center text-[11px] text-text-subtle"
          style={{ height: RING_HEIGHT }}
        >
          {emptyLabel}
        </div>
      ) : (
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
            <span className="font-mono text-xl leading-none tabular-nums text-text">{centerValue}</span>
            <span className="mt-1 text-[10px] uppercase tracking-wider text-text-muted">{centerLabel}</span>
          </div>
        </div>
      )}
    </section>
  );
}
