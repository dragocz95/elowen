'use client';
export const dynamic = 'force-dynamic';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { TasksView } from '../../modules/tasks/TasksView';

export default function TasksPage() {
  return (
    <ModuleShell moduleId="tasks">
      <TasksView />
    </ModuleShell>
  );
}
