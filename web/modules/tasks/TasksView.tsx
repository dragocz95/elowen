'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, ListChecks, Search, Archive, Trash2, X } from 'lucide-react';
import type { Task, TaskStatus } from '../../lib/types';
import { useTasks } from '../../lib/queries';
import { useCloseTask, useDeleteTask } from '../../lib/mutations';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Section } from '../../components/ui/Section';
import { Segmented } from '../../components/ui/Segmented';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { TaskRow } from './TaskRow';
import { TaskModal } from './TaskModal';

type Filter = 'all' | TaskStatus;

export function TasksView() {
  const tasks = useTasks();
  const close = useCloseTask();
  const del = useDeleteTask();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const FILTERS: { value: Filter; label: string }[] = [
    { value: 'all', label: t.tasks.filterAll },
    { value: 'open', label: t.tasks.filterOpen },
    { value: 'in_progress', label: t.tasks.filterActive },
    { value: 'blocked', label: t.tasks.filterBlocked },
    { value: 'closed', label: t.tasks.filterClosed },
  ];

  // Command palette: /tasks?new=1 opens the create modal.
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => { if (params.get('new') === '1') { setCreating(true); router.replace('/tasks'); } }, [params, router]);

  const toggleSelect = (id: string) => setSelected((cur) => { const next = new Set(cur); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const clearSelection = () => setSelected(new Set());
  const bulkClose = () => { selected.forEach((id) => close.mutate(id)); toast(t.tasks.nClosed.replace('{count}', String(selected.size))); clearSelection(); };
  const bulkDelete = () => { selected.forEach((id) => del.mutate(id)); toast(t.tasks.nDeleted.replace('{count}', String(selected.size))); clearSelection(); setConfirmBulkDelete(false); };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tasks.data ?? []).filter((t) => {
      if (filter !== 'all' && t.status !== filter) return false;
      if (!q) return true;
      return `${t.title} ${t.id} ${t.description ?? ''}`.toLowerCase().includes(q);
    });
  }, [tasks.data, query, filter]);

  return (
    <>
      <Section
        title={t.page.tasks}
        icon={ListChecks}
        actions={<Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.tasks.newTask}</Button>}
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="relative max-w-xs flex-1">
            <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.tasks.searchPlaceholder} className="pl-9" />
          </div>
          <Segmented value={filter} onChange={(v) => setFilter(v as Filter)} options={FILTERS} />
        </div>

        {tasks.isLoading ? <LoadingState />
          : tasks.isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={() => tasks.refetch()} />
          : !tasks.data || tasks.data.length === 0 ? <EmptyState title={t.tasks.empty} description={t.tasks.emptyDescription} />
          : filtered.length === 0 ? <EmptyState title={t.tasks.noMatches} description={t.tasks.noMatchesDescription} />
          : (
            <div className="flex flex-col divide-y divide-border">
              {filtered.map((t) => <TaskRow key={t.id} task={t} onEdit={setEditing} selected={selected.has(t.id)} onToggleSelect={toggleSelect} selecting={selected.size > 0} />)}
            </div>
          )}
      </Section>

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
