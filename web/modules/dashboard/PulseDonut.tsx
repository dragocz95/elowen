'use client';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { Activity, Brain, Coins, DollarSign, Radio, Zap } from 'lucide-react';
import { Avatar } from '../../components/ui/Avatar';
import { PlatformIcon } from '../../components/ui/PlatformIcon';
import { formatCost, formatTokens } from '../../lib/format';
import { HOURS, colorFor, toLocalHours } from './pulseSeries';
import type { LocaleDict } from '../../lib/i18n/types';
import type { PulsePerson } from '../../lib/types';

/** Who spent today's budget, as one ring.
 *
 *  The ring answers the question the tile exists for — how the day divided between people — in a single
 *  glance, and everything that used to need a seven-column table moves into the hover card. That trade
 *  is deliberate: a table makes the reader scan columns to compare two people, while an arc makes the
 *  comparison the picture itself. The cost of it is that a ring has no time axis, so the card carries a
 *  small day curve to keep "when did they work" available.
 *
 *  Slices are sized by tokens rather than cost: cost is null for any turn nobody priced, and a ring with
 *  missing slices would misstate the split. Cost is reported inside the card, where a missing value can
 *  say so honestly. */

const RING_HEIGHT = 208;

/** One row of the hover card. The icon is what makes the card readable at a glance rather than a list
 *  of labels — the same reasoning as the feed's tool marks. */
function Row({ icon: Icon, label, children }: {
  icon: typeof Coins; label: string; children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-5">
      <Icon size={12} className="shrink-0 translate-y-0.5 text-text-subtle" aria-hidden />
      <span className="text-text-muted">{label}</span>
      <span className="ml-auto min-w-0 truncate text-right font-mono tabular-nums text-text">{children}</span>
    </div>
  );
}

/** A person's day at card scale, normalised to their own peak — the one thing the ring cannot show. */
function DayCurve({ hours, colour }: { hours: number[]; colour: string }) {
  const local = toLocalHours(hours);
  const max = Math.max(...local, 0);
  if (max <= 0) return null;
  const points = local.map((v, i) => `${(i / (HOURS - 1)) * 100},${14 - (v / max) * 12}`).join(' ');
  return (
    <svg aria-hidden viewBox="0 0 100 14" preserveAspectRatio="none" className="mt-1 h-4 w-full">
      <polyline
        points={points} fill="none" stroke={colour} strokeWidth={1.25}
        strokeLinejoin="round" vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

interface SliceDatum { person: PulsePerson; index: number; share: number }
interface TooltipShape {
  active?: boolean;
  payload?: { payload?: SliceDatum }[];
  t?: LocaleDict;
}

/** Exported for its own test: jsdom computes no layout, so Recharts never measures the ring and the
 *  tooltip can only be exercised directly. The card is where every number the old table showed now
 *  lives, which makes it the part most worth pinning. */
export function PersonCard({ active, payload, t }: TooltipShape) {
  const datum = payload?.[0]?.payload;
  if (!active || !datum || !t) return null;
  const { person, index, share } = datum;
  const colour = colorFor(index);
  const surfaces = t.dashboard.surfaces as Record<string, string>;

  return (
    <div className="w-64 rounded-xl border border-border bg-surface/95 p-3 shadow-xl backdrop-blur">
      <div className="flex items-center gap-2.5">
        <span className="relative shrink-0">
          <Avatar
            user={{
              id: person.userId, username: person.username, name: person.label,
              ...(person.avatar ? { avatar: person.avatar } : {}),
            }}
            size={30}
          />
          <span
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface"
            style={{ background: colour }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium leading-tight text-text">{person.label}</div>
          <div className="font-mono text-[11px] leading-tight text-text-muted tabular-nums">
            {share.toFixed(1)} %
          </div>
        </div>
      </div>

      <div className="mt-2.5 flex flex-col gap-0.5 border-t border-border/60 pt-2">
        <Row icon={Radio} label={t.dashboard.pulseColChannel}>
          {person.surfaces.length === 0 ? '—' : (
            <span
              className="flex items-center justify-end gap-1"
              title={person.surfaces.map((s) => surfaces[s] ?? surfaces.unknown).join(' · ')}
            >
              {person.surfaces.slice(0, 5).map((s) => (
                <PlatformIcon key={s} platform={s} size={13} />
              ))}
            </span>
          )}
        </Row>
        <Row icon={Activity} label={t.dashboard.pulseColDoing}>
          {person.working && person.title
            ? <span className="text-success">{person.title}</span>
            : person.lastTs ? t.dashboard.pulseSeen : '—'}
        </Row>
        <Row icon={DollarSign} label={t.dashboard.pulseColCost}>
          {person.cost === null ? t.dashboard.pulseUnpriced : formatCost(person.cost, 2)}
        </Row>
        <Row icon={Coins} label={t.dashboard.pulseColTokens}>{formatTokens(person.tokens)}</Row>
        <Row icon={Zap} label={t.dashboard.pulseColCache}>
          {person.cacheHitPct === null ? '—' : `${Math.round(person.cacheHitPct)} %`}
        </Row>
        <Row icon={Brain} label={t.dashboard.pulseColHits}>{person.memoryHits.toLocaleString()}</Row>
      </div>

      <DayCurve hours={person.hoursToday} colour={colour} />
    </div>
  );
}

export function PulseDonut({ people, totalTokens, t }: {
  people: PulsePerson[]; totalTokens: number; t: LocaleDict;
}) {
  // A person with no tokens today would be an invisible slice with a hoverable label; drop them from the
  // ring and let the headline counts speak for them instead.
  const slices: SliceDatum[] = people
    .map((person, index) => ({ person, index, share: totalTokens > 0 ? (person.tokens / totalTokens) * 100 : 0 }))
    .filter((s) => s.person.tokens > 0);

  if (slices.length === 0) return null;

  return (
    <div className="relative" style={{ height: RING_HEIGHT }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={slices}
            dataKey={(d: SliceDatum) => d.person.tokens}
            nameKey={(d: SliceDatum) => d.person.label}
            innerRadius="62%"
            outerRadius="92%"
            paddingAngle={slices.length > 1 ? 2 : 0}
            strokeWidth={0}
            isAnimationActive={false}
          >
            {slices.map((s) => <Cell key={s.person.userId} fill={colorFor(s.index)} />)}
          </Pie>
          <Tooltip
            content={<PersonCard t={t} />}
            // The card is large; letting Recharts animate it between slices reads as lag.
            isAnimationActive={false}
            wrapperStyle={{ zIndex: 20, outline: 'none' }}
          />
        </PieChart>
      </ResponsiveContainer>

      {/* The day's total, in the hole. Pointer-events off so it never steals a hover from the ring. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-xl leading-none tabular-nums text-text">{formatTokens(totalTokens)}</span>
        <span className="mt-1 text-[10px] uppercase tracking-wider text-text-muted">
          {t.dashboard.pulseTodayLabel}
        </span>
      </div>
    </div>
  );
}
