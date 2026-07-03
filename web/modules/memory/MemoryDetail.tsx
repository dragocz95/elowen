'use client';
import { useEffect, useState } from 'react';
import { Brain, Pencil, Trash2, RotateCcw, Check, X, Hash, Gauge, ShieldCheck, Clock, Activity } from 'lucide-react';
import type { Memory } from '../../lib/types';
import { useMemory, useMemoryCategories } from '../../lib/queries';
import { useUpdateMemory, useDeleteMemory, useRestoreMemory } from '../../lib/mutations';
import { apiErrorMessage } from '../../lib/orcaClient';
import { useToast } from '../../components/ui/Toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Slider } from '../../components/ui/Slider';
import { IconButton } from '../../components/ui/IconButton';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { formatTaskTime } from '../../lib/format';
import { memoryStatusTone, memoryStatusLabel, pct01, categorySwatch } from './memoryMeta';
import { MemoryAuditFeed } from './MemoryAuditFeed';

/** Persistent memory detail: full editable body, metadata, lifecycle actions and audit trail. Resolves
 *  the memory by id (any status) so a soft-deleted row stays reachable for restore. */
export function MemoryDetail({ memoryId }: { memoryId: number }) {
  const { t, locale } = useTranslation();
  const query = useMemory(memoryId);
  const memory = query.data;

  if (query.isError) return <EmptyState title={t.common.daemonUnreachable} icon={Brain} />;
  if (!memory) return <EmptyState title={t.memory.loading} icon={Brain} />;
  return <MemoryDetailBody key={memory.id} memory={memory} t={t} locale={locale} />;
}

function MemoryDetailBody({ memory, t, locale }: { memory: Memory; t: ReturnType<typeof useTranslation>['t']; locale: string }) {
  const { toast } = useToast();
  const update = useUpdateMemory();
  const del = useDeleteMemory();
  const restore = useRestoreMemory();
  const categories = useMemoryCategories();

  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(memory.body);
  const [kind, setKind] = useState(memory.kind);
  const [importance, setImportance] = useState(memory.importance);
  const [confidence, setConfidence] = useState(memory.confidence);
  const [categoryId, setCategoryId] = useState<number | null>(memory.category_id);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Re-sync the draft whenever the underlying memory changes (a save/reselect), unless mid-edit.
  useEffect(() => {
    if (editing) return;
    setBody(memory.body); setKind(memory.kind); setImportance(memory.importance); setConfidence(memory.confidence);
    setCategoryId(memory.category_id);
  }, [memory, editing]);

  const category = memory.category_id != null ? (categories.data ?? []).find((c) => c.id === memory.category_id) : undefined;
  const isDeleted = memory.status === 'deleted';
  const created = formatTaskTime(memory.created_at, Date.now(), locale);
  const updated = formatTaskTime(memory.updated_at, Date.now(), locale);
  const lastUsed = memory.last_used_at ? formatTaskTime(memory.last_used_at, Date.now(), locale) : null;

  const cancel = () => {
    setBody(memory.body); setKind(memory.kind); setImportance(memory.importance); setConfidence(memory.confidence);
    setCategoryId(memory.category_id);
    setEditing(false);
  };
  const save = () => {
    const next = body.trim();
    if (!next) { toast(t.memory.bodyRequired, 'error'); return; }
    update.mutate(
      { id: memory.id, patch: { body: next, kind: kind.trim(), importance, confidence, categoryId } },
      { onSuccess: () => { toast(t.memory.saved); setEditing(false); }, onError: (e) => toast(apiErrorMessage(e), 'error') },
    );
  };
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
      {/* Header — identity, status, actions */}
      <div className="-mx-4 flex flex-col gap-2 border-b border-border bg-surface px-4 pb-3 pt-1">
        <div className="flex items-start gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-elevated">
            <Brain size={22} className="text-text-muted" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={memoryStatusTone(memory.status)}>{memoryStatusLabel(t, memory.status)}</Badge>
              {category ? (
                <span className="inline-flex items-center gap-1 rounded-md border border-border bg-elevated px-2 py-0.5 text-[11px] font-medium text-text">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: categorySwatch(category.color) }} aria-hidden />
                  {category.name}
                </span>
              ) : null}
              {memory.kind ? <Badge><Hash size={10} className="mr-0.5" aria-hidden />{memory.kind}</Badge> : null}
              {memory.source ? <Badge tone="muted">{memory.source}</Badge> : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-text-muted">
              <span>#{memory.id}</span>
              {created.label ? <><span aria-hidden className="opacity-50">·</span><span title={created.title}>{t.memory.createdAt} {created.label}</span></> : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {editing ? (
            <>
              <Button variant="accent" icon={Check} onClick={save} disabled={update.isPending}>{t.memory.save}</Button>
              <Button variant="ghost" icon={X} onClick={cancel}>{t.memory.cancel}</Button>
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

      {/* Body — editable */}
      <Section label={t.memory.fieldBody}>
        {editing ? (
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            placeholder={t.memory.fieldBodyPlaceholder}
            className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        ) : (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-text">{memory.body}</p>
        )}
      </Section>

      {editing ? (
        <>
          <Section label={t.memory.fieldKind}>
            <Input value={kind} onChange={(e) => setKind(e.target.value)} placeholder={t.memory.fieldKindPlaceholder} />
          </Section>
          {(categories.data?.length ?? 0) > 0 ? (
            <Section label={t.memory.categoryFilter}>
              <select
                value={categoryId == null ? '' : String(categoryId)}
                onChange={(e) => setCategoryId(e.target.value === '' ? null : Number(e.target.value))}
                aria-label={t.memory.categoryFilter}
                className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-text focus:border-accent focus:outline-none"
              >
                <option value="">{t.memory.categoryChipNone}</option>
                {(categories.data ?? []).map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              </select>
            </Section>
          ) : null}
          <div className="grid grid-cols-1 gap-4 @sm:grid-cols-2">
            <RankSlider label={t.memory.fieldImportance} icon={Gauge} value={importance} onChange={setImportance} />
            <WeightSlider label={t.memory.fieldConfidence} icon={ShieldCheck} value={confidence} onChange={setConfidence} />
          </div>
        </>
      ) : (
        <div className="grid grid-cols-2 gap-3 @sm:grid-cols-4">
          <Metric icon={Gauge} label={t.memory.fieldImportance} value={`${memory.importance} / 5`} />
          <Metric icon={ShieldCheck} label={t.memory.fieldConfidence} value={`${pct01(memory.confidence)} %`} />
          <Metric icon={Activity} label={t.memory.usage} value={memory.use_count > 0 ? t.memory.useCount.replace('{n}', String(memory.use_count)) : t.memory.neverUsed} />
          <Metric icon={Clock} label={t.memory.updatedAt} value={updated.label || '—'} title={updated.title} />
        </div>
      )}

      {lastUsed && !editing ? (
        <p className="font-mono text-[11px] text-text-muted" title={lastUsed.title}>{t.memory.lastUsed}: {lastUsed.label}</p>
      ) : null}

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
      <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{label}</span>
      {children}
    </div>
  );
}

function Metric({ icon: Icon, label, value, title }: { icon: typeof Gauge; label: string; value: string; title?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-surface p-2.5" title={title}>
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-text-muted"><Icon size={11} aria-hidden />{label}</span>
      <span className="truncate font-mono text-xs text-text">{value}</span>
    </div>
  );
}

/** A 0..1 weight edited as a 0..100 slider with a live percent readout. */
function WeightSlider({ label, icon: Icon, value, onChange }: { label: string; icon: typeof Gauge; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="inline-flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        <span className="inline-flex items-center gap-1"><Icon size={11} aria-hidden />{label}</span>
        <span className="font-mono text-text">{pct01(value)} %</span>
      </span>
      <Slider value={pct01(value)} min={0} max={100} step={1} onChange={(v) => onChange(v / 100)} />
    </div>
  );
}

/** A 1..5 integer rank (importance) edited as a stepped slider with an "n / 5" readout — NOT a 0..1
 *  weight, so it must never go through pct01 (the server validates importance as an int in 1..5). */
function RankSlider({ label, icon: Icon, value, onChange }: { label: string; icon: typeof Gauge; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="inline-flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        <span className="inline-flex items-center gap-1"><Icon size={11} aria-hidden />{label}</span>
        <span className="font-mono text-text">{value} / 5</span>
      </span>
      <Slider value={value} min={1} max={5} step={1} onChange={onChange} />
    </div>
  );
}
