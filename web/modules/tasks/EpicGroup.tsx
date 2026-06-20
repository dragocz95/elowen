'use client';
import { useState } from 'react';
import { ChevronRight, Trash2 } from 'lucide-react';
import type { Task } from '../../lib/types';
import { Badge } from '../../components/ui/Badge';
import { ProgressRibbon } from '../../components/ui/ProgressRibbon';
import { ProjectPill } from '../../components/ui/ProjectPill';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { useDeleteMission } from '../../lib/mutations';
import { TaskCard } from './TaskCard';
import { taskTypeMeta, statusLabel } from './taskMeta';
import { statusTone } from '../dashboard/statusTone';
import { epicProgress, epicLive } from '../../lib/taskTree';
import { useSessions, useSessionSignals } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';

/** An autopilot epic in the task list: a collapsible parent whose phases stay tucked away
 *  (collapsed) until expanded, so the list shows the epic rather than every sub-task. */
export function EpicGroup({ epic, phases, effectiveStatus, expanded, onToggle, onEdit, onSelect, activeId, blockedBy }: {
  epic: Task;
  phases: Task[];
  effectiveStatus?: Task['status'];
  expanded: boolean;
  onToggle: () => void;
  onEdit: (t: Task) => void;
  onSelect: (t: Task) => void;
  activeId: string | null;
  blockedBy: Map<string, Task[]>;
}) {
  const { t } = useTranslation();
  const sessions = useSessions();
  const signals = useSessionSignals();
  const { toast } = useToast();
  const deleteMission = useDeleteMission();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { done, total } = epicProgress(phases);
  const { running, needsInput } = epicLive(phases, sessions.data ?? [], signals);
  const Icon = taskTypeMeta('epic').icon;
  const active = needsInput > 0 || running > 0;
  const dotColor = needsInput > 0 ? 'var(--color-warning)' : 'var(--color-success)';
  const dotRing = needsInput > 0 ? 'color-mix(in srgb, var(--color-warning) 50%, transparent)' : 'color-mix(in srgb, var(--color-success) 50%, transparent)';

  return (
    <div className="group/epic overflow-hidden rounded-lg border border-accent/30 bg-accent/[0.04]">
      <div className="relative flex items-stretch">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-accent/[0.06]"
        >
          <ChevronRight size={16} className={`shrink-0 text-text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden />
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated"><Icon size={20} className="text-accent" aria-hidden /></span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{epic.title}</span>
              {active ? <span className="live-dot h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor, ['--live-ring' as string]: dotRing }} aria-hidden /> : null}
            </div>
            <div className="flex items-center gap-2">
              <ProgressRibbon phases={phases} className="max-w-[12rem] flex-1" />
              <span className="shrink-0 font-mono text-[11px] text-text-muted">{done}/{total} {t.tasks.phasesLabel}</span>
              <ProjectPill projectId={epic.project_id} />
            </div>
          </div>
          <Badge tone={statusTone(effectiveStatus ?? epic.status)}>{statusLabel(t, effectiveStatus ?? epic.status)}</Badge>
        </button>
        <div className="flex items-center pr-3 opacity-0 transition-opacity group-hover/epic:opacity-100">
          <ActionMenu
            label={t.tasks.deleteMission}
            items={[{ label: t.tasks.deleteMission, icon: Trash2, tone: 'danger', onSelect: () => setConfirmDelete(true) }]}
          />
        </div>
      </div>

      {expanded ? (
        <div className="flex flex-col gap-2.5 border-t border-accent/20 bg-bg/30 p-2.5 pl-5">
          {phases.map((p) => (
            <TaskCard key={p.id} task={p} onEdit={onEdit} onSelect={onSelect} active={activeId === p.id} blockers={blockedBy.get(p.id)} />
          ))}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        title={t.tasks.confirmDeleteMissionTitle.replace('{id}', epic.id)}
        description={t.tasks.confirmDeleteMissionDescription}
        confirmLabel={t.tasks.deleteMission}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => { setConfirmDelete(false); deleteMission.mutate(epic.id, { onSuccess: () => toast(t.tasks.missionDeleted.replace('{id}', epic.id)), onError: (e) => toast(String(e), 'error') }); }}
      />
    </div>
  );
}
