'use client';
export const dynamic = 'force-dynamic';
import { useTasks, useSessions, useMissions } from '../../lib/queries';
import { Panel } from '../../components/ui/Panel';
import { PageHeader } from '../../components/ui/PageHeader';
import { Table, THead, TR, TH, TD } from '../../components/ui/Table';
import { Badge } from '../../components/ui/Badge';
import { EmptyState, LoadingState, ErrorState } from '../../components/ui/states';
import { ModuleShell } from '../../components/shell/ModuleShell';

export default function DashPage() {
  const tasks = useTasks();
  const sessions = useSessions();
  const missions = useMissions();

  return (
    <ModuleShell moduleId="dashboard">
      <Panel>
        <PageHeader title="Tasks" count={tasks.data?.length} />
        {tasks.isLoading ? <LoadingState /> : tasks.isError ? <ErrorState message="orca daemon unreachable" onRetry={() => tasks.refetch()} />
          : tasks.data && tasks.data.length > 0 ? (
            <Table>
              <THead><TR><TH>ID</TH><TH>Title</TH><TH>Status</TH></TR></THead>
              <tbody>
                {tasks.data.map((t) => (
                  <TR key={t.id}><TD mono>{t.id}</TD><TD>{t.title}</TD><TD><Badge>{t.status}</Badge></TD></TR>
                ))}
              </tbody>
            </Table>
          ) : <EmptyState title="No open tasks" />}
      </Panel>

      <Panel>
        <PageHeader title="Sessions" count={sessions.data?.length} />
        {sessions.isLoading ? <LoadingState /> : sessions.isError ? <ErrorState message="orca daemon unreachable" onRetry={() => sessions.refetch()} />
          : sessions.data && sessions.data.length > 0 ? (
            <ul className="p-3 flex flex-col gap-1">
              {sessions.data.map((s) => <li key={s} className="font-mono text-xs text-text-muted">{s}</li>)}
            </ul>
          ) : <EmptyState title="No live sessions" />}
      </Panel>

      <Panel>
        <PageHeader title="Missions" count={missions.data?.length} />
        {missions.isLoading ? <LoadingState /> : missions.isError ? <ErrorState message="orca daemon unreachable" onRetry={() => missions.refetch()} />
          : missions.data && missions.data.length > 0 ? (
            <ul className="p-3 flex flex-col gap-1">
              {missions.data.map((m) => <li key={m.id} className="font-mono text-xs text-text-muted">{m.id} · {m.state}</li>)}
            </ul>
          ) : <EmptyState title="No active missions" />}
      </Panel>
    </ModuleShell>
  );
}
