'use client';
import { useTranslation } from '../../lib/i18n';
import { formatTokens } from '../../lib/formatTokens';
import type { TokenUsage } from '../../lib/types';

/** Token usage displayed as pills: IN / CACHE / OUT with formatted counts.
 *  Hover shows the full breakdown including decimal prices. */
export function UsageBadge({ usage }: { usage: TokenUsage }) {
  const { t } = useTranslation();
  if (!usage || usage.total === 0) return null;

  const cache = usage.cacheRead + usage.cacheWrite;
  const hasCache = cache > 0;

  const tip = [
    `${t.usage.inputTokens}: ${usage.input.toLocaleString()}`,
    hasCache ? `${t.usage.cache}: ${cache.toLocaleString()}` : null,
    `${t.usage.outputTokens}: ${usage.output.toLocaleString()}`,
    usage.costUsd != null && usage.costUsd > 0 ? `${t.usage.cost}: $${usage.costUsd.toFixed(4)}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <span className="inline-flex items-center gap-1 font-mono text-[11px]" title={tip}>
      <Pill label={t.usage.input} value={usage.input} className="border-text-muted/20 text-text-muted" />
      {hasCache ? <Pill label={t.usage.cache} value={cache} className="border-warning/30 text-warning" /> : null}
      <Pill label={t.usage.output} value={usage.output} className="border-approve/30 text-approve" />
    </span>
  );
}

function Pill({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 ${className ?? ''}`}>
      <span className="uppercase tracking-wide">{label}</span>
      <span>{formatTokens(value)}</span>
    </span>
  );
}
