'use client';
import { ArrowDownToLine, ArrowUpFromLine, DatabaseZap, Coins, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { formatTokens, formatCost } from '../../lib/format';
import type { TokenUsage } from '../../lib/types';

/** Token usage displayed as pills: IN / CACHE / OUT with formatted counts.
 *  Hover shows the full breakdown including decimal prices. */
export function UsageBadge({ usage }: { usage: TokenUsage }) {
  const { t } = useTranslation();
  if (!usage || usage.total === 0) return null;

  const cache = usage.cacheRead + usage.cacheWrite;
  const hasCache = cache > 0;
  const hasCost = usage.costUsd != null && usage.costUsd > 0;
  // Only a provider-reported figure is billed truth. A price-sheet estimate is prefixed "~" and muted,
  // and the tooltip spells out the provenance — we never present an estimate as a confirmed cost.
  const estimated = hasCost && usage.costSource === 'calculated';
  const costLabel = hasCost ? (estimated ? `~${formatCost(usage.costUsd!)}` : formatCost(usage.costUsd!)) : '';
  const costProvenance = usage.costSource === 'provider_reported' ? t.usage.costReported
    : usage.costSource === 'calculated' ? t.usage.costEstimated : t.usage.cost;

  const tip = [
    `${t.usage.inputTokens}: ${usage.input.toLocaleString()}`,
    hasCache ? `${t.usage.cache}: ${cache.toLocaleString()}` : null,
    `${t.usage.outputTokens}: ${usage.output.toLocaleString()}`,
    usage.reasoning ? `${t.usage.reasoning}: ${usage.reasoning.toLocaleString()}` : null,
    hasCost ? `${costProvenance}: ${formatCost(usage.costUsd!)}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <span className="inline-flex items-center gap-1 font-mono text-[11px]" title={tip}>
      <Pill icon={ArrowDownToLine} label={t.usage.input} display={formatTokens(usage.input)} className="border-info/30 text-info" />
      {hasCache ? <Pill icon={DatabaseZap} label={t.usage.cache} display={formatTokens(cache)} className="border-warning/30 text-warning" /> : null}
      <Pill icon={ArrowUpFromLine} label={t.usage.output} display={formatTokens(usage.output)} className="border-danger/30 text-danger" />
      {hasCost ? <Pill icon={Coins} label={t.usage.cost} display={costLabel} className={estimated ? 'border-border text-text-muted' : 'border-approve/30 text-approve'} /> : null}
    </span>
  );
}

function Pill({ icon: Icon, label, display, className }: { icon: LucideIcon; label: string; display: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 ${className ?? ''}`}>
      <Icon size={10} className="shrink-0" aria-hidden />
      <span className="uppercase tracking-wide">{label}</span>
      <span>{display}</span>
    </span>
  );
}
