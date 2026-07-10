'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { BarChart3, Boxes, Database, DollarSign, type LucideIcon } from 'lucide-react';
import { useModelUsage, useMe } from '../../lib/queries';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { Button } from '../../components/ui/Button';
import { DateRangeFilter } from '../../components/ui/DateRangeFilter';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { PageMascot } from '../../components/ui/PageMascot';
import { DataTable, DataTableCell, DataTableRow } from '../../components/ui/DataTable';
import { PageFrame } from '../../components/ui/PageFrame';
import { MotionLayoutItem, MotionPresence } from '../../components/ui/Motion';
import { DEFAULT_RANGE, serializeRange, parseRange, isStoredRange, rangeBounds } from '../../lib/dateRange';
import { usePersistentState } from '../../lib/usePersistentState';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { buildUsageSummary } from './usageBars';
import { ResetUsageModal } from './ResetUsageModal';

export function StatsView() {
  const { t } = useTranslation();
  const [rangeRaw, setRangeRaw] = usePersistentState('elowen.stats.range', serializeRange(DEFAULT_RANGE), isStoredRange);
  const range = useMemo(() => parseRange(rangeRaw) ?? DEFAULT_RANGE, [rangeRaw]);
  const window = useMemo(() => rangeBounds(range, Date.now()), [range]);
  const usage = useModelUsage(undefined, window);
  const me = useMe();
  const isAdmin = me.data?.user?.is_admin ?? false;
  const [resetOpen, setResetOpen] = useState(false);

  const summary = buildUsageSummary(usage.data);

  return (
    <>
      <ModuleHeader title={t.page.stats} icon={BarChart3}>
        <DateRangeFilter value={range} onChange={(next) => setRangeRaw(serializeRange(next))} compact />
      </ModuleHeader>

      <PageFrame width="wide" className="gap-8">
        {usage.isLoading ? (
          <LoadingState variant="cards" />
        ) : usage.isError ? (
          <ErrorState message={t.common.daemonUnreachable} onRetry={() => usage.refetch()} />
        ) : (
          <>
            <section data-testid="stats-hero" className="@container relative isolate overflow-hidden border-y border-border/80 bg-black">
              <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_25%_48%,rgb(255_76_40_/_0.17),transparent_26%),radial-gradient(circle_at_72%_42%,rgb(255_255_255_/_0.035),transparent_28%),linear-gradient(rgb(255_255_255_/_0.025)_1px,transparent_1px),linear-gradient(90deg,rgb(255_255_255_/_0.025)_1px,transparent_1px)] bg-[size:auto,auto,3rem_3rem,3rem_3rem]" />
              <div className="grid min-h-[29rem] items-center gap-2 @4xl:grid-cols-[minmax(18rem,.78fr)_minmax(0,1.22fr)]">
                <div className="relative order-2 flex min-h-64 items-center justify-center @4xl:order-1 @4xl:min-h-[29rem]">
                  <PageMascot size="hero" />
                </div>

                <div className="order-1 flex min-w-0 flex-col gap-7 px-5 pb-2 pt-7 @4xl:order-2 @4xl:px-10 @4xl:py-9">
                  <div className="flex flex-col gap-2">
                    <span className="inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.18em] text-accent">
                      <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_14px_rgb(255_82_54_/_0.9)]" aria-hidden />
                      {t.stats.pulseLabel}
                    </span>
                    <span className="font-mono text-5xl font-semibold leading-none tracking-[-0.055em] text-text tabular-nums sm:text-6xl @4xl:text-7xl">{summary.totalTokensLabel}</span>
                    <span className="text-xs font-medium uppercase tracking-[.14em] text-text-muted">{t.stats.cardTotalTokens}</span>
                  </div>

                  <dl className="grid gap-3 [perspective:900px] [transform-style:preserve-3d] sm:grid-cols-3">
                    <MetricPlane value={summary.totalCostLabel} label={t.stats.cardTotalCost} icon={DollarSign} className="sm:[transform:translate3d(0,-.35rem,18px)_rotateY(1.5deg)]" />
                    <MetricPlane value={summary.totalCacheLabel} label={t.stats.cardCache} icon={Database} className="sm:[transform:translate3d(.45rem,.55rem,8px)_rotateX(-1.5deg)]" />
                    <MetricPlane value={summary.modelsUsed} label={t.stats.cardModelsUsed} icon={Boxes} className="sm:[transform:translate3d(-.25rem,-.1rem,24px)_rotateY(-1.5deg)]" />
                  </dl>
                </div>
              </div>
            </section>

            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <h2 className="text-sm font-semibold text-text">{t.stats.costByModel}</h2>
                  <p className="text-xs text-text-muted">{t.stats.ledgerHint}</p>
                </div>
                {isAdmin && summary.hasAnyUsage ? (
                  <Button variant="ghost" onClick={() => setResetOpen(true)}>{t.stats.reset}</Button>
                ) : null}
              </div>

              {!summary.hasAnyUsage ? (
                <EmptyState title={t.stats.emptyTitle} description={t.stats.emptyDesc} icon={BarChart3} />
              ) : (
                <div data-testid="model-usage-list">
                  <DataTable
                    ariaLabel={t.stats.costByModel}
                    columns="2rem minmax(0,12rem) minmax(8rem,1fr) 7rem 7rem"
                    compactColumns="2rem minmax(0,1fr) auto"
                  >
                    <DataTableRow header className="px-1">
                      <DataTableCell header role="presentation" aria-hidden>{null}</DataTableCell>
                      <DataTableCell header>{t.stats.cardModelsUsed}</DataTableCell>
                      <DataTableCell header priority="wide">{t.stats.pulseLabel}</DataTableCell>
                      <DataTableCell header priority="wide" className="text-right">{t.stats.cardTotalTokens}</DataTableCell>
                      <DataTableCell header className="text-right">{t.stats.cardTotalCost}</DataTableCell>
                    </DataTableRow>
                    <div role="rowgroup">
                      <MotionPresence>
                        {summary.rows.map((row) => (
                          <MotionLayoutItem
                            key={row.exec}
                            layoutId={`stats-model-${row.exec}`}
                            role="presentation"
                            className="border-b border-border/70 last:border-b-0"
                          >
                            <DataTableRow data-testid="model-usage-row" interactive className="gap-y-2 px-1">
                              <DataTableCell className="flex h-8 w-8 shrink-0 items-center justify-center text-text-muted">
                                <ModelIcon name={row.exec} size={17} />
                              </DataTableCell>
                              <DataTableCell className="truncate font-mono text-xs text-text" title={row.exec}>{row.exec}</DataTableCell>
                              <DataTableCell className="col-start-2 col-end-4 row-start-2 h-px bg-border @4xl:col-start-3 @4xl:col-end-4 @4xl:row-start-1">
                                <div aria-hidden className="relative h-px bg-gradient-to-r from-accent via-[#ff955f] to-[#ffd09a] shadow-[0_0_9px_rgb(255_82_54_/_0.35)]" style={{ width: `${row.pct}%` }}>
                                  <span className="absolute -right-0.5 -top-0.5 h-1 w-1 rounded-full bg-[#ffd09a] shadow-[0_0_8px_rgb(255_160_105_/_0.85)]" />
                                </div>
                              </DataTableCell>
                              <DataTableCell
                                className="col-start-2 row-start-3 font-mono text-xs tabular-nums text-text-muted @4xl:col-start-4 @4xl:row-start-1 @4xl:text-right"
                                aria-label={`${t.stats.cardTotalTokens}: ${row.tokensLabel}`}
                              >
                                {row.tokensLabel}
                              </DataTableCell>
                              <DataTableCell
                                className="col-start-3 row-start-1 text-right font-mono text-xs tabular-nums text-text @4xl:col-start-5"
                                aria-label={`${t.stats.cardTotalCost}: ${row.costLabel}`}
                              >
                                {row.costLabel}
                              </DataTableCell>
                            </DataTableRow>
                          </MotionLayoutItem>
                        ))}
                      </MotionPresence>
                    </div>
                  </DataTable>
                </div>
              )}
            </section>

            {resetOpen ? <ResetUsageModal onClose={() => setResetOpen(false)} /> : null}
          </>
        )}
      </PageFrame>
    </>
  );
}

function MetricPlane({ value, label, icon: Icon, className = '' }: {
  value: ReactNode;
  label: string;
  icon: LucideIcon;
  className?: string;
}) {
  return (
    <div className={`group relative min-w-0 border border-border/80 bg-black/75 px-4 py-3.5 shadow-[0_18px_55px_rgb(0_0_0_/_0.45)] transition-[border-color,transform] hover:border-accent/35 ${className}`}>
      <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/35 to-transparent" />
      <dt className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[.13em] text-text-muted"><Icon size={12} aria-hidden />{label}</dt>
      <dd className="mt-2 truncate font-mono text-xl font-semibold tabular-nums text-text">{value}</dd>
    </div>
  );
}
