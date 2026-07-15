'use client';

import { useMemo, useState } from 'react';
import { BarChart3, Boxes, Database, DollarSign } from 'lucide-react';
import { useModelUsage, useMe } from '../../lib/queries';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { DateRangeFilter } from '../../components/ui/DateRangeFilter';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { DataTable, DataTableCell, DataTableRow } from '../../components/ui/DataTable';
import { MotionLayoutItem, MotionPresence } from '../../components/ui/Motion';
import { DEFAULT_RANGE, serializeRange, parseRange, isStoredRange, rangeBounds } from '../../lib/dateRange';
import { usePersistentState } from '../../lib/usePersistentState';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { buildUsageSummary } from './usageBars';
import { ResetUsageModal } from './ResetUsageModal';
import { SpatialWorkspaceLayout, WorkspaceMetric } from '../../components/ui/WorkspacePrimitives';
import { ControlSurfaceDocument, ControlSurfaceRegister, ControlSurfaceState, ControlSurfaceToolbar } from '../../components/ui/ControlSurface';

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
      <ModuleHeader title={t.page.stats} icon={BarChart3} />
      <SpatialWorkspaceLayout hero={{
        eyebrow: t.stats.workspaceEyebrow,
        title: t.page.stats,
        count: summary.modelsUsed,
        description: t.stats.workspaceIntro,
        mascotState: usage.isLoading ? 'saving' : usage.isError ? 'error' : 'idle',
        status: !usage.isLoading && !usage.isError ? <span className="workspace-status">{t.stats.workspaceReady}</span> : undefined,
        metrics: <>
          <WorkspaceMetric label={t.stats.cardTotalTokens} value={summary.totalTokensLabel} icon={BarChart3} />
          <WorkspaceMetric label={t.stats.cardTotalCost} value={summary.totalCostLabel} icon={DollarSign} />
          <WorkspaceMetric label={t.stats.cardCache} value={summary.totalCacheLabel} icon={Database} />
          <WorkspaceMetric label={t.stats.cardModelsUsed} value={summary.modelsUsed} icon={Boxes} />
        </>,
      }}>
        <ControlSurfaceDocument>
          <ControlSurfaceToolbar className="justify-end">
            <DateRangeFilter value={range} onChange={(next) => setRangeRaw(serializeRange(next))} compact />
          </ControlSurfaceToolbar>
        {usage.isLoading ? (
          <ControlSurfaceState><LoadingState variant="list" /></ControlSurfaceState>
        ) : usage.isError ? (
          <ControlSurfaceState tone="danger"><ErrorState message={t.common.daemonUnreachable} onRetry={() => usage.refetch()} /></ControlSurfaceState>
        ) : (
          <ControlSurfaceRegister className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <h2 className="text-sm font-semibold text-text">{t.stats.costByModel}</h2>
                  <p className="text-xs text-text-muted">{t.stats.ledgerHint}</p>
                </div>
                {isAdmin && summary.hasAnyUsage ? (
                  <button type="button" className="text-xs text-text-muted transition-colors hover:text-danger" onClick={() => setResetOpen(true)}>{t.stats.reset}</button>
                ) : null}
              </div>

              {!summary.hasAnyUsage ? (
                <EmptyState title={t.stats.emptyTitle} description={t.stats.emptyDesc} icon={BarChart3} />
              ) : (
                <div data-testid="model-usage-list">
                  <DataTable
                    ariaLabel={t.stats.costByModel}
                    columns="2rem minmax(0,12rem) minmax(6rem,1fr) 7.5rem 9rem"
                    compactColumns="2rem minmax(0,1fr) auto"
                  >
                    <DataTableRow header>
                      <DataTableCell header role="presentation" aria-hidden>{null}</DataTableCell>
                      <DataTableCell header className="whitespace-nowrap">{t.stats.cardModelsUsed}</DataTableCell>
                      <DataTableCell header priority="wide" className="whitespace-nowrap">{t.stats.pulseLabel}</DataTableCell>
                      <DataTableCell header priority="wide" className="whitespace-nowrap text-right">{t.stats.cardTotalTokens}</DataTableCell>
                      <DataTableCell header className="whitespace-nowrap text-right">{t.stats.cardTotalCost}</DataTableCell>
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
                            <DataTableRow data-testid="model-usage-row" interactive className="gap-y-2">
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
          </ControlSurfaceRegister>
        )}
        </ControlSurfaceDocument>
      </SpatialWorkspaceLayout>
      {resetOpen ? <ResetUsageModal onClose={() => setResetOpen(false)} /> : null}
    </>
  );
}
