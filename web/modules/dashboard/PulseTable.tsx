'use client';
import { Avatar } from '../../components/ui/Avatar';
import { PlatformIcon } from '../../components/ui/PlatformIcon';
import { formatCost, formatTokens } from '../../lib/format';
import { HOURS, colorFor, toLocalHours } from './pulseSeries';
import type { LocaleDict } from '../../lib/i18n/types';
import type { PulsePerson } from '../../lib/types';

/** Who did what today, one row per person.
 *
 *  A real <table> rather than the shared DataTable: this is a dashboard tile, not a register — there is
 *  no sorting, paging, selection or detail rail to inherit, and DataTable's row chrome would fight the
 *  tile's own density. The typography is the point of the row, so the columns are deliberately split
 *  between a text face for names and a tabular mono face for every number, which keeps digits in
 *  vertical register down the column.
 *
 *  Sparklines are hand-drawn SVG here even though the chart above uses Recharts: a responsive container
 *  per row would mount one chart instance per person to draw twenty-four points with no interaction. */

/** A person's day at row scale. Normalised to their own peak, so a quiet row still shows its shape —
 *  the columns beside it already say how much work it was in absolute terms. */
function Sparkline({ hours, colour }: { hours: number[]; colour: string }) {
  const max = Math.max(...hours, 0);
  if (max <= 0) return <span aria-hidden className="block h-4 w-full" />;
  const points = hours
    .map((v, i) => `${(i / (HOURS - 1)) * 100},${16 - (v / max) * 14}`)
    .join(' ');
  return (
    <svg aria-hidden viewBox="0 0 100 16" preserveAspectRatio="none" className="h-4 w-full overflow-visible">
      <polyline
        points={points} fill="none" stroke={colour} strokeWidth={1.25}
        strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function PersonRow({ person, index, t }: { person: PulsePerson; index: number; t: LocaleDict }) {
  const surfaces = t.dashboard.surfaces as Record<string, string>;
  const colour = colorFor(index);
  const doing = person.working && person.title ? person.title : '';

  return (
    <tr className="group border-t border-border/40">
      <td className="py-2 pr-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="relative shrink-0">
            <Avatar
              user={{
                id: person.userId, username: person.username, name: person.label,
                ...(person.avatar ? { avatar: person.avatar } : {}),
              }}
              size={28}
            />
            {/* The curve's colour, repeated on the avatar — this is what lets the chart drop its legend. */}
            <span
              aria-hidden
              className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface"
              style={{ background: colour }}
            />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium leading-tight text-text">{person.label}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-tight text-text-muted">
              {person.working ? (
                <>
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-success" />
                  <span className="text-success">{t.dashboard.workingNow}</span>
                </>
              ) : (
                <span className="truncate">{person.lastTs ? t.dashboard.pulseSeen : '\u00a0'}</span>
              )}
            </div>
          </div>
        </div>
      </td>

      <td className="hidden py-2 pr-2 @2xl:table-cell">
        <span
          className="flex items-center gap-1"
          title={person.surfaces.map((s) => surfaces[s] ?? surfaces.unknown).join(' · ')}
        >
          {person.surfaces.length === 0
            ? <span className="text-[11px] text-text-subtle">—</span>
            : person.surfaces.slice(0, 4).map((s) => <PlatformIcon key={s} platform={s} size={14} />)}
        </span>
      </td>

      <td className="hidden max-w-0 py-2 pr-3 @xl:table-cell">
        <span className="block truncate text-[12px] text-text-muted" title={doing || undefined}>
          {doing || '—'}
        </span>
      </td>

      <td className="py-2 pr-3 text-right font-mono text-[12px] tabular-nums text-text">
        {person.cost === null ? <span className="text-text-subtle">—</span> : formatCost(person.cost, 2)}
      </td>

      <td className="hidden py-2 pr-3 text-right font-mono text-[12px] tabular-nums text-text-muted @md:table-cell">
        {formatTokens(person.tokens)}
      </td>

      <td className="hidden py-2 pr-3 text-right font-mono text-[12px] tabular-nums text-text-muted @2xl:table-cell">
        {person.memoryHits.toLocaleString()}
      </td>

      <td className="hidden py-2 pr-3 text-right font-mono text-[12px] tabular-nums text-text-muted @3xl:table-cell">
        {person.cacheHitPct === null ? '—' : `${Math.round(person.cacheHitPct)} %`}
      </td>

      <td className="w-20 py-2 pl-1">
        <Sparkline hours={toLocalHours(person.hoursToday)} colour={colour} />
      </td>
    </tr>
  );
}

const HEAD = 'pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-subtle';

export function PulseTable({ people, t }: { people: PulsePerson[]; t: LocaleDict }) {
  return (
    <table className="w-full table-auto border-collapse text-left">
      <thead>
        <tr>
          <th scope="col" className={`${HEAD} pr-2`}>{t.dashboard.pulseColPerson}</th>
          <th scope="col" className={`${HEAD} hidden pr-2 @2xl:table-cell`}>{t.dashboard.pulseColChannel}</th>
          <th scope="col" className={`${HEAD} hidden pr-3 @xl:table-cell`}>{t.dashboard.pulseColDoing}</th>
          <th scope="col" className={`${HEAD} pr-3 text-right`}>{t.dashboard.pulseColCost}</th>
          <th scope="col" className={`${HEAD} hidden pr-3 text-right @md:table-cell`}>{t.dashboard.pulseColTokens}</th>
          <th scope="col" className={`${HEAD} hidden pr-3 text-right @2xl:table-cell`}>{t.dashboard.pulseColHits}</th>
          <th scope="col" className={`${HEAD} hidden pr-3 text-right @3xl:table-cell`}>{t.dashboard.pulseColCache}</th>
          <th scope="col" className={`${HEAD} pl-1`}><span className="sr-only">{t.dashboard.pulseColActivity}</span></th>
        </tr>
      </thead>
      <tbody>
        {people.map((person, i) => <PersonRow key={person.userId} person={person} index={i} t={t} />)}
      </tbody>
    </table>
  );
}
