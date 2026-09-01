'use client';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { Brain, Pencil, Trash2, RotateCcw, Check, Hash, Gauge, Clock, Activity, Zap, ShieldCheck } from 'lucide-react';
import type { Memory } from '../../lib/types';
import { useMemory, useMemoryCategories } from '../../lib/queries';
import { useUpdateMemory, useSetMemoryCategory, useDeleteMemory, useRestoreMemory } from '../../lib/mutations';
import { apiErrorMessage } from '../../lib/elowenClient';
import { useToast } from '../../components/ui/Toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { IconButton } from '../../components/ui/IconButton';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState, LoadingLine, LoadingState } from '../../components/ui/states';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { useTranslation } from '../../lib/i18n';
import { formatTaskTime } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { memoryStatusTone, memoryStatusLabel, categorySwatch, vitalityPct } from './memoryMeta';
import { MemoryAuditFeed } from './MemoryAuditFeed';
/** Loaded on demand: the chart pulls in the charting library, and this detail is one drawer on a page
 *  that otherwise has no chart at all — a static import would put ~376 kB of it into the first load of
 *  the whole memory list.
 *
 *  `ssr: false` because the chart measures its own box, which is zero on the server and would make
 *  hydration disagree. The placeholder reserves the plot's real height so the audit feed underneath
 *  does not jump when the chunk lands. */
const MemoryVitalityChart = dynamic(
  () => import('./MemoryVitalityChart').then((m) => m.MemoryVitalityChart),
  { ssr: false, loading: () => <LoadingState variant="block" height="h-[168px]" /> },
);
import { CategoryIcon } from '../../lib/categoryIcons';
import { RankSlider, CategorySelect } from './MemoryFields';

/** Persistent memory detail: full editable body, metadata, lifecycle actions and audit trail. Resolves
 *  the memory by id (any status) so a soft-deleted row stays reachable for restore. */
export function MemoryDetail({ memoryId, onSaveState }: { memoryId: number; onSaveState?: (status: SaveStatus, retry: () => void) => void }) {
  const { t, locale } = useTranslation();
  const query = useMemory(memoryId);
  const memory = query.data;

  if (query.isError) return <EmptyState title={t.common.daemonUnreachable} icon={Brain} />;
  if (!memory) return <LoadingLine />;
  return <MemoryDetailBody key={memory.id} memory={memory} t={t} locale={locale} onSaveState={onSaveState} />;
}

function MemoryDetailBody({ memory, t, locale, onSaveState }: { memory: Memory; t: ReturnType<typeof useTranslation>['t']; locale: string; onSaveState?: (status: SaveStatus, retry: () => void) => void }) {
  const { toast } = useToast();
  const update = useUpdateMemory();
  const setCategory = useSetMemoryCategory();
  const del = useDeleteMemory();
  const restore = useRestoreMemory();
  const categories = useMemoryCategories();

  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(memory.body);
  const [kind, setKind] = useState(memory.kind);
  const [importance, setImportance] = useState(memory.importance);
  const [categoryId, setCategoryId] = useState<number | null>(memory.category_id);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Re-sync the draft whenever the underlying memory changes (a save/reselect), unless mid-edit.
  useEffect(() => {
    if (editing) return;
    setBody(memory.body); setKind(memory.kind); setImportance(memory.importance);
    setCategoryId(memory.category_id);
  }, [memory, editing]);

  const category = memory.category_id != null ? (categories.data ?? []).find((c) => c.id === memory.category_id) : undefined;
  const isDeleted = memory.status === 'deleted';
  const now = useNow();
  const created = formatTaskTime(memory.created_at, now, locale);
  const updated = formatTaskTime(memory.updated_at, now, locale);

  // Auto-save the edits — no Save button. Two writes: the body/kind/importance PATCH (only when one
  // changed) and, when it changed, the category via the dedicated PUT (the PATCH schema ignores it). An
  // empty body is never persisted (it's required), so the last-valid content is kept. The hook is always
  // mounted (the component is keyed by memory.id, so it seeds fresh per memory); merely entering edit
  // mode changes no field, so it never triggers a spurious save.
  const saveEdits = async () => {
    const next = body.trim();
    if (!next) return;
    if (next !== memory.body || kind.trim() !== memory.kind || importance !== memory.importance) {
      await update.mutateAsync({ id: memory.id, patch: { body: next, kind: kind.trim(), importance } });
    }
    if (categoryId !== memory.category_id) await setCategory.mutateAsync({ id: memory.id, categoryId });
  };
  const autosave = useAutoSaveStatus([body, kind, importance, categoryId], saveEdits, { ready: true, savable: !!body.trim() });
  useEffect(() => { onSaveState?.(autosave.status, autosave.retry); }, [autosave.retry, autosave.status, onSaveState]);
  // Leave edit mode — flush any pending save first so the last keystroke is never dropped.
  const done = async () => { const finalStatus = await autosave.flush(); if (finalStatus !== 'error') setEditing(false); };
  const doDelete = () => {
    del.mutate(memory.id, {
      onSuccess: () => toast(t.memory.deleted),
      onError: (e) => toast(apiErrorMessage(e), 'error'),
    });
    setConfirmDelete(false);
  };
  const doRestore = () => restore.mutate(memory.id, {
    onSuccess: () => toast(t.memory.restored),
    onError: (e) => toast(apiErrorMessage(e), 'error'),
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Identity strip — what this row IS and what can be done to it, on one line. The memory's own text
          is the headline below, so nothing decorative competes with it above the fold. */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="font-mono text-[11px] text-muted-foreground">#{memory.id}</span>
          <Badge tone={memoryStatusTone(memory.status)}>{memoryStatusLabel(t, memory.status)}</Badge>
          {!isDeleted && memory.importance === 5 ? (
            <Badge tone="accent"><ShieldCheck size={10} className="mr-0.5" aria-hidden />{t.memory.neverDeleted}</Badge>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {editing ? (
            <>
              {/* Changes auto-save; the status shows saving/saved/error, and Done just leaves edit mode. */}
              <AutoSaveStatus status={autosave.status} onRetry={autosave.retry} />
              <Button variant="ghost" icon={Check} onClick={done} disabled={autosave.status === 'saving' || autosave.status === 'error'}>{t.memory.done}</Button>
            </>
          ) : (
            <>
              {!isDeleted ? <IconButton icon={Pencil} label={t.memory.edit} onClick={() => setEditing(true)} /> : null}
              {isDeleted
                ? <IconButton icon={RotateCcw} label={t.memory.restore} onClick={doRestore} />
                : <IconButton icon={Trash2} label={t.memory.delete} variant="danger" onClick={() => setConfirmDelete(true)} />}
            </>
          )}
        </div>
      </div>

      {/* The memory itself. Reading it needs no caption, so the label appears only in edit mode, where the
          textarea genuinely is a form field. */}
      {editing ? (
        <Section label={t.memory.fieldBody}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            placeholder={t.memory.fieldBodyPlaceholder}
            className="w-full resize-y rounded-md border border-border bg-card px-3 py-2 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
        </Section>
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground" data-testid="memory-body">{memory.body}</p>
      )}

      {editing ? (
        <>
          <Section label={t.memory.fieldKind}>
            <Input value={kind} onChange={(e) => setKind(e.target.value)} placeholder={t.memory.fieldKindPlaceholder} />
          </Section>
          {(categories.data?.length ?? 0) > 0 ? (
            <Section label={t.memory.categoryFilter}>
              <CategorySelect
                categories={categories.data ?? []}
                value={categoryId}
                onChange={setCategoryId}
                ariaLabel={t.memory.categoryFilter}
                noneLabel={t.memory.categoryChipNone}
              />
            </Section>
          ) : null}
          <RankSlider label={t.memory.fieldImportance} icon={Gauge} value={importance} onChange={setImportance} />
        </>
      ) : (
        <>
          {/* Classification and origin, below the text it describes. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {category ? (
              <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground">
                <span className="shrink-0" style={{ color: categorySwatch(category.color) }}>
                  <CategoryIcon name={category.icon} size={12} />
                </span>
                {category.name}
              </span>
            ) : null}
            {memory.kind ? <Badge><Hash size={10} className="mr-0.5" aria-hidden />{memory.kind}</Badge> : null}
            {memory.source ? <Badge tone="muted">{memory.source}</Badge> : null}
            {created.label ? (
              <span className="font-mono text-[11px] text-muted-foreground" title={created.title}>{t.memory.createdAt} {created.label}</span>
            ) : null}
          </div>
          <div className="grid grid-cols-2 divide-x divide-border/70 border-y border-border/70 @sm:grid-cols-4">
            <Metric icon={Gauge} label={t.memory.fieldImportance} value={`${memory.importance} / 5`} />
            <Metric icon={Zap} label={t.memory.fieldVitality} value={String(vitalityPct(memory.vitality))} title={`${t.memory.fieldVitality}: ${vitalityPct(memory.vitality)}/100`} />
            <Metric icon={Activity} label={t.memory.usage} value={memory.use_count > 0 ? t.memory.useCount.replace('{n}', String(memory.use_count)) : t.memory.neverUsed} />
            <Metric icon={Clock} label={t.memory.updatedAt} value={updated.label || '—'} title={updated.title} />
          </div>
          {/* Elaborates on the Vitality metric right above it: where that number came from and where it
              is heading. Hidden while editing, like the rest of this block. */}
          <MemoryVitalityChart memoryId={memory.id} vitality={memory.vitality} />
        </>
      )}

      {!editing ? <MemoryAuditFeed memoryId={memory.id} /> : null}

      <ConfirmDialog
        open={confirmDelete}
        title={t.memory.deleteConfirmTitle}
        description={t.memory.deleteConfirmBody}
        confirmLabel={t.memory.delete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={doDelete}
      />
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Metric({ icon: Icon, label, value, title }: { icon: typeof Gauge; label: string; value: string; title?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-2 py-3" title={title}>
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground"><Icon size={11} aria-hidden />{label}</span>
      <span className="truncate font-mono text-xs text-foreground">{value}</span>
    </div>
  );
}
