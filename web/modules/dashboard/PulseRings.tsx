'use client';
import { Activity, Brain, Coins, Database, DollarSign, Flame, MessageSquare, Radio, Repeat, Zap } from 'lucide-react';
import { Avatar } from '../../components/ui/Avatar';
import { PlatformIcon } from '../../components/ui/PlatformIcon';
import { formatCost, formatTokens } from '../../lib/format';
import { colorFor } from './pulseSeries';
import { CardHead, CardRow, CardShell, PulseRing } from './PulseRing';
import type { RingSlice } from './PulseRing';
import type { LocaleDict } from '../../lib/i18n/types';
import type { PulsePerson, PulseResponse } from '../../lib/types';

/** The four cuts of the month the pulse tile draws.
 *
 *  They are four because one is misleading here: this instance's tokens belong almost entirely to one
 *  person, so a per-person ring alone is a solid circle. WHERE the work came from and WHAT the tokens
 *  were spent on both divide properly, and cost divides differently from tokens because the surfaces do
 *  not all run the same models. */

/** A newer bundle can reach an older daemon with no month block, since the browser caches JS while the
 *  daemon restarts on its own schedule. Reading defensively makes that pairing draw empty rings rather
 *  than throw through the whole dashboard. */
const NO_MONTH: PulsePerson['month'] = {
  turns: 0, tokens: 0, cost: null, cacheHitPct: null, memoryHits: 0, surfaces: [], days: [],
};
const monthOf = (person: PulsePerson): PulsePerson['month'] =>
  (person as { month?: PulsePerson['month'] }).month ?? NO_MONTH;

const surfaceLabel = (t: LocaleDict, surface: string): string =>
  (t.dashboard.surfaces as Record<string, string>)[surface] ?? surface;

// ── people ────────────────────────────────────────────────────────────────────────────────────────

/** A person's month at card scale, normalised to their own peak — the one thing a ring cannot show,
 *  since an arc has no time axis. Left on UTC days deliberately: shifting a whole-day count into local
 *  time would split every day across two slots and blur the shape it exists to show. */
function DayCurve({ days, colour }: { days: number[]; colour: string }) {
  const max = Math.max(...days, 0);
  if (max <= 0 || days.length < 2) return null;
  const points = days.map((v, i) => `${(i / (days.length - 1)) * 100},${14 - (v / max) * 12}`).join(' ');
  return (
    <svg aria-hidden viewBox="0 0 100 14" preserveAspectRatio="none" className="mt-1 h-4 w-full">
      <polyline
        points={points} fill="none" stroke={colour} strokeWidth={1.25}
        strokeLinejoin="round" vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Exported for its own test: jsdom computes no layout, so Recharts never measures a ring and the
 *  tooltip cannot be reached through it. */
export function PersonCard({ person, share, colour, t }: {
  person: PulsePerson; share: number; colour: string; t: LocaleDict;
}) {
  const month = monthOf(person);
  return (
    <CardShell>
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
        <CardRow icon={Radio} label={t.dashboard.pulseColChannel}>
          {month.surfaces.length === 0 ? '—' : (
            <span
              className="flex items-center justify-end gap-1"
              title={month.surfaces.map((s) => surfaceLabel(t, s)).join(' · ')}
            >
              {month.surfaces.slice(0, 5).map((s) => <PlatformIcon key={s} platform={s} size={13} />)}
            </span>
          )}
        </CardRow>
        {/* Live process state, so this row alone is not a month figure — there is no such thing as
            "what they were doing over thirty days". */}
        <CardRow icon={Activity} label={t.dashboard.pulseColDoing}>
          {person.working && person.title
            ? <span className="text-success">{person.title}</span>
            : person.lastTs ? t.dashboard.pulseSeen : '—'}
        </CardRow>
        <CardRow icon={DollarSign} label={t.dashboard.pulseColCost}>
          {month.cost === null ? t.dashboard.pulseUnpriced : formatCost(month.cost, 2)}
        </CardRow>
        <CardRow icon={Coins} label={t.dashboard.pulseColTokens}>{formatTokens(month.tokens)}</CardRow>
        <CardRow icon={Zap} label={t.dashboard.pulseColCache}>
          {month.cacheHitPct === null ? '—' : `${Math.round(month.cacheHitPct)} %`}
        </CardRow>
        <CardRow icon={Brain} label={t.dashboard.pulseColHits}>{month.memoryHits.toLocaleString()}</CardRow>
      </div>

      <DayCurve days={month.days} colour={colour} />
    </CardShell>
  );
}

// ── surfaces ──────────────────────────────────────────────────────────────────────────────────────

type Surface = PulseResponse['month']['surfaces'][number];

/** Shared by the tokens ring and the cost ring, so hovering the same surface in either says the same
 *  thing. Both figures appear on both cards — the interesting comparison is exactly where they disagree,
 *  which happens when a surface runs pricier models than its token share suggests. */
function SurfaceCard({ surface, share, colour, t }: {
  surface: Surface; share: number; colour: string; t: LocaleDict;
}) {
  return (
    <CardShell>
      <CardHead colour={colour} title={surfaceLabel(t, surface.surface)} share={share} />
      <div className="mt-2.5 flex flex-col gap-0.5 border-t border-border/60 pt-2">
        <CardRow icon={Coins} label={t.dashboard.pulseColTokens}>{formatTokens(surface.tokens)}</CardRow>
        <CardRow icon={DollarSign} label={t.dashboard.pulseColCost}>
          {surface.cost === null ? t.dashboard.pulseUnpriced : formatCost(surface.cost, 2)}
        </CardRow>
        <CardRow icon={Repeat} label={t.dashboard.pulseColTurns}>{surface.turns.toLocaleString()}</CardRow>
      </div>
    </CardShell>
  );
}

// ── context ───────────────────────────────────────────────────────────────────────────────────────

/** The four kinds of token, in the order they cost money: warm reads are a fraction of fresh input,
 *  which is the whole point of showing this split rather than one total. */
const CONTEXT_KINDS = [
  { key: 'cacheRead', colour: 'var(--color-success)', icon: Zap },
  { key: 'input', colour: 'var(--color-warning)', icon: Flame },
  { key: 'cacheWrite', colour: 'var(--color-ember)', icon: Database },
  { key: 'output', colour: 'var(--color-info)', icon: MessageSquare },
] as const;

type ContextKind = typeof CONTEXT_KINDS[number];
interface ContextDatum { kind: ContextKind; value: number }

function ContextCard({ datum, share, colour, t }: {
  datum: ContextDatum; share: number; colour: string; t: LocaleDict;
}) {
  const labels = t.dashboard.pulseContext as Record<string, string>;
  const hints = t.dashboard.pulseContextHint as Record<string, string>;
  return (
    <CardShell>
      <CardHead colour={colour} title={labels[datum.kind.key] ?? datum.kind.key} share={share} icon={datum.kind.icon} />
      <div className="mt-2.5 flex flex-col gap-0.5 border-t border-border/60 pt-2">
        <CardRow icon={Coins} label={t.dashboard.pulseColTokens}>{formatTokens(datum.value)}</CardRow>
      </div>
      {/* What the number MEANS for the bill — the reason this ring exists at all. */}
      <p className="mt-2 text-[10px] leading-4 text-text-muted">{hints[datum.kind.key] ?? ''}</p>
    </CardShell>
  );
}

// ── the four rings ────────────────────────────────────────────────────────────────────────────────

export function PulseRings({ people, month, t }: {
  people: PulsePerson[]; month: PulseResponse['month'] | undefined; t: LocaleDict;
}) {
  const surfaces = month?.surfaces ?? [];
  const context = month?.context;
  const empty = t.dashboard.pulseRingEmpty;

  // One colour per surface, resolved once and shared by BOTH surface rings: the same channel must not
  // change colour between the tokens ring and the cost ring, or the two stop being comparable.
  const surfaceColour = new Map(surfaces.map((s, i) => [s.surface, colorFor(i)]));

  const peopleSlices: RingSlice<PulsePerson>[] = people.map((person, index) => ({
    key: String(person.userId), value: monthOf(person).tokens, colour: colorFor(index), datum: person,
  }));
  const surfaceSlices: RingSlice<Surface>[] = surfaces.map((s) => ({
    key: s.surface, value: s.tokens, colour: surfaceColour.get(s.surface) ?? colorFor(0), datum: s,
  }));
  const costSlices: RingSlice<Surface>[] = surfaces.map((s) => ({
    key: s.surface, value: s.cost ?? 0, colour: surfaceColour.get(s.surface) ?? colorFor(0), datum: s,
  }));
  const contextSlices: RingSlice<ContextDatum>[] = CONTEXT_KINDS.map((kind) => ({
    key: kind.key,
    value: context?.[kind.key] ?? 0,
    colour: kind.colour,
    datum: { kind, value: context?.[kind.key] ?? 0 },
  }));

  const costTotal = surfaces.reduce((n, s) => n + (s.cost ?? 0), 0);
  const contextTotal = contextSlices.reduce((n, s) => n + s.value, 0);

  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-6 @md:grid-cols-2 @4xl:grid-cols-4">
      <PulseRing
        title={t.dashboard.pulseRingPeople}
        slices={peopleSlices}
        centerValue={formatTokens(month?.tokens ?? 0)}
        centerLabel={t.dashboard.pulseColTokens}
        emptyLabel={empty}
        renderCard={(person, share, colour) => (
          <PersonCard person={person} share={share} colour={colour} t={t} />
        )}
      />
      <PulseRing
        title={t.dashboard.pulseRingChannels}
        slices={surfaceSlices}
        centerValue={String(surfaces.length)}
        centerLabel={t.dashboard.pulseRingChannelsUnit}
        emptyLabel={empty}
        renderCard={(surface, share, colour) => (
          <SurfaceCard surface={surface} share={share} colour={colour} t={t} />
        )}
      />
      <PulseRing
        title={t.dashboard.pulseRingContext}
        slices={contextSlices}
        centerValue={formatTokens(contextTotal)}
        centerLabel={t.dashboard.pulseRingContextUnit}
        emptyLabel={empty}
        renderCard={(datum, share, colour) => (
          <ContextCard datum={datum} share={share} colour={colour} t={t} />
        )}
      />
      <PulseRing
        title={t.dashboard.pulseRingCost}
        slices={costSlices}
        centerValue={formatCost(costTotal, 0)}
        centerLabel={t.dashboard.pulseRingCostUnit}
        emptyLabel={empty}
        renderCard={(surface, share, colour) => (
          <SurfaceCard surface={surface} share={share} colour={colour} t={t} />
        )}
      />
    </div>
  );
}
