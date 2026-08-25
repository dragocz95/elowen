'use client';
import { useMemo } from 'react';
import { usePulse } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { LoadingState } from '../../components/ui/states';
import { formatCost, formatTokens } from '../../lib/format';
import { PulseChart } from './PulseChart';
import { PulseStats } from './PulseStats';
import { PulseTable } from './PulseTable';
import { buildChartRows } from './pulseSeries';

/** The dashboard's people tile: what the instance did today, who did it, and what it cost.
 *
 *  Everything here is today on the daemon's UTC day basis, which is how both rollups behind it are
 *  keyed; the chart shifts into the reader's local hours at draw time. The tile is fed by one request
 *  and refreshed by the same SSE 'activity' event as the feed, so a turn starting lights it up without
 *  a poll — there is no refresh interval to state. */
export function TeamPulseTile() {
  const { t } = useTranslation();
  const pulse = usePulse();
  const data = pulse.data;
  const people = useMemo(() => data?.people ?? [], [data]);
  const rows = useMemo(
    () => buildChartRows(people, data?.memoryByHour ?? []),
    [people, data?.memoryByHour],
  );

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
          <PulseChart rows={rows} people={people} t={t} />
          <PulseTable people={people} t={t} />
        </div>
      )}
    </section>
  );
}
