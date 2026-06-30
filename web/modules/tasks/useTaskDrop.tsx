'use client';
import { useState, type DragEvent, type ReactNode } from 'react';
import { Layers, Link2 } from 'lucide-react';
import type { Task } from '../../lib/types';
import { ContextMenu, type ContextMenuState } from '../../components/ui/ContextMenu';
import { useUpdateTask } from '../../lib/mutations';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { apiErrorMessage } from '../../lib/orcaClient';

/** Whether `dragged` may be dropped onto `target` at all — independent of which action (reparent
 *  vs. dependency) is eventually chosen. The single source of truth both views use, for the
 *  dragover highlight and the actual drop, so they can never disagree on a legal target. */
export function canDropOnTask(dragged: Task, target: Task, phaseIds: Set<string>): boolean {
  if (dragged.id === target.id) return false;
  if (dragged.project_id !== target.project_id) return false;
  if (phaseIds.has(dragged.id) || dragged.parent_id) return false; // dragged is already a phase
  if (phaseIds.has(target.id) || target.parent_id) return false; // target is already a phase
  // A finished task shouldn't be silently re-attached, and a currently-running one has a live agent
  // session whose checkout/cwd a concurrent reparent would race — same rule the backend re-validates.
  if (dragged.status === 'closed' || dragged.status === 'cancelled' || dragged.status === 'in_progress') return false;
  return true;
}

export interface DropTargetHandlers {
  /** True only while a VALID drag hovers this card — drives the accent/danger ring styling
   *  together with `dropTargetValid` at the call site. */
  dragOver: boolean;
  onDragOver: (e: DragEvent) => void;
  onDragEnter: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
}

/** Card-onto-card drop wiring shared by every card surface (kanban card/epic, flat-list task/epic
 *  group) — single source of truth for the four native-DnD handlers, previously duplicated
 *  verbatim across four components. Only intercepts the drag (stopPropagation + preventDefault)
 *  when THIS card is itself a legal drop target; otherwise it's a no-op, so the event still bubbles
 *  to an ancestor's own drop handling — e.g. the kanban column's status-move drop, which must keep
 *  working when the user releases over a card that isn't a valid subtask/dependency target. */
export function useDropTarget(onDropTask: ((e: DragEvent) => void) | undefined, dropTargetValid: boolean | undefined): DropTargetHandlers {
  const [hover, setHover] = useState(false);
  return {
    dragOver: hover,
    onDragOver: (e) => { if (onDropTask && dropTargetValid) { e.stopPropagation(); e.preventDefault(); } },
    onDragEnter: () => { if (onDropTask) setHover(true); },
    onDragLeave: () => { if (onDropTask) setHover(false); },
    onDrop: (e) => {
      if (!onDropTask) return;
      if (dropTargetValid) { e.stopPropagation(); setHover(false); onDropTask(e); }
      else setHover(false); // not a legal target here — let the drop bubble untouched
    },
  };
}

/** Whether `dragged` may be reparented (made a subtask) — false when it already has children of
 *  its own, since the tree stays exactly 2 levels deep (epic → phases, no nested epics). Adding a
 *  dependency has no such restriction, so this is checked separately from `canDropOnTask`. */
export function canReparent(dragged: Task, childMap: Map<string, Task[]>): boolean {
  return (childMap.get(dragged.id)?.length ?? 0) === 0;
}

interface DropChoiceState { x: number; y: number; draggedTask: Task; targetTask: Task }

/** Drag-a-card-onto-another-card: dropping onto an epic reparents directly (that's how a task
 *  joins a live mission); dropping onto a plain task opens a small choice menu — make it a subtask,
 *  or just add a dependency. Shared by the kanban board and the flat list so both surfaces agree on
 *  what's droppable and what happens next. */
export function useTaskDrop(allTasks: Task[], childMap: Map<string, Task[]>, phaseIds: Set<string>): {
  handleDrop: (e: DragEvent, target: Task) => void;
  isValidTarget: (draggedId: string | null, target: Task) => boolean;
  popup: ReactNode;
} {
  const update = useUpdateTask();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [choice, setChoice] = useState<DropChoiceState | null>(null);

  const byId = new Map(allTasks.map((x) => [x.id, x]));
  const fail = (e: unknown) => toast(apiErrorMessage(e), 'error');

  const doReparent = (draggedId: string, targetId: string, targetTitle: string) =>
    update.mutate({ id: draggedId, patch: { parent_id: targetId } }, {
      onSuccess: () => toast(t.tasks.dropMadeSubtask.replace('{title}', targetTitle)),
      onError: fail,
    });

  const doAddDep = (draggedId: string, targetId: string) =>
    update.mutate({ id: draggedId, patch: { addDep: targetId } }, {
      onSuccess: () => toast(t.tasks.dropDepAdded),
      onError: fail,
    });

  function isValidTarget(draggedId: string | null, target: Task): boolean {
    if (!draggedId) return false;
    const dragged = byId.get(draggedId);
    return !!dragged && canDropOnTask(dragged, target, phaseIds);
  }

  function handleDrop(e: DragEvent, target: Task): void {
    e.preventDefault();
    e.stopPropagation(); // a card-drop must not also trigger an ancestor's own onDrop (kanban column)
    const draggedId = e.dataTransfer.getData('text/plain');
    const dragged = byId.get(draggedId);
    if (!dragged || !canDropOnTask(dragged, target, phaseIds)) return;
    if (target.type === 'epic') {
      if (canReparent(dragged, childMap)) doReparent(dragged.id, target.id, target.title);
      return; // dropping an epic-with-phases onto another epic: no legal action, silently ignored
    }
    setChoice({ x: e.clientX, y: e.clientY, draggedTask: dragged, targetTask: target });
  }

  let menuState: ContextMenuState | null = null;
  if (choice) {
    menuState = {
      x: choice.x, y: choice.y,
      items: [
        {
          label: t.tasks.dropMakeSubtaskOf.replace('{title}', choice.targetTask.title),
          icon: Layers,
          disabled: !canReparent(choice.draggedTask, childMap),
          onClick: () => doReparent(choice.draggedTask.id, choice.targetTask.id, choice.targetTask.title),
        },
        {
          label: t.tasks.dropAddDependencyOn.replace('{title}', choice.targetTask.title),
          icon: Link2,
          onClick: () => doAddDep(choice.draggedTask.id, choice.targetTask.id),
        },
      ],
    };
  }
  const popup = menuState ? <ContextMenu state={menuState} onClose={() => setChoice(null)} /> : null;

  return { handleDrop, isValidTarget, popup };
}
