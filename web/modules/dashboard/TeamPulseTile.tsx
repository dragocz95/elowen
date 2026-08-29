'use client';
import { usePulse } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { LoadingState } from '../../components/ui/states';
import { formatCost, formatTokens } from '../../lib/format';
import { PulseRings } from './PulseRings';
import { PulseStats } from './PulseStats';

/** The dashboard's people tile: what the instance is doing today, and how the month divided.
 *
 *  Two windows on purpose: the gauges and the headline report TODAY, the rings below them report the
 *  trailing month, because a single day divides too thinly to have a shape. Both sit on the daemon's
 *  UTC day basis, which is how the rollups behind them are keyed.
 *
 *  FOUR rings rather than one, because one cut lies by omission here — this instance's tokens belong
 *  almost entirely to a single person, so a per-person ring alone is a solid circle. Where the work came
 *  from, what the tokens were spent on, and how cost divides (differently from tokens, since the
 *  surfaces do not run the same models) each answer something the others cannot.
 *
 *  The rings carry no legend. Identity lives in their hover cards, which have to exist for the numbers
 *  anyway — a second copy of the same names underneath said nothing more and competed for attention.
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
  const month = data?.month;

  return (
    <section aria-labelledby="dashboard-pulse" className="px-1 py-6 @sm:px-3 @2xl:px-5">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-center gap-2">
          <h2 id="dashboard-pulse" className="dash-label">{t.dashboard.pulse}</h2>
          {/* Live because the tile is SSE-driven, not because anything polls. */}
          <span className="dash-live rounded-full border border-primary/40 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-primary">
            {t.dashboard.live}
          </span>
        </div>
        {data && totals ? (
          <div className="flex items-baseline gap-x-4 font-mono text-[11px] tabular-nums text-text-muted">
            <span className="text-text">{formatTokens(totals.tokens)}</span>
            <span className="text-text">
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
      ) : !data || people.length === 0 || (!canStat && !month) ? (
        <p className="text-sm text-text-muted">{t.dashboard.pulseNobody}</p>
      ) : (
        <div className="flex flex-col gap-6">
          {canStat ? <PulseStats data={data} t={t} /> : null}
          {month ? <PulseRings people={people} month={month} t={t} /> : null}
        </div>
      )}
    </section>
  );
}
