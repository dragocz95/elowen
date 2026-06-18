'use client';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Rocket, Plus, Pause, Play, Power, Layers } from 'lucide-react';
import { useMissions, useTasks } from '../../lib/queries';
import { usePauseMission, useResumeMission, useDisengage } from '../../lib/mutations';
import { Section } from '../../components/ui/Section';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { IconButton } from '../../components/ui/IconButton';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { Modal } from '../../components/ui/Modal';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { MissionProgressView } from './MissionProgressView';
import { EngageModal } from './EngageModal';

export function MissionsView() {
  const missions = useMissions();
  const tasks = useTasks();
  const pause = usePauseMission();
  const resume = useResumeMission();
  const disengage = useDisengage();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [engaging, setEngaging] = useState(false);

  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => { if (params.get('new') === '1') { setEngaging(true); router.replace('/missions'); } }, [params, router]);

  const epicTitle = (epicId: string) => tasks.data?.find((t) => t.id === epicId)?.title ?? epicId;
  const progressFor = (epicId: string) => {
    const kids = (tasks.data ?? []).filter((t) => t.parent_id === epicId);
    const done = kids.filter((t) => t.status === 'closed' || t.status === 'cancelled').length;
    return { done, total: kids.length };
  };

  return (
    <>
      <Section
        title={t.page.missions}
        icon={Rocket}
        actions={<Button variant="accent" icon={Plus} onClick={() => setEngaging(true)}>{t.missions.newMission}</Button>}
      >
        {missions.isLoading ? <LoadingState />
          : missions.isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={() => missions.refetch()} />
          : missions.data && missions.data.length > 0 ? (
            <div className="flex flex-col divide-y divide-border">
              {missions.data.map((m) => {
                const { done, total } = progressFor(m.epic_id);
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                const paused = m.state === 'paused';
                return (
                  <div
                    key={m.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setDetailId(m.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') setDetailId(m.id); }}
                    className="group -mx-2 flex cursor-pointer items-center gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-elevated/50"
                  >
                    <Layers size={16} className="shrink-0 text-text-muted" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-text">{epicTitle(m.epic_id)}</span>
                        <Badge tone="accent">{m.autonomy}</Badge>
                        {paused ? <Badge tone="muted">{t.missions.paused}</Badge> : null}
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="h-1.5 w-32 overflow-hidden rounded-full bg-elevated">
                          <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%`, transitionTimingFunction: 'var(--ease-out)' }} />
                        </div>
                        <span className="font-mono text-[11px] text-text-muted">{t.missions.progressDone.replace('{done}', String(done)).replace('{total}', String(total))}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                      {paused
                        ? <IconButton icon={Play} label={t.missions.resume} onClick={() => resume.mutate(m.id, { onSuccess: () => toast(t.missions.resumed), onError: (e) => toast(String(e), 'error') })} />
                        : <IconButton icon={Pause} label={t.missions.pause} onClick={() => pause.mutate(m.id, { onSuccess: () => toast(t.missions.pausedMsg), onError: (e) => toast(String(e), 'error') })} />}
                      <ActionMenu
                        label={t.missions.disengage}
                        items={[{ label: t.missions.disengage, icon: Power, tone: 'danger', onSelect: () => disengage.mutate(m.id, { onSuccess: () => toast(t.missions.disengaged), onError: (e) => toast(String(e), 'error') }) }]}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : <EmptyState title={t.missions.empty} description={t.missions.emptyDescription} />}
      </Section>

      {engaging && <EngageModal onClose={() => setEngaging(false)} />}
      {detailId && (
        <Modal title={t.missions.modalTitle.replace('{title}', epicTitle(missions.data?.find((m) => m.id === detailId)?.epic_id ?? ''))} onClose={() => setDetailId(null)}>
          <MissionProgressView missionId={detailId} />
        </Modal>
      )}
    </>
  );
}
