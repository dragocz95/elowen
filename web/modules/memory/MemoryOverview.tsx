'use client';
import { useState } from 'react';
import { Brain, CheckCircle2, History, RefreshCw } from 'lucide-react';
import type { Memory } from '../../lib/types';
import { useMemoryEvents, useEmbeddingSettings } from '../../lib/queries';
import { useReindexMemories } from '../../lib/mutations';
import { StatCard } from '../../components/ui/StatCard';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { apiErrorMessage } from '../../lib/orcaClient';
import { useTranslation } from '../../lib/i18n';
import { TONE_TEXT } from '../../components/ui/tone';
import { buildBreakdown, memoryStatusLabel, memoryStatusTone } from './memoryMeta';

const BAR_TONE: Record<string, string> = {
  default: 'bg-text-muted/40', accent: 'bg-accent', muted: 'bg-text-muted/40',
  danger: 'bg-danger', success: 'bg-success', warning: 'bg-warning',
};

/** A light overview strip: headline counts + per-kind and per-status CSS-bar breakdowns (no chart lib).
 *  The cluster-scatter (t-SNE) is a deliberate v2 follow-up — bars are enough to read the shape for now. */
export function MemoryOverview({ memories }: { memories: Memory[] }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const events = useMemoryEvents(null);
  const embedding = useEmbeddingSettings();
  const reindex = useReindexMemories();
  const [confirmReindex, setConfirmReindex] = useState(false);

  const active = memories.filter((m) => m.status === 'active').length;
  const recentAudit = events.data?.length ?? 0;
  const configured = embedding.data?.configured ?? false;

  const doReindex = () => {
    setConfirmReindex(false);
    reindex.mutate(undefined, {
      onSuccess: (r) => toast(t.memory.reindexDone.replace('{n}', String(r.embedded))),
      onError: (e) => toast(apiErrorMessage(e), 'error'),
    });
  };

  const byKind = buildBreakdown(memories, (m) => m.kind || t.memory.allKinds, (k) => k, () => 'accent');
  const byStatus = buildBreakdown(
    memories,
    (m) => m.status,
    (k) => memoryStatusLabel(t, k as Memory['status']),
    (k) => memoryStatusTone(k as Memory['status']),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 @sm:grid-cols-3">
        <StatCard value={memories.length} label={t.page.memory} icon={Brain} />
        <StatCard value={active} label={t.memory.statusActive} icon={CheckCircle2} />
        <StatCard value={recentAudit} label={t.memory.auditHeading} icon={History} />
      </div>

      {/* Re-embed the caller's own memories (self-service — no admin config needed). Disabled until an
          embedding provider is configured in Settings → Embedding. */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="default"
          icon={RefreshCw}
          disabled={!configured || reindex.isPending}
          onClick={() => setConfirmReindex(true)}
        >
          {t.memory.reindex}
        </Button>
        {!configured ? <span className="text-xs italic text-text-muted">{t.memory.reindexUnconfigured}</span> : null}
      </div>

      <ConfirmDialog
        open={confirmReindex}
        title={t.memory.reindexConfirmTitle}
        description={t.memory.reindexConfirmBody}
        confirmLabel={t.memory.reindexConfirm}
        onClose={() => setConfirmReindex(false)}
        onConfirm={doReindex}
      />

      {memories.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
          <Breakdown title={t.memory.filterKind} rows={byKind} />
          <Breakdown title={t.memory.filterStatus} rows={byStatus} />
        </div>
      ) : null}
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: ReturnType<typeof buildBreakdown> }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4" style={{ boxShadow: 'var(--shadow-card)' }}>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{title}</span>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-col gap-1">
            <span className="flex items-center justify-between text-xs">
              <span className={`truncate ${TONE_TEXT[r.tone]}`}>{r.label}</span>
              <span className="font-mono text-text-muted">{r.count}</span>
            </span>
            <span className="h-1.5 w-full overflow-hidden rounded-full bg-elevated">
              <span className={`block h-full rounded-full ${BAR_TONE[r.tone] ?? BAR_TONE.default}`} style={{ width: `${r.pct}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
