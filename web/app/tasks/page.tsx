'use client';
import { useTasks } from '../../lib/queries';
import { useCreateTask, useSpawn, useCloseTask, useSetTaskExec } from '../../lib/mutations';
import { taskExec } from '../../lib/taskExec';
import { CreateTaskForm } from '../../components/control/CreateTaskForm';
import { ExecutorPicker } from '../../components/control/ExecutorPicker';
import { TaskExecPicker } from '../../components/control/TaskExecPicker';
import { useToast } from '../../components/ui/Toast';
import { Panel } from '../../components/ui/Panel';
import { PageHeader } from '../../components/ui/PageHeader';
import { Table, THead, TR, TH, TD } from '../../components/ui/Table';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { ModuleShell } from '../../components/shell/ModuleShell';

export default function TasksPage() {
  const tasks = useTasks();
  const create = useCreateTask();
  const spawn = useSpawn();
  const close = useCloseTask();
  const setExec = useSetTaskExec();
  const { toast } = useToast();

  return (
    <ModuleShell moduleId="tasks">
      <Panel>
        <PageHeader title="Tasks" count={tasks.data?.length} />
        <CreateTaskForm onCreate={(v) => create.mutate(v, { onSuccess: () => toast(`Created ${v.title}`), onError: (e) => toast(String(e), 'error') })} />
        {tasks.isLoading ? <LoadingState /> : tasks.isError ? <ErrorState message="orca daemon unreachable" onRetry={() => tasks.refetch()} />
          : tasks.data && tasks.data.length > 0 ? (
            <Table>
              <THead><TR><TH>ID</TH><TH>Title</TH><TH>Status</TH><TH>Actions</TH></TR></THead>
              <tbody>
                {tasks.data.map((t) => (
                  <TR key={t.id}>
                    <TD mono>{t.id}</TD>
                    <TD>{t.title}</TD>
                    <TD><Badge>{t.status}</Badge></TD>
                    <TD>
                      <div className="flex items-center gap-2">
                        <TaskExecPicker value={taskExec(t.labels)} onChange={(exec) => setExec.mutate({ id: t.id, exec }, { onSuccess: () => toast(`Executor set for ${t.id}`), onError: (e) => toast(String(e), 'error') })} />
                        <ExecutorPicker onPick={(exec) => spawn.mutate({ taskId: t.id, exec }, { onSuccess: (r) => toast(`Launched ${r.session}`), onError: (e) => toast(String(e), 'error') })} />
                        <Button onClick={() => close.mutate(t.id, { onSuccess: () => toast(`Closed ${t.id}`), onError: (e) => toast(String(e), 'error') })}>Close</Button>
                      </div>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          ) : <EmptyState title="No tasks" />}
      </Panel>
    </ModuleShell>
  );
}
