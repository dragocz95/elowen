'use client';
import { useMemo, useState } from 'react';
import { Brain, Search, Plus, GitMerge, X, ListChecks, Sparkles, Hash, Gauge, Tags } from 'lucide-react';
import type { Memory, MemoryCategory } from '../../lib/types';
import { useMemories, useMemoryCategories } from '../../lib/queries';
import { useCreateMemory, useMergeMemories } from '../../lib/mutations';
import { apiErrorMessage } from '../../lib/orcaClient';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Segmented } from '../../components/ui/Segmented';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Field } from '../../components/ui/Field';
import { Checkbox } from '../../components/ui/Checkbox';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { usePersistentState } from '../../lib/usePersistentState';
import { MemoryDetail } from './MemoryDetail';
import { MemoryBrainMap } from './MemoryBrainMap';
import { MemoryOverview } from './MemoryOverview';
import { CategoryManager } from './CategoryManager';
import { RetrievalDebugPanel } from './RetrievalDebugPanel';
import { memoryStatusTone, memoryStatusLabel, distinctKinds, categoriesById, categorySwatch } from './memoryMeta';

type Tab = 'list' | 'brain' | 'retrieval';
type StatusFilter = 'active' | 'archived' | 'deleted' | 'all';
const TABS: readonly Tab[] = ['list', 'brain', 'retrieval'];
const STATUS_VALUES: readonly StatusFilter[] = ['active', 'archived', 'deleted', 'all'];

/** Memory module: a searchable master/detail list of the caller's private memories, a retrieval
 *  inspector, and (for admins) the workspace embedding settings. All data via React Query. */
export function MemoryView() {
  const { t } = useTranslation();

  const [tab, setTab] = usePersistentState<Tab>('orca.memory.tab', 'list', TABS);
  const [status, setStatus] = usePersistentState<StatusFilter>('orca.memory.status', 'active', STATUS_VALUES);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<string>('all');
  // Category filter — 'all' | 'none' (uncategorized) | a stringified category id. Client-side over the
  // loaded list, mirroring how `kind` narrows the same in-memory rows.
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [showCategories, setShowCategories] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);
  const [merging, setMerging] = useState(false);

  const memories = useMemories(status === 'all' ? undefined : { status });
  const categories = useMemoryCategories();
  const categoryById = useMemo(() => categoriesById(categories.data ?? []), [categories.data]);

  const kinds = useMemo(() => distinctKinds(memories.data ?? []), [memories.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (memories.data ?? [])
      .filter((m) => kind === 'all' || m.kind === kind)
      .filter((m) => categoryFilter === 'all'
        || (categoryFilter === 'none' ? m.category_id == null : m.category_id === Number(categoryFilter)))
      .filter((m) => !q || `${m.body} ${m.kind} ${m.source}`.toLowerCase().includes(q))
      .sort((a, b) => (b.updated_at > a.updated_at ? 1 : b.updated_at < a.updated_at ? -1 : 0));
  }, [memories.data, kind, categoryFilter, query]);

  const toggleSelect = (id: number) => setSelected((cur) => { const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSelection = () => setSelected(new Set());

  const TAB_OPTIONS = [
    { value: 'list', label: t.memory.viewList, icon: ListChecks },
    { value: 'brain', label: t.memory.viewBrain, icon: Brain },
    { value: 'retrieval', label: t.memory.viewRetrieval, icon: Sparkles },
  ];
  const STATUS_OPTIONS = STATUS_VALUES.map((s) => ({
    value: s,
    label: s === 'all' ? t.memory.statusAll : memoryStatusLabel(t, s),
  }));

  return (
    <>
      <ModuleHeader title={t.page.memory} count={tab === 'list' ? filtered.length : undefined} icon={Brain}>
        <Segmented value={tab} onChange={(v) => setTab(v as Tab)} options={TAB_OPTIONS} aria-label={t.page.memory} />
        {tab === 'list' ? (
          <>
            <div className="relative w-40 @sm:w-52">
              <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.memory.searchPlaceholder} className="pl-9" />
            </div>
            <Segmented value={status} onChange={(v) => setStatus(v as StatusFilter)} options={STATUS_OPTIONS} aria-label={t.memory.filterStatus} />
            {kinds.length > 0 ? (
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                aria-label={t.memory.filterKind}
                className="h-9 rounded-md border border-border bg-surface px-3 text-sm text-text focus:border-accent focus:outline-none"
              >
                <option value="all">{t.memory.allKinds}</option>
                {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            ) : null}
            {(categories.data?.length ?? 0) > 0 ? (
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                aria-label={t.memory.categoryFilter}
                className="h-9 rounded-md border border-border bg-surface px-3 text-sm text-text focus:border-accent focus:outline-none"
              >
                <option value="all">{t.memory.categoryAll}</option>
                <option value="none">{t.memory.categoryUncategorized}</option>
                {(categories.data ?? []).map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              </select>
            ) : null}
            <Button
              variant={showCategories ? 'accent' : 'default'}
              icon={Tags}
              aria-pressed={showCategories}
              onClick={() => setShowCategories((v) => !v)}
            >
              {t.memory.categoriesTitle}
            </Button>
          </>
        ) : null}
        <Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.memory.newMemory}</Button>
      </ModuleHeader>

      {tab === 'retrieval' ? <RetrievalDebugPanel />
        : tab === 'brain' ? (
          memories.isLoading ? <LoadingState variant="cards" />
          : memories.isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={() => memories.refetch()} />
          : <MemoryBrainMap memories={memories.data ?? []} categories={categories.data ?? []} onSelectMemory={(id) => { setSelectedId(id); setTab('list'); }} />
        )
        : memories.isLoading ? <LoadingState variant="cards" />
        : memories.isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={() => memories.refetch()} />
        : (
          <div className="flex flex-col gap-5">
            {showCategories ? <CategoryManager memories={memories.data ?? []} /> : null}
            <MemoryOverview memories={memories.data ?? []} />

            {(memories.data?.length ?? 0) === 0 ? (
              <EmptyState title={t.memory.empty} description={t.memory.emptyHint} icon={Brain} action={<Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.memory.newMemory}</Button>} />
            ) : filtered.length === 0 ? (
              <EmptyState title={t.memory.emptySearch} icon={Search} />
            ) : (
              <div className="@container">
                <div className="@3xl:flex @3xl:items-start @3xl:gap-5">
                  {/* Left — memory list */}
                  <div className="flex flex-col gap-2.5 @3xl:w-[42%] @3xl:shrink-0">
                    {filtered.map((m) => (
                      <MemoryRow
                        key={m.id}
                        memory={m}
                        category={m.category_id != null ? categoryById.get(m.category_id) : undefined}
                        active={selectedId === m.id}
                        selected={selected.has(m.id)}
                        onSelect={() => setSelectedId(m.id)}
                        onToggleSelect={() => toggleSelect(m.id)}
                      />
                    ))}
                  </div>

                  {/* Right — detail pane */}
                  <aside className="mt-5 min-w-0 @3xl:mt-0 @3xl:flex-1">
                    {selectedId != null ? (
                      <div className="rounded-lg border border-border bg-surface p-4" style={{ boxShadow: 'var(--shadow-card)' }}>
                        <MemoryDetail memoryId={selectedId} />
                      </div>
                    ) : (
                      <div className="hidden items-center justify-center gap-2 rounded-lg border border-dashed border-border py-20 text-sm text-text-muted @3xl:flex">
                        <Brain size={14} className="shrink-0 text-text-muted/50" aria-hidden />{t.memory.intro}
                      </div>
                    )}
                  </aside>
                </div>
              </div>
            )}
          </div>
        )}

      {/* Merge selection toolbar */}
      {selected.size > 0 ? (
        <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-elevated px-3 py-2 shadow-[var(--shadow-raised)] animate-fade-up">
          <span className="px-1 text-sm text-text">{t.memory.mergeSelected.replace('{n}', String(selected.size))}</span>
          <Button variant="accent" icon={GitMerge} disabled={selected.size < 2} onClick={() => setMerging(true)}>{t.memory.merge}</Button>
          <button type="button" aria-label={t.memory.cancel} onClick={clearSelection} className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-surface hover:text-text"><X size={15} /></button>
        </div>
      ) : null}

      {creating ? <CreateMemoryModal onClose={() => setCreating(false)} onCreated={(id) => { setSelectedId(id); setCreating(false); }} /> : null}
      {merging ? (
        <MergeMemoryModal
          sources={(memories.data ?? []).filter((m) => selected.has(m.id))}
          onClose={() => setMerging(false)}
          onMerged={(id) => { clearSelection(); setMerging(false); setSelectedId(id); }}
        />
      ) : null}
    </>
  );
}

/** One memory in the list: selection checkbox, body snippet, category chip + kind/importance/usage meta. */
function MemoryRow({ memory, category, active, selected, onSelect, onToggleSelect }: {
  memory: Memory; category?: MemoryCategory; active: boolean; selected: boolean; onSelect: () => void; onToggleSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border p-3 transition-colors ${active ? 'border-accent/50 bg-accent/5' : 'border-border bg-surface hover:border-border-strong'}`} style={{ boxShadow: active ? undefined : 'var(--shadow-card)' }}>
      <button type="button" onClick={onToggleSelect} aria-label={t.memory.merge} aria-pressed={selected} className="pt-0.5">
        <Checkbox checked={selected} />
      </button>
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left">
        <p className="line-clamp-2 text-sm leading-snug text-text">{memory.body}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {memory.status !== 'active' ? <Badge tone={memoryStatusTone(memory.status)}>{memoryStatusLabel(t, memory.status)}</Badge> : null}
          {category ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-elevated px-2 py-0.5 text-[11px] font-medium text-text">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: categorySwatch(category.color) }} aria-hidden />
              {category.name}
            </span>
          ) : null}
          {memory.kind ? <Badge><Hash size={10} className="mr-0.5" aria-hidden />{memory.kind}</Badge> : null}
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-text-muted"><Gauge size={11} aria-hidden />{memory.importance}/5</span>
          {memory.use_count > 0 ? <span className="font-mono text-[10px] text-text-muted">{t.memory.useCount.replace('{n}', String(memory.use_count))}</span> : null}
        </div>
      </button>
    </div>
  );
}

/** Create a new memory (source 'user'). Body required; kind optional. */
function CreateMemoryModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const create = useCreateMemory();
  const [body, setBody] = useState('');
  const [kind, setKind] = useState('');

  const submit = () => {
    const next = body.trim();
    if (!next) { toast(t.memory.bodyRequired, 'error'); return; }
    create.mutate(
      { body: next, kind: kind.trim() || undefined },
      { onSuccess: (m) => { toast(t.memory.created); onCreated(m.id); }, onError: (e) => toast(apiErrorMessage(e), 'error') },
    );
  };

  return (
    <Modal title={t.memory.newMemory} onClose={onClose} size="md" icon={Brain}>
      <ModalBody>
        <Field label={t.memory.fieldBody}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            autoFocus
            placeholder={t.memory.fieldBodyPlaceholder}
            className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </Field>
        <Field label={t.memory.fieldKind}>
          <Input value={kind} onChange={(e) => setKind(e.target.value)} placeholder={t.memory.fieldKindPlaceholder} />
        </Field>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>{t.memory.cancel}</Button>
        <Button variant="accent" onClick={submit} disabled={create.isPending}>{t.memory.create}</Button>
      </ModalFooter>
    </Modal>
  );
}

/** Merge two or more memories into a single new one; the originals are soft-deleted. Prefills the body
 *  with the sources joined so the user edits down rather than retypes. */
function MergeMemoryModal({ sources, onClose, onMerged }: { sources: Memory[]; onClose: () => void; onMerged: (id: number) => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const merge = useMergeMemories();
  const [body, setBody] = useState(() => sources.map((m) => m.body).join('\n\n'));

  const submit = () => {
    if (sources.length < 2) { toast(t.memory.mergeNeedsTwo, 'error'); return; }
    const next = body.trim();
    if (!next) { toast(t.memory.bodyRequired, 'error'); return; }
    merge.mutate(
      { ids: sources.map((m) => m.id), body: next },
      { onSuccess: (m) => { toast(t.memory.merged); onMerged(m.id); }, onError: (e) => toast(apiErrorMessage(e), 'error') },
    );
  };

  return (
    <Modal title={t.memory.mergeTitle} onClose={onClose} size="md" icon={GitMerge} description={t.memory.mergeHint}>
      <ModalBody>
        <p className="text-xs text-text-muted">{t.memory.mergeSelected.replace('{n}', String(sources.length))}</p>
        <Field label={t.memory.mergeBodyLabel}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={7}
            className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </Field>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>{t.memory.cancel}</Button>
        <Button variant="accent" icon={GitMerge} onClick={submit} disabled={sources.length < 2 || merge.isPending}>{t.memory.mergeConfirm}</Button>
      </ModalFooter>
    </Modal>
  );
}
