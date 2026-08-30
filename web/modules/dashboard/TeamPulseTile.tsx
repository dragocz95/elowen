'use client';
import { usePulse } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { LoadingState } from '../../components/ui/states';
import { formatCost, formatTokens } from '../../lib/format';
import { PulseStats } from './PulseStats';

/** The dashboard's people panel: what the instance is doing today — the headline gauges and their
 *  against-yesterday deltas. The monthly ring charts that used to follow them live in the metrics
 *  panel (MetricsTile), which is the disclosure that question belongs to now.
 *
 *  The tile is fed by one request and refreshed by the same SSE 'activity' event as the feed, so a turn
 *  starting lights it up without a poll — there is no refresh interval to state. */
export function TeamPulseTile() {
  const { t } = useTranslation();
  const pulse = usePulse();
  const data = pulse.data;
  const people = data?.people ?? [];
  // `data` being present is not the same as its sections being present. The tile reads an external
  // payload and dereferences each section below, so a response that omits one degrades to the tile's
  // empty state rather than throwing and collapsing the whole dashboard route. Guarded per consumer,
  // not as one all-or-nothing check: the gauges and the rings read different halves of the response,
  // and a payload that can still answer one of them should still show it.
  const totals = data?.totals;
  const canStat = data != null && totals != null && data.yesterday != null && data.memoryByHour != null;

  return (
    <section aria-labelledby="dashboard-pulse" className="px-4 pb-6 pt-1 @sm:px-6">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-center gap-2">
          <h2 id="dashboard-pulse" tabIndex={-1} className="dash-label outline-none">{t.dashboard.pulse}</h2>
          {/* Live because the tile is SSE-driven, not because anything polls. */}
          <span className="dash-live rounded-full border border-primary/40 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-primary">
            {t.dashboard.live}
          </span>
        </div>
        {data && totals ? (
          <div className="flex items-baseline gap-x-4 font-mono text-[11px] tabular-nums text-muted-foreground">
            <span className="text-foreground">{formatTokens(totals.tokens)}</span>
            <span className="text-foreground">
              {data.spendAvailable === false
                ? t.dashboard.pulseSpendOff
                : totals.cost === null ? t.dashboard.pulseUnpriced : formatCost(totals.cost, 2)}
            </span>
            <span>{t.dashboard.pulseTodayLabel}</span>
          </div>
        ) : null}
      </header>

      {pulse.isLoading ? (
        <LoadingState />
      ) : !data || people.length === 0 || !canStat ? (
        <p className="text-sm text-muted-foreground">{t.dashboard.pulseNobody}</p>
      ) : (
        <PulseStats data={data} t={t} />
      )}
    </section>
  );
}
