'use client';
import { usePulse } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { LoadingState } from '../../components/ui/states';
import { Avatar } from '../../components/ui/Avatar';
import { PlatformIcon } from '../../components/ui/PlatformIcon';
import { formatTokens, formatCost } from '../../lib/format';
import type { LocaleDict } from '../../lib/i18n/types';
import type { PulsePerson } from '../../lib/types';

const DAYS = 14;
const HOURS = 24;

/** Ridgeline geometry. The viewBox is in hour units so the path maths stays readable; the SVG is then
 *  stretched to whatever width the tile has, with `vector-effect` keeping strokes honest. */
const LANE = 26;   // vertical room per person
const PEAK = 22;   // how tall a full-strength hour draws
const OVERLAP = 8; // how far a layer rides up over the one above — what makes it a ridgeline

/** Each person gets a hue rotated off the skin's own accent, so the tile inherits Midnight or Chetty
 *  branding instead of carrying a second palette. Rotation beats a fixed list: it never collides with
 *  the surrounding UI, and the first person always draws in the unmodified accent. */
function hueFor(index: number): string {
  return `hue-rotate(${(index * 47) % 360}deg)`;
}

/** Sum each person's buckets into 24 hourly values — their shape of a day across the window. */
function hoursOf(person: PulsePerson): number[] {
  const out = Array<number>(HOURS).fill(0);
  for (const b of person.rhythm) if (b.hour >= 0 && b.hour < HOURS) out[b.hour] += b.count;
  return out;
}

/** A closed area path through 24 points, smoothed with midpoint quadratics.
 *
 *  Normalised per person, NOT against the instance maximum: one heavy user would otherwise flatten
 *  everyone else into a straight line. The layer answers "when does this person work", and the tokens
 *  beside their name answer "how much" — two questions, two channels, neither crowding the other. */
function ridgePath(values: number[], baseline: number): string {
  const max = Math.max(...values, 0);
  const y = (v: number) => baseline - (max > 0 ? (v / max) * PEAK : 0);
  const pts = values.map((v, i) => [i, y(v)] as const);
  let d = `M 0 ${baseline} L 0 ${pts[0]![1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[i + 1]!;
    d += ` Q ${x1} ${y1} ${(x1 + x2) / 2} ${(y1 + y2) / 2}`;
  }
  const last = pts[pts.length - 1]!;
  d += ` L ${HOURS - 1} ${last[1]} L ${HOURS - 1} ${baseline} Z`;
  return d;
}

/** The signature element: one layer per person, stacked and overlapping, over a shared 24-hour axis. */
function Ridgeline({ people, t }: { people: PulsePerson[]; t: LocaleDict }) {
  const height = Math.max(LANE, people.length * (LANE - OVERLAP) + OVERLAP + PEAK);
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${HOURS - 1} ${height}`}
        preserveAspectRatio="none"
        className="h-[--ridge-h] w-full"
        style={{ '--ridge-h': `${height * 2.2}px` } as React.CSSProperties}
        role="img"
        aria-label={t.dashboard.pulseAria}
      >
        {/* Midday guide. Drawn under the layers so it reads as paper ruling, not as data. */}
        {[6, 12, 18].map((h) => (
          <line key={h} x1={h} y1={0} x2={h} y2={height} className="stroke-border/40" strokeWidth={0.5}
            vectorEffect="non-scaling-stroke" />
        ))}
        {/* Later people draw first so the topmost layer — whoever is working — stays unobscured. */}
        {[...people].reverse().map((p, ri) => {
          const i = people.length - 1 - ri;
          const baseline = (i + 1) * (LANE - OVERLAP) + PEAK;
          return (
            <g key={p.userId} style={{ filter: hueFor(i) }}>
              <path d={ridgePath(hoursOf(p), baseline)} className="fill-accent/25" />
              <path d={ridgePath(hoursOf(p), baseline)} className="fill-none stroke-accent"
                strokeWidth={1.25} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[9px] tabular-nums text-text-muted">
        <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
      </div>
    </div>
  );
}

/** One person: who, on what, from where, and what it cost today. */
function PersonRow({ person, index, share, t }: {
  person: PulsePerson; index: number; share: number; t: LocaleDict;
}) {
  const surfaces = t.dashboard.surfaces as Record<string, string>;
  return (
    <li className="flex items-center gap-2.5 py-1.5">
      <span className="relative shrink-0">
        <Avatar
          user={{ id: person.userId, username: person.username, name: person.label,
            ...(person.avatar ? { avatar: person.avatar } : {}) }}
          size={26}
        />
        {/* The layer's colour, repeated on the avatar: the graph needs no legend of its own. */}
        <span aria-hidden style={{ filter: hueFor(index) }}
          className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-surface bg-accent" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-xs text-text">{person.label}</span>
          {person.working ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-success">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" />
              {t.dashboard.workingNow}
            </span>
          ) : null}
        </span>
        {/* What they are on, or when they were last seen — so a quiet row still says something. */}
        <span className="block truncate text-[11px] text-text-muted"
          title={person.working && person.title ? person.title : undefined}>
          {person.working && person.title ? person.title : person.lastTs ? t.dashboard.pulseSeen : '\u00a0'}
        </span>
      </span>

      {/* Where the day's turns came from. The shared PlatformIcon already owns brand marks and glyphs,
          so the tile shows the same Discord mark the conversation list does. */}
      <span className="hidden shrink-0 items-center gap-1.5 @md:flex"
        title={person.surfaces.map((s) => surfaces[s] ?? surfaces.unknown).join(' · ')}>
        {person.surfaces.map((s) => <PlatformIcon key={s} platform={s} size={13} />)}
      </span>

      <span className="w-24 shrink-0 text-right font-mono text-[11px] tabular-nums">
        <span className="block text-text">{formatTokens(person.tokens)}</span>
        <span className="block text-text-muted">
          {person.cost === null ? t.dashboard.pulseUnpriced : formatCost(person.cost, 2)}
        </span>
      </span>

      {/* Share of today's instance total, not an absolute bar: the tile compares people to the day's
          work rather than ranking them against a number nobody agreed on. */}
      <span aria-hidden className="hidden h-8 w-1 shrink-0 overflow-hidden rounded-full bg-border/40 @sm:block">
        <span className="block w-full rounded-full bg-accent" style={{ height: `${share}%`, filter: hueFor(index) }} />
      </span>
    </li>
  );
}

/** How busy the instance has been, who did it, and what it cost. */
export function TeamPulseTile() {
  const { t } = useTranslation();
  const pulse = usePulse(DAYS);
  const data = pulse.data;
  const people = data?.people ?? [];
  const totals = data?.totals;

  return (
    <section aria-labelledby="dashboard-pulse" className="px-1 py-6 @sm:px-3 @2xl:px-5">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="dashboard-pulse" className="dash-label">{t.dashboard.pulse}</h2>
        <span className="font-mono text-[10px] tabular-nums text-text-muted">
          {t.dashboard.pulseTurns
            .replace('{count}', String(totals?.turns ?? 0))
            .replace('{days}', String(DAYS))}
        </span>
      </header>

      {pulse.isLoading ? (
        <LoadingState />
      ) : people.length === 0 ? (
        <p className="text-sm text-text-muted">{t.dashboard.pulseNobody}</p>
      ) : (
        <>
          {/* Today's headline, set in the data face — the one place the tile states a total. */}
          <div className="mb-4 flex flex-wrap items-baseline gap-x-5 gap-y-1 font-mono tabular-nums">
            <span className="text-lg text-text">{formatTokens(totals?.tokens ?? 0)}</span>
            <span className="text-lg text-text">
              {data?.spendAvailable === false
                ? t.dashboard.pulseSpendOff
                : totals?.cost == null ? t.dashboard.pulseUnpriced : formatCost(totals.cost, 2)}
            </span>
            <span className="text-[11px] text-text-muted">{t.dashboard.pulseTodayLabel}</span>
          </div>

          <Ridgeline people={people} t={t} />

          <ul className="mt-3 divide-y divide-border/50">
            {people.map((p, i) => (
              <PersonRow
                key={p.userId}
                person={p}
                index={i}
                share={totals?.tokens ? Math.max(4, Math.round((p.tokens / totals.tokens) * 100)) : 0}
                t={t}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
