'use client';
import { Rocket, ArrowRight } from 'lucide-react';
import { useMissionDetail } from '../../lib/queries';
import { layoutPhases } from './layoutPhases';
import { Section } from '../../components/ui/Section';
import { StatCard } from '../../components/ui/StatCard';
import { Badge } from '../../components/ui/Badge';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';

const STATUS_DOT: Record<string, string> = {
  closed: '#22c55e', in_progress: '#3b82f6', blocked: '#ef4444', cancelled: '#6b7280', open: '#6b7280',
};

export function MissionProgressView({ missionId }: { missionId: string }) {
  const detail = useMissionDetail(missionId);
  const { t } = useTranslation();

  if (detail.isLoading) return <LoadingState />;
  if (detail.isError) return <ErrorState message={t.common.daemonUnreachable} onRetry={() => detail.refetch()} />;
  if (!detail.data) return null;

  const d = detail.data;
  const phases = layoutPhases(d.tasks, d.deps);
  const STATUS_LABEL: Record<string, string> = { open: t.tasks.statusOpen, in_progress: t.tasks.statusInProgress, blocked: t.tasks.statusBlocked, closed: t.tasks.statusClosed, cancelled: t.tasks.statusCancelled };
  const STATE_LABEL: Record<string, string> = { active: t.missions.stateActive, paused: t.missions.paused, disengaged: t.missions.stateDisengaged };

  return (
    <div className="flex h-full w-full flex-col gap-6 overflow-y-auto p-4">
      <Section
        title={d.epic?.title ?? d.mission.epic_id}
        icon={Rocket}
        actions={
          <Badge tone={d.mission.state === 'disengaged' ? 'muted' : 'accent'}>
            {STATE_LABEL[d.mission.state] ?? d.mission.state}
          </Badge>
        }
      >
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard label={t.missions.total} value={d.progress.total} />
          <StatCard label={t.missions.done} value={d.progress.closed} />
          <StatCard label={t.missions.inProgress} value={d.progress.inProgress} />
          <StatCard
            label={t.missions.blocked}
            value={d.progress.blocked}
            tone={d.progress.blocked > 0 ? 'danger' : 'default'}
          />
        </div>
      </Section>

      <Section title={t.missions.taskFlow}>
        {phases.length === 0 ? (
          <EmptyState title={t.missions.noTasks} />
        ) : (
          <div className="flex items-start gap-2 overflow-x-auto">
            {phases.map((tasks, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="flex min-w-[13rem] flex-col gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{t.missions.phaseN.replace('{n}', String(i + 1))}</span>
                  {tasks.map((task) => {
                    const running = task.status === 'in_progress';
                    const c = STATUS_DOT[task.status] ?? '#6b7280';
                    return (
                      <div key={task.id} className={`flex items-start gap-2.5 rounded-md border bg-bg p-3 ${running ? 'border-accent' : 'border-border'}`}>
                        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${running ? 'live-dot' : ''}`} style={{ backgroundColor: c, ['--live-ring' as string]: 'rgba(59,130,246,0.5)' }} aria-hidden />
                        <div className="min-w-0 flex-1">
                          <span className="block text-sm text-text">{task.title}</span>
                          <span className="text-[11px] capitalize text-text-muted">{STATUS_LABEL[task.status] ?? task.status.replace('_', ' ')}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {i < phases.length - 1 ? <ArrowRight size={16} className="mt-7 shrink-0 text-text-muted" aria-hidden /> : null}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
