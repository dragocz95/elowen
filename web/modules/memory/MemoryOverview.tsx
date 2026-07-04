'use client';
import { Brain, CheckCircle2, History, type LucideIcon } from 'lucide-react';
import type { Memory } from '../../lib/types';
import { useMemoryEvents } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';

/** Sticky sidebar overview: just the headline counts. The per-kind/status breakdowns were removed from
 *  here (that shape belongs in Statistics, not this list column) and reindex lives in Settings → Memory —
 *  so this column stays a quiet at-a-glance summary. */
export function MemoryOverview({ memories }: { memories: Memory[] }) {
  const { t } = useTranslation();
  const events = useMemoryEvents(null);

  const active = memories.filter((m) => m.status === 'active').length;
  const recentAudit = events.data?.length ?? 0;

  return (
    <div className="flex flex-col gap-2.5">
      {/* Compact stat rows — icon beside the value (not stacked above), sized to match the memory rows
          on the left. Lives in the sticky right column, so they flow top-to-bottom. */}
      <CompactStat value={memories.length} label={t.page.memory} icon={Brain} />
      <CompactStat value={active} label={t.memory.statusActive} icon={CheckCircle2} />
      <CompactStat value={recentAudit} label={t.memory.auditHeading} icon={History} />
    </div>
  );
}

/** A compact stat row for the sticky sidebar: icon beside the value + label, matching the memory-row
 *  density on the left (rounded-lg border, p-3) rather than the tall stacked StatCard. */
function CompactStat({ value, label, icon: Icon }: { value: number; label: string; icon: LucideIcon }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3" style={{ boxShadow: 'var(--shadow-card)' }}>
      <Icon size={17} className="shrink-0 text-text-muted" aria-hidden />
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-bold tabular-nums leading-none text-text">{value}</span>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</span>
      </div>
    </div>
  );
}
