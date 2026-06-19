'use client';
import { Pause, Play, Power, CheckCircle2 } from 'lucide-react';
import type { Mission } from '../../lib/types';
import { useTasks, useSessions, useSessionSignals } from '../../lib/queries';
import { usePauseMission, useResumeMission, useDisengage } from '../../lib/mutations';
import { taskSessionName } from '../../lib/agentUtils';
import { epicCapacity } from '../../lib/taskTree';
import { Badge } from '../../components/ui/Badge';
import { IconButton } from '../../components/ui/IconButton';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { ProgressRibbon } from '../../components/ui/ProgressRibbon';
import { CapacityMeter } from '../../components/ui/CapacityMeter';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';

// Missions ordered active → paused → disengaged for the top bar.
const RANK: Record<string, number> = { active: 0, paused: 1, disengaged: 2 };

/** Live children count + how many await input. */
function missionLive(kids: { id: string; status: string; labels?: string[] }[], signals: Record<string, { type: string }>) {
  const live = kids.filter((k) => k.status === 'in_progress');
  const needs = live.filter((k) => { const s = taskSessionName(k); return s ? signals[s]?.type === 'needs_input' : false; }).length;
  return { live: live.length, needs };
}

/** Horizontal bar of mission cards across the top of the Missions page — replaces the old left
 *  sidebar so the workspace below can run full-width. Cards wrap (no horizontal scroll). */
export function ActiveMissionsBar({ missions, selectedId, onSelect }: { missions: Mission[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const tasks = useTasks();
  const sessions = useSessions();
  const signals = useSessionSignals();
  const pause = usePauseMission();
  const resume = useResumeMission();
  const disengage = useDisengage();
  const { toast } = useToast();
  const { t } = useTranslation();

  const epicTitle = (epicId: string) => tasks.data?.find((task) => task.id === epicId)?.title ?? epicId;
  const ordered = [...missions].sort((a, b) => (RANK[a.state] ?? 0) - (RANK[b.state] ?? 0));

  return (
    <div className="flex flex-wrap gap-3">
      {ordered.map((m) => {
        const kids = (tasks.data ?? []).filter((task) => task.parent_id === m.epic_id);
        const done = kids.filter((task) => task.status === 'closed' || task.status === 'cancelled').length;
        const paused = m.state === 'paused';
        const disengaged = m.state === 'disengaged';
        const stalled = m.state === 'stalled';
        const isActive = selectedId === m.id;
        const { live, needs } = missionLive(kids, signals);
        const cap = epicCapacity(kids, sessions.data ?? [], m.max_sessions);
        return (
          <div
            key={m.id}
            role="button"
            tabIndex={0}
            aria-pressed={isActive}
            onClick={() => onSelect(m.id)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSelect(m.id); }}
            className={`group flex w-full cursor-pointer flex-col gap-2 rounded-lg border p-3 transition-colors sm:w-[300px] ${isActive ? 'border-accent bg-accent/[0.06]' : 'border-border bg-surface hover:bg-elevated/50'}`}
            style={{ transitionDuration: 'var(--motion-fast)' }}
          >
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{epicTitle(m.epic_id)}</span>
              <Badge tone={disengaged ? 'muted' : (paused || stalled) ? 'warning' : 'accent'}>{disengaged ? t.missions.stateDisengaged : paused ? t.missions.statePaused : stalled ? t.missions.stateStalled : m.autonomy}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <ProgressRibbon phases={kids} className="flex-1" />
              <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-text-muted"><CheckCircle2 size={11} className="shrink-0 text-text-muted" aria-hidden />{t.missions.progressDone.replace('{done}', String(done)).replace('{total}', String(kids.length))}</span>
            </div>
            <div className="flex items-center gap-2.5">
              {!disengaged ? <CapacityMeter running={cap.running} max={cap.max} /> : null}
              {needs > 0 ? <span className="flex items-center gap-1 text-[11px] font-medium text-warning" title={t.agent.needsInput}><span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />{needs}</span> : null}
              {live > 0 ? <span className="flex items-center gap-1 text-[11px] font-medium text-success" title={t.agent.working}><span className="live-dot h-1.5 w-1.5 rounded-full bg-success" style={{ ['--live-ring' as string]: 'color-mix(in srgb, var(--color-success) 50%, transparent)' }} aria-hidden />{live}</span> : null}
              <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                {!disengaged ? (paused
                  ? <IconButton icon={Play} label={t.missions.resume} onClick={() => resume.mutate(m.id, { onSuccess: () => toast(t.missions.resumed), onError: (e) => toast(String(e), 'error') })} />
                  : <IconButton icon={Pause} label={t.missions.pause} onClick={() => pause.mutate(m.id, { onSuccess: () => toast(t.missions.pausedMsg), onError: (e) => toast(String(e), 'error') })} />) : null}
                <ActionMenu label={t.missions.disengage} items={[{ label: t.missions.disengage, icon: Power, tone: 'danger', onSelect: () => disengage.mutate(m.id, { onSuccess: () => toast(t.missions.disengaged), onError: (e) => toast(String(e), 'error') }) }]} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
