'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, ListChecks, Search, Archive, Trash2, X, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Task, TaskStatus } from '../../lib/types';
import { useTasks, useAllDeps } from '../../lib/queries';
import { taskBlockers } from '../../lib/agentUtils';
import { useCloseTask, useDeleteTask } from '../../lib/mutations';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Segmented } from '../../components/ui/Segmented';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { TaskCard } from './TaskCard';
import { TaskModal } from './TaskModal';

type Filter = 'all' | TaskStatus;
const PAGE_SIZE = 12;

/** The date a task belongs to: its schedule, else when it closed, else when it was created. */
function taskDayMs(task: Task): number {
  const iso = task.scheduled_at || task.closed_at || task.created_at;
  const ms = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}
const dayKey = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

export function TasksView() {
  const tasks = useTasks();
  const deps = useAllDeps();
  const close = useCloseTask();
  const del = useDeleteTask();
  const { toast } = useToast();
  const { t, locale } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('in_progress');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const FILTERS: { value: Filter; label: string }[] = [
    { value: 'in_progress', label: t.tasks.filterActive },
    { value: 'open', label: t.tasks.filterOpen },
    { value: 'blocked', label: t.tasks.filterBlocked },
    { value: 'closed', label: t.tasks.filterClosed },
    { value: 'all', label: t.tasks.filterAll },
  ];

  // Command palette: /tasks?new=1 opens the create modal.
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => { if (params.get('new') === '1') { setCreating(true); router.replace('/tasks'); } }, [params, router]);

  // Resolve each task's unresolved dependency blockers once for the whole list.
  const blockedBy = useMemo(() => {
    const byId = new Map((tasks.data ?? []).map((x) => [x.id, x]));
    const out = new Map<string, Task[]>();
    for (const task of tasks.data ?? []) {
      const b = taskBlockers(task.id, deps.data ?? [], byId);
      if (b.length > 0) out.set(task.id, b);
    }
    return out;
  }, [tasks.data, deps.data]);

  const toggleSelect = (id: string) => setSelected((cur) => { const next = new Set(cur); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const clearSelection = () => setSelected(new Set());
  const bulkClose = () => { selected.forEach((id) => close.mutate(id)); toast(t.tasks.nClosed.replace('{count}', String(selected.size))); clearSelection(); };
  const bulkDelete = () => { selected.forEach((id) => del.mutate(id)); toast(t.tasks.nDeleted.replace('{count}', String(selected.size))); clearSelection(); setConfirmBulkDelete(false); };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tasks.data ?? [])
      .filter((t) => {
        if (filter !== 'all' && t.status !== filter) return false;
        if (!q) return true;
        return `${t.title} ${t.id} ${t.description ?? ''}`.toLowerCase().includes(q);
      })
      .sort((a, b) => taskDayMs(b) - taskDayMs(a)); // newest day first
  }, [tasks.data, query, filter]);

  // Reset to the first page whenever the result set changes shape.
  useEffect(() => { setPage(0); }, [query, filter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageItems = filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

  // Group the current page's cards into day sections, preserving sorted order.
  const dayLabel = (ms: number): string => {
    const now = new Date();
    const todayKey = dayKey(now.getTime());
    const yesterdayKey = dayKey(now.getTime() - 86400000);
    const k = dayKey(ms);
    if (k === todayKey) return t.tasks.dayToday;
    if (k === yesterdayKey) return t.tasks.dayYesterday;
    return new Date(ms).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
  };
  const groups = useMemo(() => {
    const out: { key: string; label: string; items: Task[] }[] = [];
    for (const task of pageItems) {
      const ms = taskDayMs(task);
      const k = dayKey(ms);
      const last = out[out.length - 1];
      if (last && last.key === k) last.items.push(task);
      else out.push({ key: k, label: dayLabel(ms), items: [task] });
    }
    return out;
  }, [pageItems, locale, t]);

  return (
    <>
      <ModuleHeader title={t.page.tasks} count={filtered.length} icon={ListChecks}>
        <div className="relative w-40 sm:w-52">
          <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.tasks.searchPlaceholder} className="pl-9" />
        </div>
        <Segmented value={filter} onChange={(v) => setFilter(v as Filter)} options={FILTERS} />
        <Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.tasks.newTask}</Button>
      </ModuleHeader>

      {tasks.isLoading ? <LoadingState variant="cards" />
        : tasks.isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={() => tasks.refetch()} />
        : !tasks.data || tasks.data.length === 0 ? <EmptyState title={t.tasks.empty} description={t.tasks.emptyDescription} icon={ListChecks} action={<Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.tasks.newTask}</Button>} />
        : filtered.length === 0 ? <EmptyState title={t.tasks.noMatches} description={t.tasks.noMatchesDescription} icon={Search} />
        : (
          <div className="flex flex-col gap-5">
            {groups.map((g) => (
              <div key={g.key} className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{g.label}</span>
                  <span className="h-px flex-1 bg-border" />
                  <span className="font-mono text-tiny text-text-muted">{g.items.length}</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {g.items.map((task) => <TaskCard key={task.id} task={task} onEdit={setEditing} blockers={blockedBy.get(task.id)} selected={selected.has(task.id)} onToggleSelect={toggleSelect} selecting={selected.size > 0} />)}
                </div>
              </div>
            ))}

            {filtered.length > PAGE_SIZE && (
              <div className="flex items-center justify-between border-t border-border pt-3">
                <span className="font-mono text-xs text-text-muted">
                  {t.tasks.pageRange
                    .replace('{from}', String(clampedPage * PAGE_SIZE + 1))
                    .replace('{to}', String(clampedPage * PAGE_SIZE + pageItems.length))
                    .replace('{total}', String(filtered.length))}
                </span>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" icon={ChevronLeft} disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}>{t.tasks.prevPage}</Button>
                  <Button variant="ghost" disabled={clampedPage >= pageCount - 1} onClick={() => setPage(clampedPage + 1)}>{t.tasks.nextPage}<ChevronRight size={15} className="ml-1" /></Button>
                </div>
              </div>
            )}
          </div>
        )}

      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-elevated px-3 py-2 shadow-[var(--shadow-raised)] animate-fade-up">
          <span className="px-1 text-sm text-text">{t.tasks.nSelected.replace('{count}', String(selected.size))}</span>
          <Button variant="default" icon={Archive} onClick={bulkClose}>{t.common.close}</Button>
          <Button variant="danger" icon={Trash2} onClick={() => setConfirmBulkDelete(true)}>{t.common.delete}</Button>
          <button type="button" aria-label={t.tasks.clearSelection} onClick={clearSelection} className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-surface hover:text-text"><X size={15} /></button>
        </div>
      )}

      {creating && <TaskModal onClose={() => setCreating(false)} />}
      {editing && <TaskModal task={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={confirmBulkDelete} title={t.tasks.confirmBulkDeleteTitle.replace('{count}', String(selected.size))} description={t.tasks.confirmBulkDeleteDescription} onClose={() => setConfirmBulkDelete(false)} onConfirm={bulkDelete} />
    </>
  );
}
