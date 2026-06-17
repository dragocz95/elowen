'use client';
export const dynamic = 'force-dynamic';
import { useState } from 'react';
import { KanbanSquare, Columns3, CalendarRange } from 'lucide-react';
import type { Task } from '../../lib/types';
import { useTasks } from '../../lib/queries';
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

export default function KanbanPage() {
  const tasks = useTasks();
  const setStatus = useSetTaskStatus();
  const { toast } = useToast();
  const [view, setView] = useState<'board' | 'calendar'>('board');
  const [editing, setEditing] = useState<Task | null>(null);

  return (
    <ModuleShell moduleId="kanban">
      <div className="flex w-full flex-col gap-6">
        <PageHeader title="Kanban" count={tasks.data?.length} />
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
