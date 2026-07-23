'use client';

import { useState, useEffect, useCallback } from 'react';
import { BarChart3, ChevronLeft, ChevronRight, Database, DollarSign, Boxes } from 'lucide-react';
import { useBrainChat } from './BrainChatProvider';
import { useModelUsage } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { formatTokens, formatCost } from '../../lib/format';
import { buildUsageSummary } from '../stats/usageBars';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { Modal, ModalBody } from '../../components/ui/Modal';

type Section = 'conversation' | 'models';

export function StatsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { usage, currentModel } = useBrainChat();
  const usageQuery = useModelUsage();
  const summary = buildUsageSummary(usageQuery.data);

  const [section, setSection] = useState<Section>('conversation');

  const cycle = useCallback((_dir: -1 | 1) => {
    setSection((cur) => (cur === 'conversation' ? 'models' : 'conversation') as Section);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); cycle(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); cycle(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycle]);

  const u = usage;
  const pct = u?.percent != null ? Math.round(u.percent) : null;

  return (
    <Modal title={t.stats.modalTitle} onClose={onClose} size="md" icon={BarChart3}>
      <ModalBody gap={4}>
        {/* Section pager */}
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => cycle(-1)}
            aria-label={t.common.back}
            className="flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            <ChevronLeft size={16} aria-hidden />
          </button>

          <div className="flex items-center gap-2 text-sm font-medium text-text">
            {section === 'conversation' ? t.stats.sectionConversation : t.stats.sectionModels}
            <span className="text-xs text-text-muted">
              {section === 'conversation' ? '1/2' : '2/2'}
            </span>
          </div>

          <button
            type="button"
            onClick={() => cycle(1)}
            aria-label={t.common.forward}
            className="flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            <ChevronRight size={16} aria-hidden />
          </button>
        </div>

        {section === 'conversation' && (
          <div className="flex flex-col gap-4">
            {/* Context usage bar */}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-text-muted">{t.stats.contextLabel}</span>
              <div className="relative h-6 w-full overflow-hidden rounded-md border border-border bg-elevated">
                <div
                  className="h-full rounded-md transition-all"
                  style={{
                    width: `${Math.min(100, pct ?? 0)}%`,
                    background: pct != null && pct >= 90
                      ? 'var(--color-danger)'
                      : pct != null && pct >= 70
                        ? 'var(--color-warning)'
                        : 'var(--color-accent)',
                  }}
                />
              </div>
              <span className="text-xs tabular-nums text-text-muted">
                {u ? `${formatTokens(u.tokens ?? 0)} / ${formatTokens(u.contextWindow)}` : '—'}
                {pct != null ? `  ·  ${pct} %` : ''}
              </span>
            </div>

            {/* Model row */}
            <div className="flex items-center justify-between rounded-md border border-border bg-elevated px-3 py-2">
              <span className="text-xs text-text-muted">{t.stats.model}</span>
              <span className="text-sm font-mono text-text">{currentModel || '—'}</span>
            </div>

            {/* Metrics grid */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1 rounded-md border border-border bg-elevated px-3 py-2">
                <span className="flex items-center gap-1.5 text-xs text-text-muted">
                  <BarChart3 size={13} aria-hidden />
                  {t.stats.sessionTokens}
                </span>
                <span className="font-mono text-sm tabular-nums text-text">
                  {u ? formatTokens(u.totalTokens) : '—'}
                </span>
              </div>
              <div className="flex flex-col gap-1 rounded-md border border-border bg-elevated px-3 py-2">
                <span className="flex items-center gap-1.5 text-xs text-text-muted">
                  <DollarSign size={13} aria-hidden />
                  {t.stats.cardTotalCost}
                </span>
                <span className="font-mono text-sm tabular-nums text-text">
                  {u ? formatCost(u.cost) : '—'}
                </span>
              </div>
            </div>

            <p className="text-xs text-text-muted">{t.stats.arrowHint}</p>
          </div>
        )}

        {section === 'models' && (
          <div className="flex flex-col gap-3">
            {/* Totals strip */}
            {summary.hasAnyUsage && (
              <div className="grid grid-cols-3 gap-3">
                <div className="flex flex-col gap-1 rounded-md border border-border bg-elevated px-3 py-2">
                  <span className="flex items-center gap-1.5 text-xs text-text-muted">
                    <BarChart3 size={13} aria-hidden />
                    {t.stats.cardTotalTokens}
                  </span>
                  <span className="font-mono text-sm tabular-nums text-text">
                    {summary.totalTokensLabel}
                  </span>
                </div>
                <div className="flex flex-col gap-1 rounded-md border border-border bg-elevated px-3 py-2">
                  <span className="flex items-center gap-1.5 text-xs text-text-muted">
                    <Database size={13} aria-hidden />
                    {t.stats.cardCache}
                  </span>
                  <span className="font-mono text-sm tabular-nums text-text">
                    {summary.totalCacheLabel}
                  </span>
                </div>
                <div className="flex flex-col gap-1 rounded-md border border-border bg-elevated px-3 py-2">
                  <span className="flex items-center gap-1.5 text-xs text-text-muted">
                    <Boxes size={13} aria-hidden />
                    {t.stats.cardModelsUsed}
                  </span>
                  <span className="font-mono text-sm tabular-nums text-text">
                    {summary.modelsUsed}
                  </span>
                </div>
              </div>
            )}

            {/* Per-model rows */}
            {usageQuery.isLoading ? (
              <LoadingState variant="list" />
            ) : usageQuery.isError ? (
              <ErrorState message={t.common.daemonUnreachable} onRetry={() => usageQuery.refetch()} />
            ) : !summary.hasAnyUsage ? (
              <EmptyState title={t.stats.emptyTitle} description={t.stats.emptyDesc} icon={BarChart3} />
            ) : (
              <div className="flex flex-col gap-px overflow-hidden rounded-md border border-border bg-border/50">
                {summary.rows.map((row) => (
                  <div
                    key={row.exec}
                    className="flex items-center gap-2 bg-surface px-3 py-2"
                  >
                    <ModelIcon name={row.exec} size={15} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-text" title={row.exec}>
                      {row.exec}
                    </span>
                    <div className="hidden h-px w-16 flex-1 sm:block">
                      <div
                        className="h-px rounded-full"
                        style={{
                          width: `${row.pct}%`,
                          background: 'linear-gradient(90deg, var(--color-accent), #ff955f, #ffd09a)',
                          boxShadow: '0 0 6px rgba(255,82,54,0.3)',
                        }}
                      />
                    </div>
                    <span className="font-mono text-xs tabular-nums text-text-muted">
                      {row.tokensLabel}
                    </span>
                    <span className="w-20 text-right font-mono text-xs tabular-nums text-text">
                      {row.costLabel}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <p className="text-xs text-text-muted">{t.stats.arrowHint}</p>
          </div>
        )}
      </ModalBody>
    </Modal>
  );
}
