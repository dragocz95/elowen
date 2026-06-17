'use client';
import { useMissions } from '../../lib/queries';
import { useEngage, usePauseMission, useResumeMission, useDisengage } from '../../lib/mutations';
import { EngageForm } from '../../components/control/EngageForm';
import { useToast } from '../../components/ui/Toast';
import { Panel } from '../../components/ui/Panel';
import { PageHeader } from '../../components/ui/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { ModuleShell } from '../../components/shell/ModuleShell';

export default function MissionsPage() {
  const missions = useMissions();
  const engage = useEngage();
  const pause = usePauseMission();
  const resume = useResumeMission();
  const disengage = useDisengage();
  const { toast } = useToast();

  return (
    <ModuleShell moduleId="missions">
      <Panel>
        <PageHeader title="Missions" count={missions.data?.length} />
        <EngageForm onEngage={(v) => engage.mutate(v, { onSuccess: () => toast(`Engaged ${v.epicId}`), onError: (e) => toast(String(e), 'error') })} />
        {missions.isLoading ? <LoadingState /> : missions.isError ? <ErrorState message="orca daemon unreachable" onRetry={() => missions.refetch()} />
          : missions.data && missions.data.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border">
              {missions.data.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="font-mono text-xs text-text-muted">{m.id} · {m.epic_id}</span>
                  <div className="flex items-center gap-2">
                    <Badge tone="accent">{m.autonomy}</Badge>
                    <Button onClick={() => pause.mutate(m.id, { onSuccess: () => toast(`Paused ${m.id}`), onError: (e) => toast(String(e), 'error') })}>Pause</Button>
                    <Button onClick={() => resume.mutate(m.id, { onSuccess: () => toast(`Resumed ${m.id}`), onError: (e) => toast(String(e), 'error') })}>Resume</Button>
                    <Button variant="danger" onClick={() => disengage.mutate(m.id, { onSuccess: () => toast(`Disengaged ${m.id}`), onError: (e) => toast(String(e), 'error') })}>Disengage</Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="No active missions" />}
      </Panel>
    </ModuleShell>
  );
}
