'use client';
import { usePulse } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { LoadingState } from '../../components/ui/states';
import { Avatar } from '../../components/ui/Avatar';
import { formatCost, formatTokens } from '../../lib/format';
import { PulseDonut } from './PulseDonut';
import { PulseStats } from './PulseStats';
import { colorFor } from './pulseSeries';
import type { LocaleDict } from '../../lib/i18n/types';
import type { PulsePerson } from '../../lib/types';

/** Who is who, so the ring can be read without hovering it. Everything else about a person lives in
 *  the hover card — this line exists only to attach a name to a colour. */
function PulseLegend({ people, totalTokens, t }: {
  people: PulsePerson[]; totalTokens: number; t: LocaleDict;
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {people.map((person, index) => (
        <li key={person.userId} className="flex min-w-0 items-center gap-1.5">
          <span className="relative shrink-0">
            <Avatar
              user={{
                id: person.userId, username: person.username, name: person.label,
                ...(person.avatar ? { avatar: person.avatar } : {}),
              }}
              size={20}
            />
            <span
              aria-hidden
              className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-surface"
              style={{ background: colorFor(index) }}
            />
          </span>
          <span className="truncate text-[12px] text-text">{person.label}</span>
          {person.working ? (
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-success" title={t.dashboard.workingNow} />
          ) : null}
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-muted">
            {totalTokens > 0 ? `${((person.tokens / totalTokens) * 100).toFixed(0)} %` : '—'}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The dashboard's people tile: what the instance did today, who did it, and what it cost.
 *
 *  Everything here is today on the daemon's UTC day basis, which is how the rollups behind it are keyed.
 *  The tile is fed by one request and refreshed by the same SSE 'activity' event as the feed, so a turn
 *  starting lights it up without a poll — there is no refresh interval to state. */
export function TeamPulseTile() {
  const { t } = useTranslation();
  const pulse = usePulse();
  const data = pulse.data;
  const people = data?.people ?? [];

  return (
    <section aria-labelledby="dashboard-pulse" className="px-1 py-6 @sm:px-3 @2xl:px-5">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-center gap-2">
          <h2 id="dashboard-pulse" className="dash-label">{t.dashboard.pulse}</h2>
          {/* Live because the tile is SSE-driven, not because anything polls. */}
          <span className="rounded-full border border-accent/40 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-accent">
            {t.dashboard.live}
          </span>
        </div>
        {data ? (
          <div className="flex items-baseline gap-x-4 font-mono text-[11px] tabular-nums text-text-muted">
            <span className="text-text">{formatTokens(data.totals.tokens)}</span>
            <span className="text-text">
              {data.spendAvailable === false
                ? t.dashboard.pulseSpendOff
                : data.totals.cost === null ? t.dashboard.pulseUnpriced : formatCost(data.totals.cost, 2)}
            </span>
            <span>{t.dashboard.pulseTodayLabel}</span>
          </div>
        ) : null}
      </header>

      {pulse.isLoading ? (
        <LoadingState />
      ) : !data || people.length === 0 ? (
        <p className="text-sm text-text-muted">{t.dashboard.pulseNobody}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <PulseStats data={data} t={t} />
          <PulseDonut people={people} totalTokens={data.totals.tokens} t={t} />
          <PulseLegend people={people} totalTokens={data.totals.tokens} t={t} />
        </div>
      )}
    </section>
  );
}
