'use client';
import { useMemo, useState } from 'react';
import { BarChart3, Boxes, Coins, DollarSign, Database } from 'lucide-react';
import { useModelUsage, useMe } from '../../lib/queries';
import { StatCard } from '../../components/ui/StatCard';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { Button } from '../../components/ui/Button';
import { DateRangeFilter } from '../../components/ui/DateRangeFilter';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { DEFAULT_RANGE, serializeRange, parseRange, isStoredRange, rangeBounds } from '../../lib/dateRange';
import { usePersistentState } from '../../lib/usePersistentState';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { buildUsageSummary } from './usageBars';
import { ResetUsageModal } from './ResetUsageModal';

export function StatsView() {
  const { t } = useTranslation();
  const [rangeRaw, setRangeRaw] = usePersistentState('orca.stats.range', serializeRange(DEFAULT_RANGE), isStoredRange);
  const range = useMemo(() => parseRange(rangeRaw) ?? DEFAULT_RANGE, [rangeRaw]);
  const window = useMemo(() => rangeBounds(range, Date.now()), [range]);
  const usage = useModelUsage(undefined, window);
  const me = useMe();
  const isAdmin = me.data?.user?.is_admin ?? false;
  const [resetOpen, setResetOpen] = useState(false);

  const summary = buildUsageSummary(usage.data);

  return (
    <>
      {/* Date filter lives in the header row — the loading/error states below still respect it,
          so the control stays visible/operable regardless of fetch state. */}
      <ModuleHeader title={t.page.stats} icon={BarChart3}>
        <DateRangeFilter value={range} onChange={(r) => setRangeRaw(serializeRange(r))} />
      </ModuleHeader>

      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
      {usage.isLoading ? (
        <LoadingState variant="cards" />
      ) : usage.isError ? (
        <ErrorState message={t.common.daemonUnreachable} onRetry={() => usage.refetch()} />
      ) : (
        <>
          {/* ── Summary cards ─────────────────────────────────────── */}
          <div className="@container">
          <section className="grid grid-cols-2 gap-4 @3xl:grid-cols-4">
            <StatCard value={summary.totalCostLabel} label={t.stats.cardTotalCost} icon={DollarSign} />
            <StatCard value={summary.totalTokensLabel} label={t.stats.cardTotalTokens} icon={Coins} />
            <StatCard value={summary.totalCacheLabel} label={t.stats.cardCache} icon={Database} />
            <StatCard value={summary.modelsUsed} label={t.stats.cardModelsUsed} icon={Boxes} />
          </section>
          </div>

          {/* ── Cost by model ─────────────────────────────────────── */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-muted">{t.stats.costByModel}</h2>
              {isAdmin && summary.hasAnyUsage ? (
                <Button variant="danger" onClick={() => setResetOpen(true)}>{t.stats.reset}</Button>
              ) : null}
            </div>

            {!summary.hasAnyUsage ? (
              <EmptyState title={t.stats.emptyTitle} description={t.stats.emptyDesc} icon={BarChart3} />
            ) : (
              <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface" style={{ boxShadow: 'var(--shadow-card)' }}>
                {summary.rows.map((row) => (
                  <div key={row.exec} className="flex items-center gap-3 px-4 py-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-elevated">
                      <ModelIcon name={row.exec} size={15} />
                    </span>
                    <span className="w-40 shrink-0 truncate font-mono text-xs text-text" title={row.exec}>{row.exec}</span>
                    <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-elevated">
                      <div className="h-full rounded-full bg-accent/55" style={{ width: `${row.pct}%` }} />
                    </div>
                    <span className="w-20 shrink-0 text-right font-mono text-xs tabular-nums text-text-muted">{row.tokensLabel}</span>
                    <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums text-text">{row.costLabel}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {resetOpen ? <ResetUsageModal onClose={() => setResetOpen(false)} /> : null}
        </>
      )}
      </div>
    </>
  );
}
