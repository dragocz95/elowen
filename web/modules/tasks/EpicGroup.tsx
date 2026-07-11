'use client';
import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ChevronRight, Trash2, Play, Pause, Power, Rocket, Plus, Coins, GitPullRequest, GitMerge, Wrench } from 'lucide-react';
import type { Task } from '../../lib/types';
import { Badge } from '../../components/ui/Badge';
import { ProgressRibbon } from '../../components/ui/ProgressRibbon';
import { ProjectPill } from '../../components/ui/ProjectPill';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { elowenClient } from '../../lib/elowenClient';
import { useDeleteMission, useEngage, usePauseMission, useResumeMission, useDisengage, useOpenMissionPr, useMergeMissionPr } from '../../lib/mutations';
import { useSessions, useSessionSignals, useMissions, useConfig } from '../../lib/queries';
import { TaskCard } from './TaskCard';
import { useDropTarget } from './useTaskDrop';
import { AddPhaseModal } from './AddPhaseModal';
import { taskTypeMeta, statusLabel } from './taskMeta';
import { statusTone } from '../dashboard/statusTone';
import { epicProgress, epicLive } from '../../lib/taskTree';
import { formatCost } from '../../lib/format';
import { useTranslation } from '../../lib/i18n';

/** An autopilot epic in the task list: a collapsible parent whose phases stay tucked away
 *  (collapsed) until expanded, so the list shows the epic rather than every sub-task. The epic IS
 *  the mission — its lifecycle (engage / pause / resume / disengage) and rolled-up cost are driven
 *  right here, so there's no separate Missions page. */
export function EpicGroup({ epic, phases, effectiveStatus, expanded, onToggle, onEdit, onSelect, onContextMenu, activeId, blockedBy, onDropTask, dropTargetValid }: {
  epic: Task;
  phases: Task[];
  effectiveStatus?: Task['status'];
  expanded: boolean;
  onToggle: () => void;
  onEdit: (t: Task) => void;
  onSelect: (t: Task) => void;
  onContextMenu?: (e: React.MouseEvent, t: Task) => void;
  activeId: string | null;
  blockedBy: Map<string, Task[]>;
  onDropTask?: (e: React.DragEvent) => void;
  dropTargetValid?: boolean;
}) {
  const { t } = useTranslation();
  const drop = useDropTarget(onDropTask, dropTargetValid);
  const sessions = useSessions();
  const signals = useSessionSignals();
  const missions = useMissions();
  const { data: config } = useConfig();
  const { toast } = useToast();
  const deleteMission = useDeleteMission();
  const engage = useEngage();
  const pause = usePauseMission();
  const resume = useResumeMission();
  const disengage = useDisengage();
  const openPr = useOpenMissionPr();
  const mergePr = useMergeMissionPr();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [addingPhase, setAddingPhase] = useState(false);
  const { done, total } = epicProgress(phases);
  const { running, needsInput } = epicLive(phases, sessions.data ?? [], signals);
  const Icon = taskTypeMeta('epic').icon;
  const active = needsInput > 0 || running > 0;
  const dotColor = needsInput > 0 ? 'var(--color-warning)' : 'var(--color-success)';
  const dotRing = needsInput > 0 ? 'color-mix(in srgb, var(--color-warning) 50%, transparent)' : 'color-mix(in srgb, var(--color-success) 50%, transparent)';

  // Rolled-up mission cost: sum each phase's agent cost. Shares the ['task-usage', id] cache with the
  // phase cards, so an expanded epic costs no extra fetches.
  const usage = useQueries({
    queries: phases.map((p) => ({
      queryKey: ['task-usage', p.id],
      queryFn: () => elowenClient.taskUsage(p.id),
      staleTime: 5 * 60 * 1000,
    })),
  });
  const totalCost = usage.reduce((sum, q) => sum + (q.data?.costUsd ?? 0), 0);

  // The mission backing this epic (id is `m-<epicId>`, but match on epic_id to be safe). Drives which
  // lifecycle pills show. A never-engaged epic has no row → offer Engage; a disengaged one is done.
  const mission = missions.data?.find((m) => m.epic_id === epic.id) ?? null;
  const epicClosed = (effectiveStatus ?? epic.status) === 'closed' || (effectiveStatus ?? epic.status) === 'cancelled';
  const live = mission != null && mission.state !== 'disengaged';
  const paused = mission?.state === 'paused';

  const onEngage = () => engage.mutate(
    { epicId: epic.id, autonomy: config?.defaults?.autonomy ?? 'L3', maxSessions: config?.defaults?.maxSessions ?? 1 },
    { onSuccess: () => toast(t.missions.engaged.replace('{epicId}', epic.id)), onError: (e) => toast(String(e), 'error') },
  );
  const onPause = () => pause.mutate(mission!.id, { onSuccess: () => toast(t.missions.pausedMsg), onError: (e) => toast(String(e), 'error') });
  const onResume = () => resume.mutate(mission!.id, { onSuccess: () => toast(t.missions.resumed), onError: (e) => toast(String(e), 'error') });
  const onDisengage = () => disengage.mutate(mission!.id, { onSuccess: () => toast(t.missions.disengaged), onError: (e) => toast(String(e), 'error') });
  const onOpenPr = () => openPr.mutate(mission!.id, { onSuccess: (r) => toast(t.missions.prOpened.replace('{n}', String(r.number))), onError: (e) => toast(String(e), 'error') });
  const onContinue = () => engage.mutate(
    { epicId: epic.id, autonomy: config?.defaults?.autonomy ?? 'L3', maxSessions: config?.defaults?.maxSessions ?? 1 },
    { onSuccess: () => toast(t.missions.continued), onError: (e) => toast(String(e), 'error') },
  );
  const onMerge = () => mergePr.mutate(mission!.id, { onSuccess: () => toast(t.missions.mergePrDone), onError: (e) => toast(String(e), 'error') });
  // PR-native surfacing: a pr record with a url → link out; one without (verified, waiting) → "Open PR".
  const pr = mission?.pr ?? null;

  // Whether the bottom row has any lifecycle pill (PR link/open/merge, or engage/continue/pause/
  // disengage). When none apply — e.g. a closed epic with no PR — the row is dropped entirely so the
  // epic stays a single compact line instead of reserving an empty second line.
  const hasActions = !!pr?.prUrl || pr?.prState === 'ready' || pr?.prState === 'open' || live || !epicClosed;

  // No overflow-hidden on the card: it would clip the action menu's dropdown (which must overlay
  // below the card). Corners stay clean because the only child reaching them — the expanded phase
  // list — is rounded to match below (rounded-b-lg).
  return (
    <div
      onDragOver={drop.onDragOver}
      onDragEnter={drop.onDragEnter}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      className={`group/epic border-b border-border/70 transition-colors ${activeId === epic.id ? 'bg-accent/[0.065]' : 'hover:bg-accent/[0.025]'} ${drop.dragOver && dropTargetValid ? 'ring-1 ring-inset ring-accent/60' : ''} ${drop.dragOver && dropTargetValid === false ? 'ring-1 ring-inset ring-danger/40 opacity-60' : ''}`}
    >
      <div className="flex items-center" onContextMenu={onContextMenu ? (e) => onContextMenu(e, epic) : undefined}>
        <button
          type="button"
          onClick={() => { onToggle(); onSelect(epic); }}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5 text-left"
        >
          <ChevronRight size={16} className={`shrink-0 text-text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden />
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent/[0.035]"><Icon size={18} className="text-accent" aria-hidden /></span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{epic.title}</span>
              {active ? <span className="live-dot h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor, ['--live-ring' as string]: dotRing }} aria-hidden /> : null}
            </div>
            <div className="flex items-center gap-2">
              <ProgressRibbon phases={phases} active={activeId === epic.id} className="max-w-[12rem] flex-1" />
              <span className="shrink-0 font-mono text-[11px] text-text-muted">{done}/{total} {t.tasks.phasesLabel}</span>
              {totalCost > 0 ? (
                <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-approve/30 px-1.5 py-0.5 font-mono text-[11px] text-approve" title={`${t.usage.cost}: ${formatCost(totalCost)}`}>
                  <Coins size={10} className="shrink-0" aria-hidden />{formatCost(totalCost)}
                </span>
              ) : null}
              <ProjectPill projectId={epic.project_id} />
            </div>
          </div>
        </button>

        {/* Status + delete menu, kept together top-right (siblings of the toggle so a click here never
            collapses the epic). The menu reveals on epic hover; its slot stays reserved so the badge
            never shifts. */}
        <div className="flex shrink-0 items-center gap-2 pr-1">
          <Badge tone={statusTone(effectiveStatus ?? epic.status)}>{statusLabel(t, effectiveStatus ?? epic.status)}</Badge>
          <div className="opacity-0 transition-opacity group-hover/epic:opacity-100">
            <ActionMenu
              label={t.tasks.epicActions}
              items={[
                { label: t.missions.addPhase, icon: Plus, onSelect: () => setAddingPhase(true) },
                { label: t.tasks.deleteMission, icon: Trash2, tone: 'danger', onSelect: () => setConfirmDelete(true) },
              ]}
            />
          </div>
        </div>
      </div>

      {/* Mission lifecycle pills — their own row under the progress bar, rendered only when there's at
          least one, so a quiet epic stays a single compact line. Indented to line up under the title. */}
      {hasActions ? (
      <div className="flex flex-wrap items-center gap-1.5 pb-3 pl-[5.35rem] pr-1">
        {pr?.prUrl ? (
          <a
            href={pr.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/20"
            title={t.missions.viewPr}
          >
            <GitPullRequest size={13} className="shrink-0" aria-hidden />#{pr.prNumber}
          </a>
        ) : pr?.prState === 'ready' ? (
          <ActionPill icon={GitPullRequest} label={t.missions.openPr} tone="accent" onClick={onOpenPr} disabled={openPr.isPending} />
        ) : null}
        {pr && pr.fixRounds > 0 && pr.prState === 'open' ? (
          <span
            title={pr.lastFeedback ?? undefined}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-[11px] font-medium text-warning"
          >
            <Wrench size={12} className="shrink-0" aria-hidden />
            <span className="hidden @sm:inline">{t.missions.prFixBadge.replace('{n}', String(pr.fixRounds))}</span>
          </span>
        ) : null}
        {pr?.prState === 'open' ? (
          <ActionPill icon={GitMerge} label={t.missions.mergePr} tone="accent" onClick={() => setConfirmMerge(true)} disabled={mergePr.isPending} />
        ) : null}
        {!live && !epicClosed && !mission ? (
          <ActionPill icon={Rocket} label={t.missions.engage} tone="accent" onClick={onEngage} disabled={engage.isPending} />
        ) : null}
        {!live && !epicClosed && mission ? (
          <ActionPill icon={Play} label={t.missions.continueMission} tone="accent" onClick={onContinue} disabled={engage.isPending} />
        ) : null}
        {live ? (
          <>
            {paused
              ? <ActionPill icon={Play} label={t.missions.resume} tone="accent" onClick={onResume} disabled={resume.isPending} />
              : <ActionPill icon={Pause} label={t.missions.pause} onClick={onPause} disabled={pause.isPending} />}
            <ActionPill icon={Power} label={t.missions.disengage} tone="danger" onClick={onDisengage} disabled={disengage.isPending} />
          </>
        ) : null}
      </div>
      ) : null}

      {expanded ? (
        <div className="flex flex-col border-t border-accent/15 bg-bg/20 pl-5">
          {phases.map((p) => (
            <TaskCard key={p.id} task={p} onEdit={onEdit} onSelect={onSelect} onContextMenu={onContextMenu} active={activeId === p.id} blockers={blockedBy.get(p.id)} isPhase />
          ))}
        </div>
      ) : null}

      {addingPhase && <AddPhaseModal epicId={epic.id} onClose={() => setAddingPhase(false)} />}

      <ConfirmDialog
        open={confirmDelete}
        title={t.tasks.confirmDeleteMissionTitle.replace('{id}', epic.id)}
        description={t.tasks.confirmDeleteMissionDescription}
        confirmLabel={t.tasks.deleteMission}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => { setConfirmDelete(false); deleteMission.mutate(epic.id, { onSuccess: () => toast(t.tasks.missionDeleted.replace('{id}', epic.id)), onError: (e) => toast(String(e), 'error') }); }}
      />

      <ConfirmDialog
        open={confirmMerge}
        title={t.missions.mergePrConfirmTitle}
        description={t.missions.mergePrConfirmDesc}
        confirmLabel={t.missions.mergePr}
        onClose={() => setConfirmMerge(false)}
        onConfirm={() => { setConfirmMerge(false); onMerge(); }}
      />
    </div>
  );
}

/** A compact pill button for an epic lifecycle action. */
function ActionPill({ icon: Icon, label, onClick, tone = 'default', disabled }: {
  icon: typeof Rocket; label: string; onClick: () => void; tone?: 'default' | 'accent' | 'danger'; disabled?: boolean;
}) {
  const toneClass = tone === 'accent'
    ? 'border-accent/40 text-accent hover:bg-accent/10'
    : tone === 'danger'
      ? 'border-danger/40 text-danger hover:bg-danger/10'
      : 'border-border text-text-muted hover:border-border-strong hover:text-text';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={`inline-flex items-center gap-1 rounded-full border bg-elevated px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${toneClass}`}
      style={{ transitionDuration: 'var(--motion-fast)' }}
    >
      <Icon size={12} className="shrink-0" aria-hidden />
      <span className="hidden @sm:inline">{label}</span>
    </button>
  );
}
