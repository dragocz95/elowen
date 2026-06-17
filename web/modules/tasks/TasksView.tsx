'use client';
import { useMemo, useState } from 'react';
import { Plus, ListChecks, Search } from 'lucide-react';
import type { Task, TaskStatus } from '../../lib/types';
import { useTasks } from '../../lib/queries';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Section } from '../../components/ui/Section';
import { Segmented } from '../../components/ui/Segmented';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { TaskRow } from './TaskRow';
import { TaskModal } from './TaskModal';

type Filter = 'all' | TaskStatus;
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'Active' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'closed', label: 'Closed' },
];

export function TasksView() {
  const tasks = useTasks();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

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
        title="Tasks"
        icon={ListChecks}
        actions={<Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>New task</Button>}
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="relative max-w-xs flex-1">
            <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks…" className="pl-9" />
          </div>
          <Segmented value={filter} onChange={(v) => setFilter(v as Filter)} options={FILTERS} />
        </div>

        {tasks.isLoading ? <LoadingState />
          : tasks.isError ? <ErrorState message="orca daemon unreachable" onRetry={() => tasks.refetch()} />
          : !tasks.data || tasks.data.length === 0 ? <EmptyState title="No tasks" description="Create one to get started." />
          : filtered.length === 0 ? <EmptyState title="No matches" description="Try a different search or filter." />
          : (
            <div className="flex flex-col divide-y divide-border">
              {filtered.map((t) => <TaskRow key={t.id} task={t} onEdit={setEditing} />)}
            </div>
          )}
      </Section>

      {creating && <TaskModal onClose={() => setCreating(false)} />}
      {editing && <TaskModal task={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
