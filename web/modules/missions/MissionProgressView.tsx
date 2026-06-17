'use client';
import { useMissionDetail } from '../../lib/queries';
import { layoutPhases } from './layoutPhases';
import { statusTone } from '../dashboard/statusTone';
import { Section } from '../../components/ui/Section';
import { StatCard } from '../../components/ui/StatCard';
import { Badge } from '../../components/ui/Badge';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';

export function MissionProgressView({ missionId }: { missionId: string }) {
  const detail = useMissionDetail(missionId);

  if (detail.isLoading) return <LoadingState />;
  if (detail.isError) return <ErrorState message="orca daemon unreachable" onRetry={() => detail.refetch()} />;
  if (!detail.data) return null;

  const d = detail.data;
  const phases = layoutPhases(d.tasks, d.deps);

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto h-full">
      <Section
        title={d.epic?.title ?? d.mission.epic_id}
        actions={
          <Badge tone={d.mission.state === 'disengaged' ? 'muted' : 'accent'}>
            {d.mission.state}
          </Badge>
        }
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-3">
          <StatCard label="Total" value={d.progress.total} />
          <StatCard label="Done" value={d.progress.closed} />
          <StatCard label="In progress" value={d.progress.inProgress} />
          <StatCard
            label="Blocked"
            value={d.progress.blocked}
            tone={d.progress.blocked > 0 ? 'danger' : 'default'}
          />
        </div>
      </Section>

      {phases.length === 0 ? (
        <EmptyState title="No tasks in this mission" />
      ) : (
        <div className="flex gap-3 overflow-x-auto">
          {phases.map((tasks, i) => (
            <div key={i} className="flex flex-col gap-2 min-w-[12rem]">
              <span className="text-xs font-mono text-text-muted uppercase">Phase {i + 1}</span>
              {tasks.map((task) => (
                <div
                  key={task.id}
                  className="border border-border bg-surface p-2 flex flex-col gap-1"
                >
                  <span className="text-sm text-text">{task.title}</span>
                  <Badge tone={statusTone(task.status)}>{task.status}</Badge>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
