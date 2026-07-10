import { formatTokens, formatCost } from '../../lib/format';
import type { ModelUsage } from '../../lib/types';

/** One model's row on the stats page: figures plus a max-normalized bar width (by tokens). */
interface UsageRow {
  exec: string;
  totalTokens: number;
  costUsd: number | null;
  pct: number;          // 0..100, largest row = 100
  tokensLabel: string;
  costLabel: string;    // '—' when the executor records no cost (claude/codex)
}

export interface UsageSummary {
  rows: UsageRow[];
  totalCost: number | null;   // null when no executor reports cost
  totalCostLabel: string;     // '—' or formatCost
  totalTokens: number;
  totalTokensLabel: string;
  totalCacheTokens: number;   // cacheRead + cacheWrite across all models
  totalCacheLabel: string;
  modelsUsed: number;
  hasAnyUsage: boolean;
}

const DASH = '—';

/** Shape the raw `/usage/by-model` array into sorted, pre-formatted display rows + totals.
 *  Pure and unit-tested; the view stays declarative. Bar widths are max-normalized by tokens
 *  (the metric every executor reports), so cost-less models still get a meaningful bar. */
export function buildUsageSummary(data: ModelUsage[] | undefined): UsageSummary {
  const items = data ?? [];
  const maxTokens = Math.max(1, ...items.map((m) => m.usage.total));
  const rows: UsageRow[] = items
    .map((m) => ({
      exec: m.exec,
      totalTokens: m.usage.total,
      costUsd: m.usage.costUsd,
      pct: (m.usage.total / maxTokens) * 100,
      tokensLabel: formatTokens(m.usage.total),
      costLabel: m.usage.costUsd == null ? DASH : formatCost(m.usage.costUsd),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const totalTokens = items.reduce((sum, m) => sum + m.usage.total, 0);
  const totalCacheTokens = items.reduce((sum, m) => sum + m.usage.cacheRead + m.usage.cacheWrite, 0);
  const costs = items.map((m) => m.usage.costUsd).filter((c): c is number => c != null);
  const totalCost = costs.length ? costs.reduce((sum, c) => sum + c, 0) : null;

  return {
    rows,
    totalCost,
    totalCostLabel: totalCost == null ? DASH : formatCost(totalCost),
    totalTokens,
    totalTokensLabel: formatTokens(totalTokens),
    totalCacheTokens,
    totalCacheLabel: formatTokens(totalCacheTokens),
    modelsUsed: rows.length,
    // A provider may report a settled cost without token detail. Keep that row visible instead of
    // incorrectly replacing the ledger with the empty state.
    hasAnyUsage: totalTokens > 0 || costs.some((cost) => cost > 0),
  };
}
