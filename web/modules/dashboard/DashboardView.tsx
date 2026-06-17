'use client';
import Link from 'next/link';
import { useTasks, useSessions, useMissions } from '../../lib/queries';
import { deriveDashboardMetrics } from './metrics';
import { statusTone } from './statusTone';
import { StatCard } from '../../components/ui/StatCard';
import { Section } from '../../components/ui/Section';
import { Table, THead, TR, TH, TD } from '../../components/ui/Table';
import { Badge } from '../../components/ui/Badge';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import type { TaskStatus } from '../../lib/types';

const STATUS_BAR_KEYS: Array<{ key: TaskStatus; bg: string }> = [
  { key: 'open', bg: 'bg-accent' },
  { key: 'in_progress', bg: 'bg-accent' },
  { key: 'blocked', bg: 'bg-danger' },
  { key: 'closed', bg: 'bg-elevated' },
  { key: 'cancelled', bg: 'bg-elevated' },
];

export function DashboardView() {
  const tasks = useTasks();
  const sessions = useSessions();
  const missions = useMissions();

  const metrics = deriveDashboardMetrics(tasks.data, sessions.data, missions.data);

  return (
    <>
      {/* Metrics row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard label="Open" value={metrics.open} hint={`of ${metrics.totalTasks} total`} />
        <StatCard label="In progress" value={metrics.inProgress} />
        <StatCard
          label="Blocked"
          value={metrics.blocked}
          tone={metrics.blocked > 0 ? 'danger' : 'default'}
        />
        <StatCard label="Live sessions" value={metrics.liveSessions} />
        <StatCard label="Active missions" value={metrics.activeMissions} />
      </div>

      {/* Tasks section */}
      <Section
        title="Tasks"
        actions={
          <Link href="/tasks" className="font-mono text-xs uppercase text-accent">
            View all
          </Link>
        }
      >
        {tasks.isLoading ? (
          <LoadingState />
        ) : tasks.isError ? (
          <ErrorState message="orca daemon unreachable" onRetry={() => tasks.refetch()} />
        ) : tasks.data && tasks.data.length > 0 ? (
          <>
            {/* Status breakdown bar */}
            <div className="flex h-2 w-full overflow-hidden border border-border mb-3">
              {STATUS_BAR_KEYS.map(({ key, bg }) => {
                const count = metrics.byStatus[key];
                if (count === 0) return null;
                return (
                  <div
                    key={key}
                    className={bg}
                    style={{ flexGrow: count }}
                  />
                );
              })}
            </div>
            <Table>
              <THead>
                <TR>
                  <TH>ID</TH>
                  <TH>Title</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <tbody>
                {tasks.data.map((t) => (
                  <TR key={t.id}>
                    <TD mono>{t.id}</TD>
                    <TD>{t.title}</TD>
                    <TD>
                      <Badge tone={statusTone(t.status)}>{t.status}</Badge>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </>
        ) : (
          <EmptyState title="No tasks" />
        )}
      </Section>

      {/* Sessions section */}
      <Section title="Sessions">
        {sessions.isLoading ? (
          <LoadingState />
        ) : sessions.isError ? (
          <ErrorState message="orca daemon unreachable" onRetry={() => sessions.refetch()} />
        ) : sessions.data && sessions.data.length > 0 ? (
          <ul className="p-3 flex flex-col gap-1">
            {sessions.data.map((s) => (
              <li key={s} className="font-mono text-xs text-text-muted">
                {s}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No live sessions" />
        )}
      </Section>

      {/* Missions section */}
      <Section title="Missions">
        {missions.isLoading ? (
          <LoadingState />
        ) : missions.isError ? (
          <ErrorState message="orca daemon unreachable" onRetry={() => missions.refetch()} />
        ) : missions.data && missions.data.length > 0 ? (
          <Table>
            <THead>
              <TR>
                <TH>ID</TH>
                <TH>State</TH>
              </TR>
            </THead>
            <tbody>
              {missions.data.map((m) => (
                <TR key={m.id}>
                  <TD mono>{m.id}</TD>
                  <TD>
                    <Badge tone={m.state === 'disengaged' ? 'muted' : 'accent'}>{m.state}</Badge>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No active missions" />
        )}
      </Section>
    </>
  );
}
