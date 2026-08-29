'use client';
import { Sparkline } from '../../components/ui/Sparkline';
import { HOURS, deltaPct, toLocalHours } from './pulseSeries';
import type { LocaleDict } from '../../lib/i18n/types';
import type { PulseResponse } from '../../lib/types';

/** The four headline numbers, each with what it did against yesterday and — where a real series exists —
 *  the shape of today behind it.
 *
 *  Two of the four carry no sparkline on purpose. Running agents is a live gauge with no stored history,
 *  and the cache ratio is only rolled up per day, so drawing either as a curve would mean inventing the
 *  hours. A number that is honestly flat beats a line that implies a measurement nobody took. */

interface CardProps {
  label: string;
  value: string;
  colour: string;
  /** Already rotated into local time by the caller. */
  series?: number[];
  footnote?: React.ReactNode;
}

function StatCard({ label, value, colour, series, footnote }: CardProps) {
  return (
    <div className="min-w-0 rounded-xl border border-border/60 bg-elevated/25 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: colour }} />
        <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-text-muted">{label}</span>
      </div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <span className="font-mono text-2xl leading-none tabular-nums text-text">{value}</span>
        {series ? (
          <Sparkline values={series} colour={colour} className="h-8 w-16 shrink-0 @lg:w-20" />
        ) : null}
      </div>
      <div className="mt-1 truncate text-[10px] text-text-muted">{footnote}</div>
    </div>
  );
}

/** "+12 % vs. yesterday", coloured by direction — or a plain note when yesterday was empty and a
 *  percentage would be arithmetic on nothing. */
function Delta({ today, yesterday, t }: { today: number; yesterday: number; t: LocaleDict }) {
  const pct = deltaPct(today, yesterday);
  if (pct === null) return <>{t.dashboard.pulseNoBaseline}</>;
  const rounded = Math.round(pct);
  if (rounded === 0) return <>{t.dashboard.pulseFlat}</>;
  return (
    <>
      <span className={rounded > 0 ? 'text-success' : 'text-danger'}>
        {rounded > 0 ? '+' : ''}{rounded}&nbsp;%
      </span>{' '}
      {t.dashboard.pulseVsYesterday}
    </>
  );
}

export function PulseStats({ data, t }: { data: PulseResponse; t: LocaleDict }) {
  const { totals, yesterday } = data;

  // How many distinct people were active in each hour — the only per-hour headcount the buckets can
  // honestly support, since presence itself is not recorded hour by hour.
  const localPerPerson = data.people.map((p) => toLocalHours(p.hoursToday));
  const peopleByHour = Array.from({ length: HOURS }, (_, h) =>
    localPerPerson.reduce((n, hours) => n + ((hours[h] ?? 0) > 0 ? 1 : 0), 0));

  return (
    <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
      <StatCard
        label={t.dashboard.pulseActivePeople}
        value={String(totals.activePeople)}
        colour="var(--color-success)"
        series={peopleByHour}
        footnote={<Delta today={totals.activePeople} yesterday={yesterday.people} t={t} />}
      />
      <StatCard
        label={t.dashboard.pulseRunningAgents}
        value={String(totals.runningAgents)}
        colour="var(--color-primary)"
        footnote={totals.runningAgents > 0 ? t.dashboard.pulseAgentsBusy : t.dashboard.pulseAgentsIdle}
      />
      <StatCard
        label={t.dashboard.pulseMemoryHits}
        value={totals.memoryHits.toLocaleString()}
        colour="var(--color-info)"
        series={toLocalHours(data.memoryByHour)}
        footnote={t.dashboard.pulseMemoryFoot}
      />
      <StatCard
        label={t.dashboard.pulseCacheHit}
        value={totals.cacheHitPct === null ? '—' : `${totals.cacheHitPct.toFixed(1)} %`}
        colour="var(--color-warning)"
        footnote={t.dashboard.pulseCacheFoot}
      />
    </div>
  );
}
