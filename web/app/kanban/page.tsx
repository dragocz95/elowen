'use client';
export const dynamic = 'force-dynamic';
import { useState } from 'react';
import { KanbanSquare, Columns3, CalendarRange } from 'lucide-react';
import type { Task } from '../../lib/types';
import { useTasks, useAllDeps } from '../../lib/queries';
import { useSetTaskStatus } from '../../lib/mutations';
import { KanbanBoard } from '../../modules/kanban/KanbanBoard';
import { CalendarView } from '../../modules/kanban/CalendarView';
import { TaskModal } from '../../modules/tasks/TaskModal';
import { PageHeader } from '../../components/ui/PageHeader';
import { Section } from '../../components/ui/Section';
import { Segmented } from '../../components/ui/Segmented';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';

export default function KanbanPage() {
  const tasks = useTasks();
  const deps = useAllDeps();
  const setStatus = useSetTaskStatus();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [view, setView] = useState<'board' | 'calendar'>('board');
  const [editing, setEditing] = useState<Task | null>(null);

  // A task is blocked when any task it depends on is not yet closed/cancelled.
  const statusById = new Map((tasks.data ?? []).map((t) => [t.id, t.status]));
  const blockedIds = new Set(
    (deps.data ?? [])
      .filter((e) => { const s = statusById.get(e.depends_on_id); return s != null && s !== 'closed' && s !== 'cancelled'; })
      .map((e) => e.task_id),
  );

  return (
    <ModuleShell moduleId="kanban">
      <div className="flex w-full flex-col gap-6">
        <PageHeader title={t.page.kanban} count={tasks.data?.length} />
        <Section
          title={view === 'board' ? 'Board' : 'Calendar'}
          icon={KanbanSquare}
          actions={
            <Segmented
              value={view}
              onChange={(v) => setView(v as 'board' | 'calendar')}
              options={[
                { value: 'board', label: 'Board', icon: Columns3 },
                { value: 'calendar', label: 'Calendar', icon: CalendarRange },
              ]}
            />
          }
        >
          {tasks.isLoading ? <LoadingState /> : tasks.isError ? <ErrorState message="orca daemon unreachable" onRetry={() => tasks.refetch()} />
            : view === 'board' ? (
              <KanbanBoard
                tasks={tasks.data ?? []}
                blockedIds={blockedIds}
                onMove={(id, status) => setStatus.mutate({ id, status }, { onError: (e) => toast(String(e), 'error') })}
                onSelect={setEditing}
              />
            ) : (
              <CalendarView tasks={tasks.data ?? []} onSelect={setEditing} />
            )}
        </Section>
      </div>
      {editing && <TaskModal task={editing} onClose={() => setEditing(null)} />}
    </ModuleShell>
  );
}
