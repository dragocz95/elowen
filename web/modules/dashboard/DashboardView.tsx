'use client';
import Link from 'next/link';
import { ListChecks, Terminal, Rocket, ArrowRight } from 'lucide-react';
import { useTasks, useSessions, useMissions } from '../../lib/queries';
import { deriveDashboardMetrics } from './metrics';
import { statusTone } from './statusTone';
import { StatCard } from '../../components/ui/StatCard';
import { Section } from '../../components/ui/Section';
import { Table, THead, TR, TH, TD } from '../../components/ui/Table';
import { Badge } from '../../components/ui/Badge';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { ActivityTicker } from './ActivityTicker';
import { taskTypeMeta } from '../tasks/taskMeta';
import type { TaskStatus } from '../../lib/types';

const STATUS_BAR_KEYS: Array<{ key: TaskStatus; bg: string }> = [
  { key: 'open', bg: 'bg-accent' },
  { key: 'in_progress', bg: 'bg-accent' },
  { key: 'blocked', bg: 'bg-danger' },
  { key: 'closed', bg: 'bg-elevated' },
  { key: 'cancelled', bg: 'bg-elevated' },
];

function ViewAll({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1.5 text-xs font-medium text-accent transition-colors hover:opacity-80">
      {label}
      <ArrowRight size={13} aria-hidden />
    </Link>
  );
}

export function DashboardView() {
  const { t } = useTranslation();
  const tasks = useTasks();
  const sessions = useSessions();
  const missions = useMissions();

  const metrics = deriveDashboardMetrics(tasks.data, sessions.data, missions.data);
  const TASK_STATUS_LABEL: Record<string, string> = { open: t.tasks.statusOpen, in_progress: t.tasks.statusInProgress, blocked: t.tasks.statusBlocked, closed: t.tasks.statusClosed, cancelled: t.tasks.statusCancelled };
  const MISSION_STATE_LABEL: Record<string, string> = { active: t.missions.stateActive, paused: t.missions.paused, disengaged: t.missions.stateDisengaged };

  return (
    <div className="flex w-full flex-col gap-6">
      <ActivityTicker />

      {/* Metrics row */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        <StatCard label={t.dashboard.open} value={metrics.open} hint={t.dashboard.ofTotal.replace('{count}', String(metrics.totalTasks))} />
        <StatCard label={t.dashboard.inProgress} value={metrics.inProgress} />
        <StatCard
          label={t.dashboard.blocked}
          value={metrics.blocked}
          tone={metrics.blocked > 0 ? 'danger' : 'default'}
        />
        <StatCard label={t.dashboard.liveSessions} value={metrics.liveSessions} />
        <StatCard label={t.dashboard.activeMissions} value={metrics.activeMissions} />
      </div>

      {/* Tasks section */}
      <Section title={t.page.tasks} icon={ListChecks} actions={<ViewAll href="/tasks" label={t.dashboard.viewAll} />}>
        {tasks.isLoading ? (
          <LoadingState />
        ) : tasks.isError ? (
          <ErrorState message={t.common.daemonUnreachable} onRetry={() => tasks.refetch()} />
        ) : tasks.data && tasks.data.length > 0 ? (
          <div className="flex flex-col gap-3">
            {/* Status breakdown bar */}
            <div className="flex h-2 w-full overflow-hidden rounded-full border border-border">
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
                  <TH aria-label="Type" />
                  <TH>{t.dashboard.titleCol}</TH>
                  <TH>{t.dashboard.statusCol}</TH>
                </TR>
              </THead>
              <tbody>
                {tasks.data.slice(0, 8).map((t) => {
                  const Icon = taskTypeMeta(t.type).icon;
                  return (
                    <TR key={t.id}>
                      <TD><Icon size={14} className="text-text-muted" aria-hidden /></TD>
                      <TD>{t.title}</TD>
                      <TD>
                        <Badge tone={statusTone(t.status)}>{TASK_STATUS_LABEL[t.status] ?? t.status}</Badge>
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          </div>
        ) : (
          <EmptyState title={t.tasks.empty} />
        )}
      </Section>

      {/* Sessions section */}
      <Section title={t.page.sessions} icon={Terminal} actions={<ViewAll href="/sessions" label={t.dashboard.viewAll} />}>
        {sessions.isLoading ? (
          <LoadingState />
        ) : sessions.isError ? (
          <ErrorState message={t.common.daemonUnreachable} onRetry={() => sessions.refetch()} />
        ) : sessions.data && sessions.data.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sessions.data.map((s) => (
              <div key={s} className="flex items-center gap-2.5 rounded-md border border-border bg-bg px-3 py-2.5">
                <Terminal size={14} className="shrink-0 text-text-muted" aria-hidden />
                <span className="truncate font-mono text-xs text-text">{s}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title={t.sessions.empty} />
        )}
      </Section>

      {/* Missions section */}
      <Section title={t.page.missions} icon={Rocket} actions={<ViewAll href="/missions" label={t.dashboard.viewAll} />}>
        {missions.isLoading ? (
          <LoadingState />
        ) : missions.isError ? (
          <ErrorState message={t.common.daemonUnreachable} onRetry={() => missions.refetch()} />
        ) : missions.data && missions.data.length > 0 ? (
          <Table>
            <THead>
              <TR>
                <TH>{t.dashboard.epicCol}</TH>
                <TH>{t.dashboard.progressCol}</TH>
                <TH>{t.dashboard.stateCol}</TH>
              </TR>
            </THead>
            <tbody>
              {missions.data.map((m) => {
                const epic = tasks.data?.find((t) => t.id === m.epic_id);
                const kids = (tasks.data ?? []).filter((t) => t.parent_id === m.epic_id);
                const done = kids.filter((t) => t.status === 'closed' || t.status === 'cancelled').length;
                return (
                  <TR key={m.id}>
                    <TD>{epic?.title ?? m.epic_id}</TD>
                    <TD mono>{done}/{kids.length}</TD>
                    <TD>
                      <Badge tone={m.state === 'disengaged' ? 'muted' : 'accent'}>{MISSION_STATE_LABEL[m.state] ?? m.state}</Badge>
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <EmptyState title={t.missions.empty} />
        )}
      </Section>
    </div>
  );
}
