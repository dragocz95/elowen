'use client';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Brain, Search, Plus, GitMerge, X, ListChecks, Sparkles, Hash, Gauge, Tags, Trash2, RotateCcw, Layers, ChevronLeft, ChevronRight, SlidersHorizontal, Clock, CheckCircle2, Archive } from 'lucide-react';
import type { Memory, MemoryCategory } from '../../lib/types';
import { useMemories, useMemoryCategories } from '../../lib/queries';
import { useCreateMemory, useMergeMemories, useDeleteMemory, useRestoreMemory, usePurgeMemories, useEmptyTrash, useSetMemoryCategory } from '../../lib/mutations';
import { apiErrorMessage } from '../../lib/elowenClient';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Segmented } from '../../components/ui/Segmented';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Field } from '../../components/ui/Field';
import { Checkbox } from '../../components/ui/Checkbox';
import { SelectMenu, type SelectMenuOption } from '../../components/ui/SelectMenu';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { DataTable, DataTableCell, DataTableRow } from '../../components/ui/DataTable';
import { WorkspaceDetailRail, WorkspaceHeader, WorkspaceMetric, WorkspaceMetrics, WorkspacePage } from '../../components/ui/WorkspacePrimitives';
import { MotionLayoutItem, MotionPresence } from '../../components/ui/Motion';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { usePersistentState } from '../../lib/usePersistentState';
import { formatTaskTime } from '../../lib/format';
import { CategoryIcon } from '../../lib/categoryIcons';
import { MemoryDetail } from './MemoryDetail';
import { MemoryBrainMap } from './MemoryBrainMap';
import { CategoryManager } from './CategoryManager';
import { RetrievalDebugPanel } from './RetrievalDebugPanel';
import { RankSlider, CategorySelect } from './MemoryFields';
import { memoryStatusTone, memoryStatusLabel, distinctKinds, categoriesById, categorySwatch } from './memoryMeta';

type Tab = 'list' | 'brain' | 'retrieval';
type StatusFilter = 'active' | 'archived' | 'deleted' | 'all';
type Layout = 'flat' | 'grouped';
type SortKey = 'updated' | 'importance';
const TABS: readonly Tab[] = ['list', 'brain', 'retrieval'];
const STATUS_VALUES: readonly StatusFilter[] = ['active', 'archived', 'deleted', 'all'];
const LAYOUT_VALUES: readonly Layout[] = ['flat', 'grouped'];
const PAGE_SIZE = 20;

/** Memory module: a searchable master/detail list of the caller's private memories, a retrieval
 *  inspector, and (for admins) the workspace embedding settings. All data via React Query. */
export function MemoryView() {
  const { t } = useTranslation();

  const [tab, setTab] = usePersistentState<Tab>('elowen.memory.tab', 'list', TABS);
  const [status, setStatus] = usePersistentState<StatusFilter>('elowen.memory.status', 'active', STATUS_VALUES);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<string>('all');
  // Category filter — 'all' | 'none' (uncategorized) | a stringified category id. Client-side over the
  // loaded list, mirroring how `kind` narrows the same in-memory rows.
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [showCategories, setShowCategories] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);
  const [merging, setMerging] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState(false);
  // Flat (paginated) vs grouped-by-category display of the list; persisted like the tab/status filters.
  const [layout, setLayout] = usePersistentState<Layout>('elowen.memory.layout', 'flat', LAYOUT_VALUES);
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>('updated');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const deferredQuery = useDeferredValue(query);
  const searchPending = query !== deferredQuery;

  const { toast } = useToast();
  const del = useDeleteMemory();
  const restore = useRestoreMemory();
  const purge = usePurgeMemories();
  const emptyTrash = useEmptyTrash();

  const memories = useMemories(status === 'all' ? undefined : { status });
  const allMemories = useMemories();
  const categories = useMemoryCategories();
  const categoryById = useMemo(() => categoriesById(categories.data ?? []), [categories.data]);

  const kinds = useMemo(() => distinctKinds(memories.data ?? []), [memories.data]);

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return (memories.data ?? [])
      .filter((m) => kind === 'all' || m.kind === kind)
      .filter((m) => categoryFilter === 'all'
        || (categoryFilter === 'none' ? m.category_id == null : m.category_id === Number(categoryFilter)))
      .filter((m) => !q || `${m.body} ${m.kind} ${m.source}`.toLowerCase().includes(q))
      .sort((a, b) => {
        const delta = sortKey === 'importance'
          ? a.importance - b.importance
          : a.updated_at.localeCompare(b.updated_at);
        return sortDirection === 'asc' ? delta : -delta;
      });
  }, [memories.data, kind, categoryFilter, deferredQuery, sortDirection, sortKey]);

  const summary = useMemo(() => {
    const items = allMemories.data ?? [];
    return {
      active: items.filter((memory) => memory.status === 'active').length,
      decisions: items.filter((memory) => memory.kind.toLowerCase() === 'decision').length,
      facts: items.filter((memory) => memory.kind.toLowerCase() === 'fact').length,
    };
  }, [allMemories.data]);

  const changeSort = (next: SortKey) => {
    if (sortKey === next) setSortDirection((direction) => direction === 'desc' ? 'asc' : 'desc');
    else { setSortKey(next); setSortDirection('desc'); }
  };

  // Paginate the filtered rows; the grouped view then buckets the CURRENT page into category sections, so
  // both display modes page through the same window (mirrors how Tasks groups a page into day sections).
  useEffect(() => { setPage(0); }, [query, kind, categoryFilter, status]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageItems = useMemo(() => filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE), [filtered, clampedPage]);

  // Grouped view: bucket the page's rows by category in first-appearance order (the page is already sorted
  // by recency), so the uncategorized bucket sits wherever it first shows up. Each section carries its
  // resolved category for a colored header.
  const sections = useMemo(() => {
    const order: (number | 'none')[] = [];
    const buckets = new Map<number | 'none', Memory[]>();
    for (const m of pageItems) {
      const key = m.category_id ?? 'none';
      if (!buckets.has(key)) { buckets.set(key, []); order.push(key); }
      buckets.get(key)!.push(m);
    }
    return order.map((key) => ({ key, category: key === 'none' ? undefined : categoryById.get(key), items: buckets.get(key)! }));
  }, [pageItems, categoryById]);

  const toggleSelect = (id: number) => setSelected((cur) => { const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSelection = () => setSelected(new Set());

  // Select-all is page-scoped: a paginated list must never silently select rows the user cannot see.
  const allSelected = pageItems.length > 0 && pageItems.every((m) => selected.has(m.id));
  const toggleSelectAll = () => setSelected((current) => {
    const next = new Set(current);
    if (allSelected) for (const m of pageItems) next.delete(m.id);
    else for (const m of pageItems) next.add(m.id);
    return next;
  });

  const selectedIds = () => filtered.filter((m) => selected.has(m.id)).map((m) => m.id);

  // Soft-delete / restore have no bulk endpoint, so fan out per id and report once. Purge/empty-trash
  // are single bulk calls. Every handler clears the selection and toasts on completion.
  const bulkDelete = async () => {
    const ids = selectedIds();
    try {
      await Promise.all(ids.map((id) => del.mutateAsync(id)));
      toast(t.memory.bulkDeleteDone.replace('{n}', String(ids.length)));
      clearSelection();
    } catch (e) { toast(apiErrorMessage(e), 'error'); }
  };
  const bulkRestore = async () => {
    const ids = selectedIds();
    try {
      await Promise.all(ids.map((id) => restore.mutateAsync(id)));
      toast(t.memory.bulkRestoreDone.replace('{n}', String(ids.length)));
      clearSelection();
    } catch (e) { toast(apiErrorMessage(e), 'error'); }
  };
  const bulkPurge = () => {
    setConfirmPurge(false);
    const ids = selectedIds();
    purge.mutate(ids, {
      onSuccess: () => { toast(t.memory.deletedPermanently); clearSelection(); },
      onError: (e) => toast(apiErrorMessage(e), 'error'),
    });
  };
  const doEmptyTrash = () => {
    setConfirmEmptyTrash(false);
    emptyTrash.mutate(undefined, {
      onSuccess: (r) => { toast(r.purged === 0 ? t.memory.emptyTrashEmpty : t.memory.emptyTrashDone.replace('{n}', String(r.purged))); clearSelection(); },
      onError: (e) => toast(apiErrorMessage(e), 'error'),
    });
  };

  // Keep selection consistent with what's on screen. When the filter/search narrows the visible set (or a
  // row is removed by a refetch), drop any selected ids that are no longer visible — otherwise the merge
  // toolbar counts rows outside the current dataset and the merge modal gets mismatched sources. selectedId
  // is pruned the same way. Keyed on `filtered` (not `tab`) so brain-map navigation, which sets selectedId
  // then switches to the list without touching the filter, is never clobbered.
  useEffect(() => {
    const visible = new Set(filtered.map((m) => m.id));
    setSelected((cur) => {
      if (cur.size === 0) return cur;
      const next = new Set<number>();
      for (const id of cur) if (visible.has(id)) next.add(id);
      return next.size === cur.size ? cur : next;
    });
    setSelectedId((cur) => (cur != null && !visible.has(cur) ? null : cur));
  }, [filtered]);

  // Leaving the list tab clears the merge selection so its floating toolbar never hovers over the brain
  // map or retrieval inspector, where those rows aren't selectable.
  useEffect(() => { if (tab !== 'list') clearSelection(); }, [tab]);

  const TAB_OPTIONS = [
    { value: 'list', label: t.memory.viewList, icon: ListChecks },
    { value: 'brain', label: t.memory.viewBrain, icon: Brain },
    { value: 'retrieval', label: t.memory.viewRetrieval, icon: Sparkles },
  ];
  const STATUS_OPTIONS: SelectMenuOption<StatusFilter>[] = STATUS_VALUES.map((s) => ({
    value: s,
    label: s === 'all' ? t.memory.statusAll : memoryStatusLabel(t, s),
    icon: s === 'active' ? <CheckCircle2 size={14} /> : s === 'archived' ? <Archive size={14} /> : s === 'deleted' ? <Trash2 size={14} /> : <Layers size={14} />,
  }));
  const KIND_OPTIONS: SelectMenuOption<string>[] = [
    { value: 'all', label: t.memory.allKinds, icon: <Hash size={14} /> },
    ...kinds.map((item) => ({ value: item, label: item, icon: <Hash size={14} /> })),
  ];
  const CATEGORY_OPTIONS: SelectMenuOption<string>[] = [
    { value: 'all', label: t.memory.categoryAll, icon: <Tags size={14} /> },
    { value: 'none', label: t.memory.categoryUncategorized, icon: <Hash size={14} /> },
    ...(categories.data ?? []).map((category) => ({
      value: String(category.id),
      label: category.name,
      icon: <span style={{ color: categorySwatch(category.color) }}><CategoryIcon name={category.icon} size={14} /></span>,
    })),
  ];
  const filterCount = Number(kind !== 'all') + Number(categoryFilter !== 'all') + Number(layout === 'grouped');

  const row = (m: Memory) => (
    <MotionLayoutItem
      key={m.id}
      layoutId={`memory-${m.id}`}
      role="presentation"
      className="border-b border-border/70 last:border-b-0"
    >
      <MemoryRow
        memory={m}
        category={m.category_id != null ? categoryById.get(m.category_id) : undefined}
        active={selectedId === m.id}
        selected={selected.has(m.id)}
        onSelect={() => setSelectedId(m.id)}
        onToggleSelect={() => toggleSelect(m.id)}
        onNavigate={(direction) => {
          const index = pageItems.findIndex((item) => item.id === m.id);
          const next = direction === 'home' ? pageItems[0]
            : direction === 'end' ? pageItems.at(-1)
              : pageItems[index + (direction === 'next' ? 1 : -1)];
          if (!next) return;
          setSelectedId(next.id);
          requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-memory-open="${next.id}"]`)?.focus());
        }}
      />
    </MotionLayoutItem>
  );

  return (
    <>
      <ModuleHeader title={t.page.memory} count={tab === 'list' ? filtered.length : undefined} icon={Brain} />
      <WorkspacePage>
        <WorkspaceHeader
          eyebrow={t.page.memory}
          title={t.page.memory}
          count={allMemories.data?.length ?? 0}
          description={t.memory.workspaceIntro}
          icon={Brain}
          status={!allMemories.isLoading && !allMemories.isError ? <span className="workspace-status">{t.memory.synchronized}</span> : undefined}
          action={<Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.memory.newMemory}</Button>}
        />
        <WorkspaceMetrics visual={<div className="memory-core" />} ariaLabel={t.memory.summary}>
          <WorkspaceMetric label={t.memory.statusActive} value={summary.active} icon={CheckCircle2} />
          <WorkspaceMetric label={t.memory.metricDecisions} value={summary.decisions} icon={ListChecks} />
          <WorkspaceMetric label={t.memory.metricFacts} value={summary.facts} icon={Sparkles} />
          <WorkspaceMetric label={t.memory.categoriesTitle} value={categories.data?.length ?? 0} icon={Tags} />
        </WorkspaceMetrics>
        <div className="workspace-tabs">
          <div className="min-w-0 overflow-x-auto">
          <Segmented value={tab} onChange={(v) => setTab(v as Tab)} options={TAB_OPTIONS} aria-label={t.page.memory} nowrap variant="line" />
          </div>
        </div>

      <div className="workspace-content">
        {tab === 'retrieval' ? <RetrievalDebugPanel />
          : tab === 'brain' ? (
            memories.isLoading ? <LoadingState variant="cards" />
            : memories.isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={() => memories.refetch()} />
            : <MemoryBrainMap memories={memories.data ?? []} categories={categories.data ?? []} onSelectMemory={(id) => { setSelectedId(id); setTab('list'); }} />
          )
          : memories.isLoading ? <LoadingState variant="cards" />
          : memories.isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={() => memories.refetch()} />
          : (
          <div className="workspace-master-detail" data-detail={selectedId != null}>
          <div className="flex min-w-0 flex-col gap-4">
            <div className="border-y border-border/80">
              <div className="flex min-w-0 flex-wrap items-center gap-2 py-3">
                <div className="relative min-w-[15rem] flex-1">
                  <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                  <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.memory.searchPlaceholder} className="pl-9" />
                </div>
                <SelectMenu
                  value={status}
                  onChange={setStatus}
                  options={STATUS_OPTIONS}
                  label={t.memory.filterStatus}
                  className="min-w-[9.5rem]"
                />
                <Button
                  variant={filtersOpen || filterCount > 0 ? 'accent' : 'ghost'}
                  icon={SlidersHorizontal}
                  aria-expanded={filtersOpen}
                  onClick={() => setFiltersOpen((open) => !open)}
                >
                  {t.memory.filters}{filterCount > 0 ? ` · ${filterCount}` : ''}
                </Button>
                {status === 'deleted' && filtered.length > 0 ? (
                  <Button variant="danger" icon={Trash2} onClick={() => setConfirmEmptyTrash(true)}>{t.memory.emptyTrash}</Button>
                ) : null}
              </div>

              {filtersOpen ? (
                <div className="grid gap-4 border-t border-border/70 py-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto_auto] lg:items-end">
                  <Field label={t.memory.filterKind}>
                    <SelectMenu
                      value={kind}
                      onChange={setKind}
                      options={KIND_OPTIONS}
                      label={t.memory.filterKind}
                      variant="line"
                    />
                  </Field>
                  <Field label={t.memory.categoryFilter}>
                    <SelectMenu
                      value={categoryFilter}
                      onChange={setCategoryFilter}
                      options={CATEGORY_OPTIONS}
                      label={t.memory.categoryFilter}
                      variant="line"
                    />
                  </Field>
                  <Button
                    variant={layout === 'grouped' ? 'accent' : 'ghost'}
                    icon={Layers}
                    aria-pressed={layout === 'grouped'}
                    onClick={() => setLayout(layout === 'grouped' ? 'flat' : 'grouped')}
                  >
                    {t.memory.groupByCategory}
                  </Button>
                  <Button
                    variant={showCategories ? 'accent' : 'ghost'}
                    icon={Tags}
                    aria-pressed={showCategories}
                    onClick={() => setShowCategories((v) => !v)}
                  >
                    {t.memory.categoriesTitle}
                  </Button>
                  {filterCount > 0 ? (
                    <Button variant="ghost" onClick={() => { setKind('all'); setCategoryFilter('all'); setLayout('flat'); }}>{t.memory.clearFilters}</Button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {showCategories ? <CategoryManager memories={memories.data ?? []} /> : null}

            {(memories.data?.length ?? 0) === 0 ? (
              <EmptyState title={t.memory.empty} description={t.memory.emptyHint} icon={Brain} action={<Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.memory.newMemory}</Button>} />
            ) : (
              <div className="flex min-w-0 flex-col gap-3" aria-busy={searchPending}>
                {filtered.length === 0 ? (
                  <EmptyState title={t.memory.emptySearch} icon={Search} />
                ) : (
                  <DataTable
                    ariaLabel={t.page.memory}
                    columns="2rem minmax(0,1fr) 11rem 8rem 6rem 7rem 1.25rem"
                    compactColumns="2rem minmax(0,1fr) 1.25rem"
                  >
                    <DataTableRow header className="px-1">
                      <DataTableCell header className="flex items-center justify-center">
                        <button
                          type="button"
                          onClick={toggleSelectAll}
                          disabled={pageItems.length === 0}
                          aria-label={t.memory.selectPage}
                          aria-pressed={allSelected}
                          title={t.memory.selectPage}
                          className="flex items-center justify-center disabled:opacity-40"
                        >
                          <Checkbox checked={allSelected} />
                        </button>
                      </DataTableCell>
                      <DataTableCell header>{t.page.memory}</DataTableCell>
                      <DataTableCell header priority="wide">{t.memory.categoryFilter}</DataTableCell>
                      <DataTableCell header priority="wide">{t.memory.filterKind}</DataTableCell>
                      <DataTableCell header priority="wide" aria-sort={sortKey === 'importance' ? (sortDirection === 'desc' ? 'descending' : 'ascending') : 'none'}>
                        <button type="button" onClick={() => changeSort('importance')} className="inline-flex items-center gap-1 hover:text-text">
                          {t.memory.fieldImportance}{sortKey === 'importance' ? <span aria-hidden>{sortDirection === 'desc' ? '↓' : '↑'}</span> : null}
                        </button>
                      </DataTableCell>
                      <DataTableCell header priority="wide" aria-sort={sortKey === 'updated' ? (sortDirection === 'desc' ? 'descending' : 'ascending') : 'none'}>
                        <button type="button" onClick={() => changeSort('updated')} className="inline-flex items-center gap-1 hover:text-text">
                          {t.memory.updatedAt}{sortKey === 'updated' ? <span aria-hidden>{sortDirection === 'desc' ? '↓' : '↑'}</span> : null}
                        </button>
                      </DataTableCell>
                      <DataTableCell header role="presentation" aria-hidden>{null}</DataTableCell>
                    </DataTableRow>

                    {layout === 'grouped' ? (
                      sections.map((sec) => (
                        <section key={String(sec.key)} role="rowgroup">
                          <CategorySectionHeader
                            category={sec.category}
                            label={sec.category ? sec.category.name : t.memory.categoryUncategorized}
                            count={sec.items.length}
                          />
                          <MotionPresence>{sec.items.map((m) => row(m))}</MotionPresence>
                        </section>
                      ))
                    ) : (
                      <div role="rowgroup">
                        <MotionPresence>{pageItems.map((m) => row(m))}</MotionPresence>
                      </div>
                    )}
                  </DataTable>
                )}

                {filtered.length > 0 ? (
                  <div className="flex flex-col gap-2 border-b border-border/80 pb-3 sm:flex-row sm:items-center sm:justify-between">
                    <span className="font-mono text-xs text-text-muted">
                      {t.memory.pageRange
                        .replace('{from}', String(clampedPage * PAGE_SIZE + 1))
                        .replace('{to}', String(clampedPage * PAGE_SIZE + pageItems.length))
                        .replace('{total}', String(filtered.length))}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" icon={ChevronLeft} disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}>{t.memory.prevPage}</Button>
                      <span className="min-w-24 text-center font-mono text-xs text-text-muted">
                        {t.memory.pageLabel.replace('{page}', String(clampedPage + 1)).replace('{pages}', String(pageCount))}
                      </span>
                      <Button variant="ghost" disabled={clampedPage >= pageCount - 1} onClick={() => setPage(clampedPage + 1)}>{t.memory.nextPage}<ChevronRight size={15} className="ml-1" aria-hidden /></Button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
            </div>
            {selectedId != null ? (
              <WorkspaceDetailRail label={t.memory.detailTitle} closeLabel={t.common.close} onClose={() => setSelectedId(null)}>
                <MemoryDetail memoryId={selectedId} />
              </WorkspaceDetailRail>
            ) : null}
          </div>
          )}
      </div>
      </WorkspacePage>

      {/* Floating bulk toolbar. Merge needs ≥2; soft-delete shows outside the trash, restore inside it,
          permanent delete everywhere (behind a confirm). Kept a sibling of the layout so it's never
          clipped. */}
      {tab === 'list' && selected.size > 0 ? (
        <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-xl border border-border bg-elevated px-3 py-2 shadow-[var(--shadow-raised)] animate-fade-up">
          <span className="px-1 text-sm text-text">{t.memory.selectedCount.replace('{n}', String(selected.size))}</span>
          <Button variant="accent" icon={GitMerge} disabled={selected.size < 2} onClick={() => setMerging(true)}>{t.memory.merge}</Button>
          {status === 'deleted' ? (
            <Button variant="default" icon={RotateCcw} onClick={bulkRestore}>{t.memory.bulkRestore}</Button>
          ) : (
            <Button variant="default" icon={Trash2} onClick={bulkDelete}>{t.memory.bulkDelete}</Button>
          )}
          <Button variant="danger" icon={Trash2} onClick={() => setConfirmPurge(true)}>{t.memory.purge}</Button>
          <button type="button" aria-label={t.memory.clearSelection} onClick={clearSelection} className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-surface hover:text-text"><X size={15} /></button>
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

      <ConfirmDialog
        open={confirmPurge}
        title={t.memory.purgeConfirmTitle}
        description={t.memory.purgeConfirmBody}
        confirmLabel={t.memory.purgeConfirm}
        onClose={() => setConfirmPurge(false)}
        onConfirm={bulkPurge}
      />
      <ConfirmDialog
        open={confirmEmptyTrash}
        title={t.memory.emptyTrashConfirmTitle}
        description={t.memory.emptyTrashConfirm}
        confirmLabel={t.memory.emptyTrash}
        onClose={() => setConfirmEmptyTrash(false)}
        onConfirm={doEmptyTrash}
      />
    </>
  );
}

/** Quiet full-width divider for a grouped page. Uncategorized falls back to a muted hash. */
function CategorySectionHeader({ category, label, count }: { category?: MemoryCategory; label: string; count: number }) {
  const color = category ? categorySwatch(category.color) : 'var(--color-text-muted)';
  return (
    <div role="row" className="flex items-center gap-2 border-b border-border/70 bg-elevated/20 px-3 py-2">
      <div role="cell" className="flex min-w-0 items-center gap-2">
        <span className="shrink-0" style={{ color }} aria-hidden>
          {category ? <CategoryIcon name={category.icon} size={14} /> : <Hash size={14} />}
        </span>
        <h3 className="truncate text-[11px] font-semibold uppercase tracking-wider text-text">{label}</h3>
        <span className="font-mono text-[10px] text-text-muted tabular-nums">{count}</span>
      </div>
    </div>
  );
}

/** One memory = one registry row. Secondary columns progressively appear as the workspace widens. */
function MemoryRow({ memory, category, active, selected, onSelect, onToggleSelect, onNavigate }: {
  memory: Memory;
  category?: MemoryCategory;
  active: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggleSelect: () => void;
  onNavigate: (direction: 'next' | 'previous' | 'home' | 'end') => void;
}) {
  const { t, locale } = useTranslation();
  const updated = formatTaskTime(memory.updated_at, Date.now(), locale);
  return (
    <DataTableRow
      data-testid="memory-row"
      selected={active || selected}
      interactive
      aria-selected={active || selected}
      className="group px-1"
    >
      <DataTableCell className="flex items-center justify-center">
        <button type="button" onClick={onToggleSelect} aria-label={t.memory.merge} aria-pressed={selected}>
          <Checkbox checked={selected} />
        </button>
      </DataTableCell>
      <DataTableCell>
        <button
          type="button"
          data-memory-open={memory.id}
          onClick={onSelect}
          onKeyDown={(event) => {
            const direction = event.key === 'ArrowDown' ? 'next' : event.key === 'ArrowUp' ? 'previous' : event.key === 'Home' ? 'home' : event.key === 'End' ? 'end' : null;
            if (!direction) return;
            event.preventDefault();
            onNavigate(direction);
          }}
          className="flex w-full min-w-0 items-center gap-2 text-left"
        >
          <span className="truncate text-sm text-text">{memory.body}</span>
          {memory.status !== 'active' ? <Badge tone={memoryStatusTone(memory.status)}>{memoryStatusLabel(t, memory.status)}</Badge> : null}
        </button>
      </DataTableCell>
      <DataTableCell priority="wide" className="truncate text-xs text-text-muted">
        {category ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0" style={{ color: categorySwatch(category.color) }}><CategoryIcon name={category.icon} size={12} /></span>
            <span className="truncate">{category.name}</span>
          </span>
        ) : <span className="italic text-text-muted/65">{t.memory.categoryUncategorized}</span>}
      </DataTableCell>
      <DataTableCell priority="wide" className="truncate font-mono text-xs text-text-muted">{memory.kind || '—'}</DataTableCell>
      <DataTableCell priority="wide" className="font-mono text-xs text-text-muted">
        <span className="flex items-center gap-1"><Gauge size={12} aria-hidden />{memory.importance}/5</span>
      </DataTableCell>
      <DataTableCell priority="wide" title={updated.title} className="whitespace-nowrap text-xs text-text-muted">
        <span className="flex items-center gap-1.5"><Clock size={12} aria-hidden />{updated.label}</span>
      </DataTableCell>
      <DataTableCell aria-hidden className="text-text-muted/50 transition-colors group-hover:text-text"><ChevronRight size={15} /></DataTableCell>
    </DataTableRow>
  );
}

/** Create a new memory (source 'user'). Mirrors the edit modal's fields so everything can be set up
 *  front: body (required), kind, category (with its live icon) and importance — no follow-up edit needed.
 *  Body + kind + importance persist in one POST; the category is a separate audited write (like edit),
 *  applied right after the create returns the new id. */
function CreateMemoryModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const create = useCreateMemory();
  const setCategory = useSetMemoryCategory();
  const categories = useMemoryCategories();
  const [body, setBody] = useState('');
  const [kind, setKind] = useState('');
  const [importance, setImportance] = useState(3);
  const [categoryId, setCategoryId] = useState<number | null>(null);

  const submit = () => {
    const next = body.trim();
    if (!next) { toast(t.memory.bodyRequired, 'error'); return; }
    create.mutate(
      { body: next, kind: kind.trim() || undefined, importance },
      {
        onSuccess: async (m) => {
          // Category isn't part of POST /memory — set it as a follow-up (audited), same as the edit modal.
          if (categoryId != null) {
            try { await setCategory.mutateAsync({ id: m.id, categoryId }); }
            catch (e) { toast(apiErrorMessage(e), 'error'); }
          }
          toast(t.memory.created);
          onCreated(m.id);
        },
        onError: (e) => toast(apiErrorMessage(e), 'error'),
      },
    );
  };

  const busy = create.isPending || setCategory.isPending;
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
        {(categories.data?.length ?? 0) > 0 ? (
          <Field label={t.memory.categoryFilter}>
            <CategorySelect
              categories={categories.data ?? []}
              value={categoryId}
              onChange={setCategoryId}
              ariaLabel={t.memory.categoryFilter}
              noneLabel={t.memory.categoryChipNone}
            />
          </Field>
        ) : null}
        <RankSlider label={t.memory.fieldImportance} icon={Gauge} value={importance} onChange={setImportance} />
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>{t.memory.cancel}</Button>
        <Button variant="accent" onClick={submit} disabled={busy}>{t.memory.create}</Button>
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
