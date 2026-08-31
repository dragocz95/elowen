'use client';
import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Brain, Search, Plus, GitMerge, X, ListChecks, Sparkles, Hash, Gauge, Tags, Trash2, RotateCcw, Layers, Clock, Activity, CheckCircle2, Archive } from 'lucide-react';
import type { Memory, MemoryCategory } from '../../lib/types';
import { useMemories, useMemoryCategories } from '../../lib/queries';
import { useCreateMemory, useMergeMemories, useDeleteMemory, useRestoreMemory, usePurgeMemories, useEmptyTrash, useSetMemoryCategory } from '../../lib/mutations';
import { apiErrorMessage } from '../../lib/elowenClient';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Field } from '../../components/ui/Field';
import { Checkbox } from '../../components/ui/Checkbox';
import { Toggle } from '../../components/ui/Toggle';
import { SelectMenu, type SelectMenuOption } from '../../components/ui/SelectMenu';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { DataTable, DataTableCell, DataTableChevronCell, DataTableRow, DataTableSortCell } from '../../components/ui/DataTable';
import { WorkspaceDetailRail, WorkspaceMetric } from '../../components/ui/WorkspacePrimitives';
import { WorkspaceShell } from '../../components/ui/WorkspaceShell';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import type { PageFilterField } from '../../components/ui/PageFilters';
import { Pager } from '../../components/ui/Pager';
import { RegisterSearch } from '../../components/ui/RegisterSearch';
import { ControlSurfaceDocument, ControlSurfaceRegister, ControlSurfaceState } from '../../components/ui/ControlSurface';
import { MotionLayoutItem, MotionPresence } from '../../components/ui/Motion';
import { useToast } from '../../components/ui/Toast';
import { interpolate, useTranslation } from '../../lib/i18n';
import { usePersistentState } from '../../lib/usePersistentState';
import { formatTaskTime, compactElapsed, parseTs } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { CategoryIcon } from '../../lib/categoryIcons';
import { MemoryDetail } from './MemoryDetail';
import { MemoryBrainMap } from './MemoryBrainMap';
import { CategoryManager, CategoryModal } from './CategoryManager';
import { RetrievalDebugPanel } from './RetrievalDebugPanel';
import { RankSlider, CategorySelect } from './MemoryFields';
import { memoryStatusTone, memoryStatusLabel, distinctKinds, categoriesById, categorySwatch, vitalityPct, vitalityTone } from './memoryMeta';
import type { Tone } from '../../components/ui/tone';

type Tab = 'list' | 'brain' | 'retrieval';
type StatusFilter = 'active' | 'archived' | 'deleted' | 'all';
type Layout = 'flat' | 'grouped';
type SortKey = 'updated' | 'used' | 'importance' | 'vitality';
const TABS: readonly Tab[] = ['list', 'brain', 'retrieval'];
const STATUS_VALUES: readonly StatusFilter[] = ['active', 'archived', 'deleted', 'all'];
const LAYOUT_VALUES: readonly Layout[] = ['flat', 'grouped'];
const SORT_KEYS: readonly SortKey[] = ['updated', 'used', 'importance', 'vitality'];
const SORT_DIRECTIONS: readonly ('asc' | 'desc')[] = ['asc', 'desc'];
const PAGE_SIZE = 20;
/** How much of a memory body may stand in for it inside a control's accessible name. A memory has no
 *  title, so the body is the only thing that identifies a row — but the whole body is not a name: the
 *  longest one measured here ran past 3000 characters, all of it read out before the user learned that
 *  the control opens a record. */
const ROW_LABEL_MAX = 60;
function memoryExcerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > ROW_LABEL_MAX ? `${flat.slice(0, ROW_LABEL_MAX).trimEnd()}…` : flat;
}

/** States one NARROWING toolbar filter as the discriminated union `PageFilters` requires, so a field
 *  that is removing rows always carries both its chip wording and its undo. Written once here because
 *  this register has three of them and the union cannot be produced by spreading a conditional object.
 *  A display option is not routed through here at all — it has no active state to switch on. */
function filterField(
  base: { id: string; label: string; control: ReactNode },
  active: boolean,
  activeLabel: string,
  onReset: () => void,
): PageFilterField {
  return active ? { ...base, active: true, activeLabel, onReset } : { ...base, active: false };
}

/** Memory module: a searchable master/detail list of the caller's private memories, a retrieval
 *  inspector, and (for admins) the workspace embedding settings. All data via React Query. */
export function MemoryView() {
  const { t } = useTranslation();

  const [tab, setTab] = usePersistentState<Tab>('elowen.memory.tab', 'list', TABS);
  const [status, setStatus] = usePersistentState<StatusFilter>('elowen.memory.status', 'active', STATUS_VALUES);
  // Search stays transient on purpose: it is an immediate intent, and a query restored after a reload
  // would look like missing data rather than an active filter.
  const [query, setQuery] = useState('');
  const [kind, setKind] = usePersistentState<string>('elowen.memory.kind', 'all', () => true);
  // Category filter — 'all' | 'none' (uncategorized) | a stringified category id. Client-side over the
  // loaded list, mirroring how `kind` narrows the same in-memory rows. The stored id is validated
  // against the loaded categories below: a category deleted since would otherwise leave the table
  // silently empty behind a filter the user cannot see.
  const [categoryFilter, setCategoryFilter] = usePersistentState<string>(
    'elowen.memory.category', 'all', (value) => value === 'all' || value === 'none' || /^\d+$/.test(value),
  );
  const [showCategories, setShowCategories] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [merging, setMerging] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState(false);
  // Flat (paginated) vs grouped-by-category display of the list; persisted like the tab/status filters.
  const [layout, setLayout] = usePersistentState<Layout>('elowen.memory.layout', 'flat', LAYOUT_VALUES);
  // The page number deliberately does NOT persist: landing on page 7 after a reload is disorienting,
  // and it is reset on every filter change anyway.
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = usePersistentState<SortKey>('elowen.memory.sortKey', 'updated', SORT_KEYS);
  const [sortDirection, setSortDirection] = usePersistentState<'asc' | 'desc'>(
    'elowen.memory.sortDirection', 'desc', SORT_DIRECTIONS,
  );
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
          : sortKey === 'vitality'
            ? a.vitality - b.vitality
            // Never-used sorts as the oldest, so "least recently used" surfaces it first.
            : sortKey === 'used'
              ? (parseTs(a.last_used_at) ?? 0) - (parseTs(b.last_used_at) ?? 0)
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
    // The persisted setter takes a value, not an updater — `sortDirection` is already the current one.
    if (sortKey === next) setSortDirection(sortDirection === 'desc' ? 'asc' : 'desc');
    else { setSortKey(next); setSortDirection('desc'); }
  };

  // Paginate the filtered rows; the grouped view then buckets the CURRENT page into category sections, so
  // both display modes page through the same window (mirrors how Tasks groups a page into day sections).
  useEffect(() => { setPage(0); }, [query, kind, categoryFilter, status]);
  // A remembered category filter outlives the category itself. Once the real list is in, drop a filter
  // that no longer resolves — otherwise a reload lands on an empty table with no visible cause.
  useEffect(() => {
    if (!categories.data || !/^\d+$/.test(categoryFilter)) return;
    if (!categories.data.some((category) => String(category.id) === categoryFilter)) setCategoryFilter('all');
  }, [categories.data, categoryFilter, setCategoryFilter]);
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
    { id: 'list', label: t.memory.viewList, icon: ListChecks },
    { id: 'brain', label: t.memory.viewBrain, icon: Brain },
    { id: 'retrieval', label: t.memory.viewRetrieval, icon: Sparkles },
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
  // Every control the condensed panel carries, declared once. The toolbar derives the active count, the
  // chips and every reset from this list, so a filter can no longer be added without also becoming
  // visible and undoable — the hand-kept tally it replaces counted three of the five. Only the first
  // three NARROW the register and only they may report themselves active; see the note below.
  const statusChipValue = status === 'all' ? t.memory.statusAll : memoryStatusLabel(t, status);
  const categoryChipValue = CATEGORY_OPTIONS.find((option) => option.value === categoryFilter)?.label ?? categoryFilter;
  const filterFields: PageFilterField[] = [
    filterField(
      {
        id: 'status',
        label: t.memory.filterStatus,
        control: <SelectMenu value={status} onChange={setStatus} options={STATUS_OPTIONS} label={t.memory.filterStatus} variant="line" />,
      },
      status !== 'active',
      `${t.memory.filterStatus}: ${statusChipValue}`,
      () => setStatus('active'),
    ),
    filterField(
      {
        id: 'kind',
        label: t.memory.filterKind,
        control: <SelectMenu value={kind} onChange={setKind} options={KIND_OPTIONS} label={t.memory.filterKind} variant="line" />,
      },
      kind !== 'all',
      `${t.memory.filterKind}: ${kind}`,
      () => setKind('all'),
    ),
    filterField(
      {
        id: 'category',
        label: t.memory.categoryFilter,
        control: <SelectMenu value={categoryFilter} onChange={setCategoryFilter} options={CATEGORY_OPTIONS} label={t.memory.categoryFilter} variant="line" />,
      },
      categoryFilter !== 'all',
      `${t.memory.categoryFilter}: ${categoryChipValue}`,
      () => setCategoryFilter('all'),
    ),
    // The last two are DISPLAY options, not filters, and they are declared `active: false` for good.
    // Grouping rearranges the same rows into category sections and the categories switch reveals an
    // extra panel above the register — neither removes a single row, so neither may be counted by the
    // Filters trigger, become a chip that claims the register is narrowed, or be undone by "Clear
    // filters" (which would silently rearrange the page the user did not ask to rearrange). They stay
    // inside the condensed panel because that is where the page's view controls belong; what they are
    // NOT is part of the answer to "why am I not seeing everything".
    {
      id: 'layout',
      label: t.memory.groupByCategory,
      control: <Toggle checked={layout === 'grouped'} onChange={(next) => setLayout(next ? 'grouped' : 'flat')} label={t.memory.groupByCategory} />,
      active: false,
    },
    {
      id: 'categories',
      label: t.memory.categoriesTitle,
      control: <Toggle checked={showCategories} onChange={setShowCategories} label={t.memory.categoriesTitle} />,
      active: false,
    },
  ];

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
          // Arrow/Home/End move the row focus only. Opening the modal detail drawer here would
          // inert the register underneath it and interrupt keyboard traversal after one step.
          requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-memory-row="${next.id}"] .data-table-row-open`)?.focus());
        }}
      />
    </MotionLayoutItem>
  );

  return (
    <>
      <ModuleHeader title={t.page.memory} count={allMemories.data?.length} icon={Brain} />
      <WorkspaceShell
        variant="register"
        hero={{
          // No eyebrow: it repeated the title verbatim ("Memory" over "Memory"), which on a phone spends
          // a line of the first screen saying nothing.
          title: t.page.memory,
          count: allMemories.data?.length ?? 0,
          description: t.memory.workspaceIntro,
          mascot: allMemories.isLoading ? 'saving' : allMemories.isError ? 'error' : 'idle',
          status: !allMemories.isLoading && !allMemories.isError ? <span className="workspace-status">{t.memory.synchronized}</span> : undefined,
          action: <>
            <Button variant="ghost" icon={Tags} onClick={() => setCreatingCategory(true)}>{t.memory.categoryNew}</Button>
            <Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.memory.newMemory}</Button>
          </>,
          metrics: <>
          <WorkspaceMetric label={t.memory.statusActive} value={summary.active} icon={CheckCircle2} />
          <WorkspaceMetric label={t.memory.metricDecisions} value={summary.decisions} icon={ListChecks} />
          <WorkspaceMetric label={t.memory.metricFacts} value={summary.facts} icon={Sparkles} />
          <WorkspaceMetric label={t.memory.categoriesTitle} value={categories.data?.length ?? 0} icon={Tags} />
          </>,
        }}
        navigation={{ sections: TAB_OPTIONS, value: tab, onChange: (value) => setTab(value as Tab), ariaLabel: t.page.memory }}
        // The toolbar narrows the LIST. The brain map and the retrieval inspector read none of these
        // controls, so they get the empty row the stylesheet collapses rather than filters that would
        // silently do nothing on the section the reader is looking at.
        toolbar={tab === 'list' ? {
          search: (
            <RegisterSearch
              value={query}
              onChange={setQuery}
              placeholder={t.memory.searchPlaceholder}
              onClear={() => setQuery('')}
              clearLabel={t.memory.searchClear}
            />
          ),
          filters: filterFields,
          // Emptying the trash is a destructive act on what is currently on screen, not a way to narrow
          // it — it stays in the open beside the search rather than two clicks deep behind Filters.
          actions: status === 'deleted' && filtered.length > 0
            ? <Button variant="danger" icon={Trash2} onClick={() => setConfirmEmptyTrash(true)}>{t.memory.emptyTrash}</Button>
            : undefined,
        } : undefined}
      >
        <ControlSurfaceDocument>
        {tab === 'retrieval' ? <RetrievalDebugPanel />
          : tab === 'brain' ? (
            memories.isLoading ? <ControlSurfaceState><LoadingState variant="cards" /></ControlSurfaceState>
            : memories.isError ? <ControlSurfaceState tone="danger"><ErrorState message={t.common.daemonUnreachable} onRetry={() => memories.refetch()} /></ControlSurfaceState>
            : <MemoryBrainMap memories={memories.data ?? []} categories={categories.data ?? []} onSelectMemory={setSelectedId} />
          )
          : memories.isLoading ? <ControlSurfaceState><LoadingState variant="cards" /></ControlSurfaceState>
          : memories.isError ? <ControlSurfaceState tone="danger"><ErrorState message={t.common.daemonUnreachable} onRetry={() => memories.refetch()} /></ControlSurfaceState>
          : (
          <div className="workspace-master-detail" data-detail={selectedId != null}>
          <div className="flex min-w-0 flex-col gap-4">
            <ControlSurfaceRegister className="flex flex-col gap-4">
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
                    columns="2rem minmax(0,1fr) 8rem 5rem 5.5rem 5.5rem 5.5rem 4.5rem 1.25rem"
                    compactColumns="2rem minmax(0,1fr) 1.25rem"
                  >
                    <DataTableRow header>
                      <DataTableCell header lines="auto" className="flex items-center justify-center">
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
                      <DataTableCell header lines={1}>{t.page.memory}</DataTableCell>
                      <DataTableCell header priority="wide" lines={1}>{t.memory.categoryFilter}</DataTableCell>
                      <DataTableCell header priority="wide" lines={1}>{t.memory.filterKind}</DataTableCell>
                      <DataTableSortCell priority="wide" active={sortKey === 'vitality'} direction={sortDirection} onSort={() => changeSort('vitality')}>
                        {t.memory.fieldVitality}
                      </DataTableSortCell>
                      <DataTableSortCell priority="wide" active={sortKey === 'importance'} direction={sortDirection} onSort={() => changeSort('importance')}>
                        {t.memory.fieldImportance}
                      </DataTableSortCell>
                      <DataTableSortCell priority="wide" active={sortKey === 'updated'} direction={sortDirection} onSort={() => changeSort('updated')}>
                        {t.memory.updatedAt}
                      </DataTableSortCell>
                      <DataTableSortCell priority="wide" active={sortKey === 'used'} direction={sortDirection} onSort={() => changeSort('used')}>
                        {t.memory.usedAt}
                      </DataTableSortCell>
                      {/* The trailing chevron track: an affordance, not a column, so its header is empty. */}
                      <DataTableCell header aria-hidden lines={1}>{null}</DataTableCell>
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
                  <Pager
                    page={clampedPage}
                    pageSize={PAGE_SIZE}
                    total={filtered.length}
                    onPageChange={setPage}
                    ariaLabel={t.page.memory}
                  />
                ) : null}
              </div>
            )}
            </ControlSurfaceRegister>
            </div>
            {selectedId != null ? (
              <WorkspaceDetailRail label={t.memory.detailTitle} closeLabel={t.common.close} onClose={() => setSelectedId(null)}>
                <MemoryDetail memoryId={selectedId} />
              </WorkspaceDetailRail>
            ) : null}
          </div>
          )}
        </ControlSurfaceDocument>
        {tab === 'brain' && selectedId != null ? (
          <WorkspaceDetailRail label={t.memory.detailTitle} closeLabel={t.common.close} onClose={() => setSelectedId(null)} scrim="soft">
            <MemoryDetail memoryId={selectedId} />
          </WorkspaceDetailRail>
        ) : null}
      </WorkspaceShell>

      {/* Floating bulk toolbar. Merge needs ≥2; soft-delete shows outside the trash, restore inside it,
          permanent delete everywhere (behind a confirm). Kept a sibling of the layout so it's never
          clipped. */}
      {tab === 'list' && selected.size > 0 ? (
        <div className="overlay-layer-fab fixed bottom-6 left-1/2 flex -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-xl border border-border bg-muted px-3 py-2 shadow-[var(--shadow-raised)] animate-fade-up">
          <span className="px-1 text-sm text-foreground">{t.memory.selectedCount.replace('{n}', String(selected.size))}</span>
          <Button variant="accent" icon={GitMerge} disabled={selected.size < 2} onClick={() => setMerging(true)}>{t.memory.merge}</Button>
          {status === 'deleted' ? (
            <Button variant="default" icon={RotateCcw} onClick={bulkRestore}>{t.memory.bulkRestore}</Button>
          ) : (
            <Button variant="default" icon={Trash2} onClick={bulkDelete}>{t.memory.bulkDelete}</Button>
          )}
          <Button variant="danger" icon={Trash2} onClick={() => setConfirmPurge(true)}>{t.memory.purge}</Button>
          <button type="button" aria-label={t.memory.clearSelection} onClick={clearSelection} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"><X size={15} /></button>
        </div>
      ) : null}

      {creating ? <CreateMemoryModal onClose={() => setCreating(false)} onCreated={(id) => { setSelectedId(id); setCreating(false); }} /> : null}
      {creatingCategory ? <CategoryModal onClose={() => setCreatingCategory(false)} /> : null}
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
  const color = category ? categorySwatch(category.color) : 'var(--color-muted-foreground)';
  return (
    <div role="row" className="flex items-center gap-2 border-b border-border/70 bg-muted/20 px-3 py-2">
      <div role="cell" className="flex min-w-0 items-center gap-2">
        <span className="shrink-0" style={{ color }} aria-hidden>
          {category ? <CategoryIcon name={category.icon} size={14} /> : <Hash size={14} />}
        </span>
        <h3 className="truncate text-[11px] font-semibold uppercase tracking-wider text-foreground">{label}</h3>
        <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{count}</span>
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
  // Both columns are elapsed times, so they have to keep counting on their own — a recall lands from the
  // daemon, not from anything this row did, and a frozen "2m" would quietly go on lying.
  const now = useNow();
  const updated = formatTaskTime(memory.updated_at, now, locale);
  // Recall recency stays relative at every distance ("12m", "5d") — the question this column answers is
  // "how long since this was last read", not "on which date". The exact stamp lives in the tooltip.
  const usedMs = parseTs(memory.last_used_at);
  const used = {
    label: usedMs == null ? '—' : compactElapsed(now - usedMs),
    title: usedMs == null ? t.memory.neverUsed : formatTaskTime(memory.last_used_at, now, locale).title,
  };
  return (
    <DataTableRow
      data-testid="memory-row"
      data-memory-row={memory.id}
      selected={active || selected}
      aria-selected={active || selected}
      onOpen={onSelect}
      openLabel={interpolate(t.memory.openRow, { excerpt: memoryExcerpt(memory.body) })}
      onKeyDown={(event) => {
        // Roving traversal belongs to the row-open button alone: the checkbox is a separate control in
        // the same row, and an arrow key pressed on it must not walk the register away from it.
        if (!(event.target instanceof HTMLElement) || !event.target.classList.contains('data-table-row-open')) return;
        const direction = event.key === 'ArrowDown' ? 'next' : event.key === 'ArrowUp' ? 'previous' : event.key === 'Home' ? 'home' : event.key === 'End' ? 'end' : null;
        if (!direction) return;
        event.preventDefault();
        onNavigate(direction);
      }}
      className="group"
    >
      <DataTableCell lines="auto" className="flex items-center justify-center">
        <button type="button" onClick={onToggleSelect} aria-label={t.memory.merge} aria-pressed={selected}>
          <Checkbox checked={selected} />
        </button>
      </DataTableCell>
      <DataTableCell lines={1} title={memory.body} className="flex items-center gap-2">
        <span className="truncate text-sm text-foreground">{memory.body}</span>
        {memory.status !== 'active' ? <Badge tone={memoryStatusTone(memory.status)}>{memoryStatusLabel(t, memory.status)}</Badge> : null}
      </DataTableCell>
      <DataTableCell priority="wide" lines={1} className="truncate text-xs text-muted-foreground">
        {category ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0" style={{ color: categorySwatch(category.color) }}><CategoryIcon name={category.icon} size={12} /></span>
            <span className="truncate">{category.name}</span>
          </span>
        ) : <span className="italic text-muted-foreground/65">{t.memory.categoryUncategorized}</span>}
      </DataTableCell>
      {/* The kind is a WORD the reader picks from a menu — "fact", "preference" — and not an identifier,
          so it is set in the row's own face. The mono face is wider per character and truncated it to
          "preferen…" on every second row of the register. */}
      <DataTableCell priority="wide" lines={1} className="truncate text-xs text-muted-foreground">{memory.kind || '—'}</DataTableCell>
      <DataTableCell priority="wide" lines={1} className="whitespace-nowrap text-xs">
        <VitalityCell value={memory.vitality} />
      </DataTableCell>
      <DataTableCell priority="wide" lines={1} className="font-mono text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><Gauge size={12} aria-hidden />{memory.importance}/5</span>
      </DataTableCell>
      <DataTableCell priority="wide" lines={1} title={updated.title} className="whitespace-nowrap text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><Clock size={12} aria-hidden />{updated.label}</span>
      </DataTableCell>
      <DataTableCell priority="wide" lines={1} title={used.title} className="whitespace-nowrap text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5" data-testid="memory-used-cell">
          <Activity size={12} aria-hidden />
          <span className={usedMs == null ? 'text-muted-foreground/60' : undefined}>{used.label}</span>
        </span>
      </DataTableCell>
      <DataTableChevronCell />
    </DataTableRow>
  );
}

/** Vitality bar + score for one row. The bar's colour mirrors the tone scale used for lifecycle badges:
 *  danger near the auto-retention floor, success when healthy. */
const VITALITY_BAR_BG: Record<Tone, string> = {
  default: 'bg-muted-foreground', accent: 'bg-primary', muted: 'bg-muted-foreground',
  danger: 'bg-destructive', success: 'bg-success', warning: 'bg-warning',
};
function VitalityCell({ value }: { value: number }) {
  const pct = vitalityPct(value);
  const tone = vitalityTone(value);
  return (
    <span className="flex items-center gap-1.5" title={`${pct}/100`}>
      {/* `data-table-meter` names the bar as what it is: a graphic beside a figure that already states
          the same value. A design that reads its registers as tables rather than as dashboards drops
          the graphic and keeps the number, and it needs something to address. */}
      <span className="data-table-meter h-1.5 w-10 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className={`block h-full rounded-full ${VITALITY_BAR_BG[tone]}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="font-mono tabular-nums text-muted-foreground">{pct}</span>
    </span>
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
            className="w-full resize-y rounded-md border border-border bg-card px-3 py-2 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
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
        <p className="text-xs text-muted-foreground">{t.memory.mergeSelected.replace('{n}', String(sources.length))}</p>
        <Field label={t.memory.mergeBodyLabel}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={7}
            className="w-full resize-y rounded-md border border-border bg-card px-3 py-2 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
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
