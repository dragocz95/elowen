'use client';
import { useState } from 'react';
import { Circle, LoaderCircle, Ban, CheckCircle2, XCircle, List, type LucideIcon } from 'lucide-react';
import type { Task, Mission, TaskStatus } from '../../lib/types';
import { groupByStatus } from './groupByStatus';
import { epicChildren, phaseIds, epicEffectiveStatus } from '../../lib/taskTree';
import { KanbanCard } from './KanbanCard';
import { KanbanEpicCard } from './KanbanEpicCard';
import { statusLabel } from '../tasks/taskMeta';
import { useTaskContextMenu } from '../tasks/useTaskContextMenu';
import { useTaskDrop } from '../tasks/useTaskDrop';
import { useTranslation } from '../../lib/i18n';
import { MotionLayout, MotionLayoutItem } from '../../components/ui/Motion';

const COLUMNS: { status: TaskStatus; labelKey: string; icon: LucideIcon; color: string }[] = [
  { status: 'open', labelKey: 'columnOpen', icon: Circle, color: 'var(--color-success)' },
  { status: 'in_progress', labelKey: 'columnInProgress', icon: LoaderCircle, color: 'var(--color-warning)' },
  { status: 'blocked', labelKey: 'columnBlocked', icon: Ban, color: 'var(--color-error)' },
  { status: 'closed', labelKey: 'columnClosed', icon: CheckCircle2, color: 'var(--color-error)' },
  { status: 'cancelled', labelKey: 'columnCancelled', icon: XCircle, color: 'var(--color-cancelled)' },
];

export function KanbanBoard({ tasks, allTasks, onMove, onSelect, onEdit, blockedBy, missions }: { tasks: Task[]; allTasks?: Task[]; onMove: (taskId: string, status: TaskStatus) => void; onSelect?: (t: Task) => void; onEdit?: (t: Task) => void; blockedBy?: Map<string, Task[]>; missions?: Mission[] }) {
  const { t } = useTranslation();
  const activeMissions = missions ?? [];
  // Build child map and phase set from the full, unfiltered task list so that epic rollup
  // status and progress are independent of any active date filter. Defaults to tasks so that
  // call sites that pass no allTasks keep the existing behaviour.
  const fullTasks = allTasks ?? tasks;
  const childMap = epicChildren(fullTasks);
  const ctxMenu = useTaskContextMenu({ onSelect: (x) => onSelect?.(x), onEdit: (x) => onEdit?.(x), childMap, blockedBy: blockedBy ?? new Map(), missions: activeMissions });
  const phaseSet = phaseIds(fullTasks);
  const taskDrop = useTaskDrop(fullTasks, childMap, phaseSet);
  // An epic is placed by its effective status (active mission / running phase → in progress,
  // all phases done → closed); its true task status is preserved on the card (title/tooltip).
  const effStatus = (task: Task) => (task.type === 'epic' ? epicEffectiveStatus(task, activeMissions, childMap.get(task.id) ?? []) : task.status);
  const groups = groupByStatus(tasks, effStatus);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Autopilot epics start collapsed so their phases don't flood the board.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleEpic = (id: string) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const renderCard = (task: Task, isPhase: boolean) => {
    const blockers = blockedBy?.get(task.id) ?? [];
    return (
      <MotionLayoutItem key={task.id} layoutId={`kanban-task-${task.id}`}>
      <KanbanCard
        key={task.id}
        task={task}
        isPhase={isPhase}
        blocked={blockers.length > 0}
        blockers={blockers}
        dragging={draggingId === task.id}
        statusLabel={statusLabel(t, task.status)}
        onSelect={onSelect}
        onContextMenu={ctxMenu.open}
        onDragStart={(e) => { e.dataTransfer.setData('text/plain', task.id); setDraggingId(task.id); }}
        onDragEnd={() => { setDraggingId(null); setDragOver(null); }}
        onDropTask={(e) => taskDrop.handleDrop(e, task)}
        dropTargetValid={draggingId ? taskDrop.isValidTarget(draggingId, task) : undefined}
      />
      </MotionLayoutItem>
    );
  };
  return (
    <>
    {/* @container: columns size to the board's own width (dock-aware). The context menu + modals
        below render as siblings (outside this container) so their fixed positioning stays correct. */}
    <div className="@container flex gap-3 overflow-x-auto">
      {COLUMNS.map((col) => {
        const colLabel = t.kanban[col.labelKey as keyof typeof t.kanban] as string;
        const isDropTarget = dragOver === col.status;
        return (
        <div
          key={col.status}
          data-testid={`column-${col.status}`}
          className={`flex w-[80cqw] shrink-0 flex-col gap-2 border-y border-r bg-surface/25 px-2 py-3 transition-colors first:border-l @sm:w-auto @sm:min-w-[14rem] @sm:shrink @sm:flex-1 ${isDropTarget ? 'border-accent/60 bg-elevated/40' : 'border-border'}`}
          onDragOver={(e) => { e.preventDefault(); if (dragOver !== col.status) setDragOver(col.status); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver((s) => (s === col.status ? null : s)); }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(null); setDraggingId(null);
            const id = e.dataTransfer.getData('text/plain');
            if (id && byId.get(id)?.status !== col.status) onMove(id, col.status);
          }}
        >
          <header className="flex items-center justify-between px-1 font-mono uppercase tracking-widest text-text-muted" style={{ fontSize: 'var(--text-caption)' }}>
            <span className="flex items-center gap-1.5"><col.icon size={12} style={{ color: col.color }} aria-hidden />{colLabel}</span>
            <span className="inline-flex items-center gap-1"><List size={11} className="text-text-muted" aria-hidden />{groups[col.status].filter((task) => !phaseSet.has(task.id)).length}</span>
          </header>
          <MotionLayout className="flex flex-col gap-2">
          {groups[col.status].map((task) => {
            // Autopilot epic → collapsible container; when expanded its phases nest right
            // under it (in this column) so they never scatter into other status columns.
            if (task.type === 'epic' && childMap.has(task.id)) {
              const phases = childMap.get(task.id) ?? [];
              return (
                <MotionLayoutItem key={task.id} layoutId={`kanban-task-${task.id}`} className="flex flex-col gap-2">
                  <KanbanEpicCard epic={task} phases={phases} expanded={expanded.has(task.id)} onToggle={() => toggleEpic(task.id)} effectiveStatus={effStatus(task)} trueStatusLabel={statusLabel(t, task.status)} onDropTask={(e) => taskDrop.handleDrop(e, task)} dropTargetValid={draggingId ? taskDrop.isValidTarget(draggingId, task) : undefined} />
                  {expanded.has(task.id) ? phases.map((ph) => renderCard(ph, true)) : null}
                </MotionLayoutItem>
              );
            }
            if (phaseSet.has(task.id)) return null; // phases only appear nested under their epic
            return renderCard(task, false);
          })}
          </MotionLayout>
        </div>
      );
    })}
    </div>
    {ctxMenu.menu}
    {ctxMenu.modals}
    {taskDrop.popup}
    </>
  );
}
