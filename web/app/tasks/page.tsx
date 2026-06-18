'use client';
export const dynamic = 'force-dynamic';
import { useTasks } from '../../lib/queries';
import { PageHeader } from '../../components/ui/PageHeader';
import { useTranslation } from '../../lib/i18n';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { TasksView } from '../../modules/tasks/TasksView';

export default function TasksPage() {
  const tasks = useTasks();
  const { t } = useTranslation();
  return (
    <ModuleShell moduleId="tasks">
      <div className="flex w-full flex-col gap-6">
        <PageHeader title={t.page.tasks} count={tasks.data?.length} />
        <TasksView />
      </div>
    </ModuleShell>
  );
}
