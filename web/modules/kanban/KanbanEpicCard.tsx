'use client';
import { useState } from 'react';
import { ChevronRight, Trash2 } from 'lucide-react';
import type { Task, TaskStatus } from '../../lib/types';
import { ProgressRibbon } from '../../components/ui/ProgressRibbon';
import { ProjectPill } from '../../components/ui/ProjectPill';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { useDeleteMission } from '../../lib/mutations';
import { taskTypeMeta } from '../tasks/taskMeta';
import { epicProgress, epicLive } from '../../lib/taskTree';
import { useSessions, useSessionSignals } from '../../lib/queries';
import { useDropTarget } from '../tasks/useTaskDrop';
import { useTranslation } from '../../lib/i18n';

/** Collapsible epic (autopilot) container on the board — header with progress + aggregate live
 *  state; its phases stay hidden until expanded so the board isn't flooded with sub-tasks. */
export function KanbanEpicCard({ epic, phases, expanded, onToggle, effectiveStatus, trueStatusLabel, onDropTask, dropTargetValid }: { epic: Task; phases: Task[]; expanded: boolean; onToggle: () => void; effectiveStatus?: TaskStatus; trueStatusLabel?: string; onDropTask?: (e: React.DragEvent) => void; dropTargetValid?: boolean }) {
  const { t } = useTranslation();
  const drop = useDropTarget(onDropTask, dropTargetValid);
  const sessions = useSessions();
  const signals = useSessionSignals();
  const { toast } = useToast();
  const deleteMission = useDeleteMission();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { done, total } = epicProgress(phases);
  const { running, needsInput } = epicLive(phases, sessions.data ?? [], signals);
  const Icon = taskTypeMeta('epic').icon;
  const active = needsInput > 0 || running > 0;
  const dotColor = needsInput > 0 ? 'var(--color-warning)' : running > 0 ? 'var(--color-success)' : 'var(--color-border-strong)';
  const dotRing = needsInput > 0 ? 'color-mix(in srgb, var(--color-warning) 50%, transparent)' : 'color-mix(in srgb, var(--color-success) 50%, transparent)';
  // When an active mission virtualizes the epic into the 'In progress' column, surface the
  // true status (which stays 'open') in a title/tooltip so it's never hidden.
  const virtual = effectiveStatus === 'in_progress' && epic.status !== 'in_progress';
  const titleText = virtual && trueStatusLabel ? t.kanban.trueStatusTooltip.replace('{status}', trueStatusLabel) : undefined;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={`${epic.title} — ${expanded ? t.tasks.collapsePhases : t.tasks.expandPhases}`}
      title={titleText}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      onDragOver={drop.onDragOver}
      onDragEnter={drop.onDragEnter}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      className={`group flex cursor-pointer flex-col gap-2 rounded-md border border-accent/30 bg-accent/[0.04] p-2.5 transition-colors hover:border-accent/50 ${drop.dragOver && dropTargetValid ? 'ring-2 ring-accent/60' : ''} ${drop.dragOver && dropTargetValid === false ? 'ring-2 ring-danger/40 opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2">
        <ChevronRight size={14} className={`shrink-0 text-text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden />
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-elevated"><Icon size={15} className="text-accent" aria-hidden /></span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{epic.title}</span>
        {virtual ? <span className="shrink-0 rounded border border-accent/40 px-1 font-mono text-[10px] uppercase tracking-wide text-accent" aria-hidden>{trueStatusLabel}</span> : null}
        {active ? <span className={`h-2 w-2 shrink-0 rounded-full ${active ? 'live-dot' : ''}`} style={{ backgroundColor: dotColor, ['--live-ring' as string]: dotRing }} aria-hidden /> : null}
        <div className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" onClick={(e) => e.stopPropagation()}>
          <ActionMenu
            label={t.tasks.deleteMission}
            items={[{ label: t.tasks.deleteMission, icon: Trash2, tone: 'danger', onSelect: () => setConfirmDelete(true) }]}
          />
        </div>
      </div>
      <div className="flex items-center gap-2 pl-6">
        <ProgressRibbon phases={phases} className="flex-1" />
        <span className="shrink-0 font-mono text-[11px] text-text-muted">{done}/{total}</span>
      </div>
      {epic.project_id != null ? <div className="flex pl-6"><ProjectPill projectId={epic.project_id} /></div> : null}

      {confirmDelete && (
        <div onClick={(e) => e.stopPropagation()}>
          <ConfirmDialog
            open={confirmDelete}
            title={t.tasks.confirmDeleteMissionTitle.replace('{id}', epic.id)}
            description={t.tasks.confirmDeleteMissionDescription}
            confirmLabel={t.tasks.deleteMission}
            onClose={() => setConfirmDelete(false)}
            onConfirm={() => { setConfirmDelete(false); deleteMission.mutate(epic.id, { onSuccess: () => toast(t.tasks.missionDeleted.replace('{id}', epic.id)), onError: (e) => toast(String(e), 'error') }); }}
          />
        </div>
      )}
    </div>
  );
}
