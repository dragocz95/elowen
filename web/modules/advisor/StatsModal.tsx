'use client';

import { useState, useEffect, useCallback } from 'react';
import { BarChart3, ChevronLeft, ChevronRight, Database, DollarSign, Boxes, ArrowDownToLine, ArrowUpFromLine, Zap, Gauge } from 'lucide-react';
import { useBrainChat } from './BrainChatProvider';
import { useBrainContextUsage, useModelUsage } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { formatTokens, formatCost, formatSpeed } from '../../lib/format';
import { buildUsageSummary, cacheHitPct } from '../../lib/usageBars';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { Modal, ModalBody } from '../../components/ui/Modal';
import { brainModelQualifiedLabel } from '../../lib/modelProvider';

const SECTIONS = ['conversation', 'models', 'context'] as const;
type Section = (typeof SECTIONS)[number];

export function StatsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { usage, currentModel, provider, activeSessionId } = useBrainChat();
  const usageQuery = useModelUsage();
  const summary = buildUsageSummary(usageQuery.data);

  const [section, setSection] = useState<Section>('conversation');
  // Only while the Context section is on screen: the breakdown walks the live transcript server-side.
  const contextQuery = useBrainContextUsage(activeSessionId, section === 'context');
  const breakdown = contextQuery.data ?? null;

  const cycle = useCallback((dir: -1 | 1) => {
    setSection((cur) => SECTIONS[(SECTIONS.indexOf(cur) + dir + SECTIONS.length) % SECTIONS.length] ?? cur);
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
  const convCacheHit = u && u.cacheRead != null && u.input != null ? cacheHitPct({ cacheRead: u.cacheRead, input: u.input }) : null;

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
            {section === 'conversation' ? t.stats.sectionConversation : section === 'models' ? t.stats.sectionModels : t.stats.sectionContext}
            <span className="text-xs text-text-muted">
              {`${SECTIONS.indexOf(section) + 1}/${SECTIONS.length}`}
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
              <span className="text-sm font-mono text-text">{currentModel ? brainModelQualifiedLabel({ provider, model: currentModel }) : '—'}</span>
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
              <div className="flex flex-col gap-1 rounded-md border border-border bg-elevated px-3 py-2">
                <span className="flex items-center gap-1.5 text-xs text-text-muted">
                  <ArrowDownToLine size={13} aria-hidden />
                  {t.stats.inputTokens}
                </span>
                <span className="font-mono text-sm tabular-nums text-text">
                  {u?.input != null ? formatTokens(u.input) : '—'}
                </span>
              </div>
              <div className="flex flex-col gap-1 rounded-md border border-border bg-elevated px-3 py-2">
                <span className="flex items-center gap-1.5 text-xs text-text-muted">
                  <ArrowUpFromLine size={13} aria-hidden />
                  {t.stats.outputTokens}
                </span>
                <span className="font-mono text-sm tabular-nums text-text">
                  {u?.output != null ? formatTokens(u.output) : '—'}
                </span>
              </div>
              <div className="flex flex-col gap-1 rounded-md border border-border bg-elevated px-3 py-2">
                <span className="flex items-center gap-1.5 text-xs text-text-muted">
                  <Zap size={13} aria-hidden />
                  {t.stats.cacheHit}
                </span>
                <span className="font-mono text-sm tabular-nums text-text">
                  {convCacheHit != null ? `${Math.round(convCacheHit)} %` : '—'}
                </span>
              </div>
              <div className="flex flex-col gap-1 rounded-md border border-border bg-elevated px-3 py-2">
                <span className="flex items-center gap-1.5 text-xs text-text-muted">
                  <Gauge size={13} aria-hidden />
                  {t.stats.speed}
                </span>
                <span className="font-mono text-sm tabular-nums text-text">
                  {u ? formatSpeed(u.outputTps) : '—'}
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
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
                <div className="flex flex-col gap-1 rounded-md border border-border bg-elevated px-3 py-2">
                  <span className="flex items-center gap-1.5 text-xs text-text-muted">
                    <Gauge size={13} aria-hidden />
                    {t.stats.avgSpeed}
                  </span>
                  <span className="font-mono text-sm tabular-nums text-text">
                    {summary.avgSpeedLabel}
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
                    title={row.cacheHitPct != null ? `${t.stats.cacheHit}: ${Math.round(row.cacheHitPct)} %` : undefined}
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
                    <span className="w-16 text-right font-mono text-xs tabular-nums text-text-muted">
                      {row.speedLabel}
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

        {section === 'context' && (
          <div className="flex flex-col gap-4">
            {contextQuery.isLoading ? (
              <LoadingState variant="list" />
            ) : contextQuery.isError ? (
              <ErrorState message={t.common.daemonUnreachable} onRetry={() => contextQuery.refetch()} />
            ) : !breakdown ? (
              <EmptyState title={t.stats.contextEmptyTitle} description={t.stats.contextEmptyDesc} icon={BarChart3} />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1 rounded-md border border-border bg-elevated px-3 py-2">
                    <span className="text-xs text-text-muted">{t.stats.contextWindow}</span>
                    <span className="font-mono text-sm tabular-nums text-text">{formatTokens(breakdown.contextWindow)}</span>
                  </div>
                  <div className="flex flex-col gap-1 rounded-md border border-border bg-elevated px-3 py-2">
                    <span className="text-xs text-text-muted">{t.stats.contextReported}</span>
                    <span className="font-mono text-sm tabular-nums text-text">
                      {breakdown.reportedTokens != null ? formatTokens(breakdown.reportedTokens) : '—'}
                    </span>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-xs font-medium text-text-muted">{t.stats.contextBreakdown}</h3>
                    {breakdown.compactAtTokens != null ? (
                      <span className="font-mono text-xs tabular-nums text-text-muted">
                        {t.stats.compactsAt}: {formatTokens(breakdown.compactAtTokens)}
                      </span>
                    ) : null}
                  </div>
                  {breakdown.categories.map((category) => (
                    <ContextBar
                      key={category.id}
                      label={t.stats.contextCategory[category.id]}
                      tokens={category.tokens}
                      percent={category.percent}
                    />
                  ))}
                  <ContextBar label={t.stats.contextCategoryFree} tokens={breakdown.free.tokens} percent={breakdown.free.percent} muted />
                  <p className="text-xs text-text-muted">{t.stats.contextEstimateNote}</p>
                </div>

                {breakdown.tools.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <h3 className="text-xs font-medium text-text-muted">{t.stats.heaviestTools}</h3>
                    <div className="flex flex-col gap-px overflow-hidden rounded-md border border-border bg-border/50">
                      {breakdown.tools.map((tool) => (
                        <div key={tool.name} className="flex items-center gap-2 bg-surface px-3 py-2">
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-text" title={tool.name}>{tool.name}</span>
                          <span className="hidden font-mono text-xs tabular-nums text-text-muted sm:inline">
                            {`${formatTokens(tool.schemaTokens)} · ${formatTokens(tool.callTokens)} · ${formatTokens(tool.resultTokens)}`}
                          </span>
                          <span className="w-16 text-right font-mono text-xs tabular-nums text-text">{formatTokens(tool.tokens)}</span>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-text-muted">{t.stats.toolColumnsHint}</p>
                  </div>
                ) : null}
              </>
            )}

            <p className="text-xs text-text-muted">{t.stats.arrowHint}</p>
          </div>
        )}
      </ModalBody>
    </Modal>
  );
}

/** One category of the context breakdown: label, share bar, tokens. Same bar language as the conversation
 *  section's context meter, just slimmer — several of them stack. */
function ContextBar({ label, tokens, percent, muted }: { label: string; tokens: number; percent: number; muted?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 truncate text-xs text-text-muted" title={label}>{label}</span>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full border border-border bg-elevated">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%`, background: muted ? 'var(--color-border)' : 'var(--color-accent)' }}
        />
      </div>
      <span className="w-14 text-right font-mono text-xs tabular-nums text-text">{formatTokens(tokens)}</span>
      <span className="w-10 text-right font-mono text-xs tabular-nums text-text-muted">{`${Math.round(percent)} %`}</span>
    </div>
  );
}
