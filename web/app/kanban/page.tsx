'use client';
export const dynamic = 'force-dynamic';
import { useState } from 'react';
import { KanbanSquare, Columns3, CalendarRange } from 'lucide-react';
import type { Task } from '../../lib/types';
import { useTasks, useAllDeps } from '../../lib/queries';
import { useSetTaskStatus, useUpdateTask } from '../../lib/mutations';
import { KanbanBoard } from '../../modules/kanban/KanbanBoard';
import { CalendarView } from '../../modules/kanban/CalendarView';
import { TaskModal } from '../../modules/tasks/TaskModal';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Segmented } from '../../components/ui/Segmented';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';

export default function KanbanPage() {
  const tasks = useTasks();
  const deps = useAllDeps();
  const setStatus = useSetTaskStatus();
  const updateTask = useUpdateTask();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [view, setView] = useState<'board' | 'calendar'>('board');
  const [editing, setEditing] = useState<Task | null>(null);
  const [createSchedule, setCreateSchedule] = useState<string | null>(null);

  // A task is blocked when any task it depends on is not yet closed/cancelled.
  const statusById = new Map((tasks.data ?? []).map((t) => [t.id, t.status]));
  const blockedIds = new Set(
    (deps.data ?? [])
      .filter((e) => { const s = statusById.get(e.depends_on_id); return s != null && s !== 'closed' && s !== 'cancelled'; })
      .map((e) => e.task_id),
  );

  return (
    <ModuleShell moduleId="kanban">
      <ModuleHeader title={t.page.kanban} count={tasks.data?.length} icon={KanbanSquare}>
        <Segmented
          value={view}
          onChange={(v) => setView(v as 'board' | 'calendar')}
          options={[
            { value: 'board', label: t.kanban.board, icon: Columns3 },
            { value: 'calendar', label: t.kanban.calendar, icon: CalendarRange },
          ]}
        />
      </ModuleHeader>

      {tasks.isLoading ? <LoadingState variant={view === 'board' ? 'kanban' : 'cards'} /> : tasks.isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={() => tasks.refetch()} />
        : view === 'board' ? (
          <KanbanBoard
            tasks={tasks.data ?? []}
            blockedIds={blockedIds}
            onMove={(id, status) => setStatus.mutate({ id, status }, { onError: (e) => toast(String(e), 'error') })}
            onSelect={setEditing}
          />
        ) : (
          <CalendarView
            tasks={tasks.data ?? []}
            onSelect={setEditing}
            onCreateDay={(d) => { const dt = new Date(d); dt.setHours(9, 0, 0, 0); setCreateSchedule(dt.toISOString()); }}
            onReschedule={(id, day) => {
              const task = (tasks.data ?? []).find((x) => x.id === id);
              const prev = task?.scheduled_at ? new Date(task.scheduled_at) : null;
              const dt = new Date(day);
              dt.setHours(prev ? prev.getHours() : 9, prev ? prev.getMinutes() : 0, 0, 0);
              updateTask.mutate({ id, patch: { scheduled_at: dt.toISOString() } }, { onError: (e) => toast(String(e), 'error') });
            }}
          />
        )}
      {editing && <TaskModal task={editing} onClose={() => setEditing(null)} />}
      {createSchedule && <TaskModal initialSchedule={createSchedule} onClose={() => setCreateSchedule(null)} />}
    </ModuleShell>
  );
}
