'use client';
import { useState, type ReactNode } from 'react';
import { Eye, Pencil, Play, Square, Pause, TerminalSquare, Link2, RotateCcw, ShieldCheck, ScanSearch, Plus, Sparkles, Archive, Copy, Trash2, Cpu, Flag, Activity, type LucideIcon } from 'lucide-react';
import type { Task, Mission } from '../../lib/types';
import { ContextMenu, DIVIDER, type ContextMenuState, type MenuEntry } from '../../components/ui/ContextMenu';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { apiErrorMessage } from '../../lib/orcaClient';
import { openTerminalWindow } from '../../lib/openTerminalWindow';
import { taskExec, taskSessionName, agentDisplayName } from '../../lib/agentUtils';
import { allModels } from '../../lib/execPresets';
import { useSessions, useConfig } from '../../lib/queries';
import {
  useSpawn, useKillSession, useSetTaskStatus, useSendInput, useUpdateTask, useSetTaskExec,
  useCloseTask, useDeleteTask, useDeleteMission, useApproveGate, useInsertPhases,
} from '../../lib/mutations';
import { buildTaskMenu, SPEC_DIVIDER, type TaskMenuActionId, type TaskMenuSubmenuId } from './taskContextMenu';
import { statusLabel } from './taskMeta';
import { TaskModal } from './TaskModal';
import { AddPhaseModal } from './AddPhaseModal';
import { DepPickerModal } from './DepPickerModal';

interface Inputs {
  /** Open a task's detail (the same target a left-click hits). */
  onSelect: (t: Task) => void;
  /** Open the full editor modal for a task. */
  onEdit: (t: Task) => void;
  /** Epic → its phases, so an epic is told apart from a standalone task. */
  childMap: Map<string, Task[]>;
  /** Unresolved blockers per task, so Start can be disabled when something gates it. */
  blockedBy: Map<string, Task[]>;
  missions?: Mission[];
}

type Confirm = { kind: 'delete' | 'deleteMission'; task: Task };

/** Wires a right-click context menu over tasks: resolves each task's live/structural state, builds the
 *  context-aware action spec (see `buildTaskMenu`), and owns every modal an action opens. Used by both
 *  the task list and the kanban board — each gets its own instance (no shared state between surfaces). */
export function useTaskContextMenu({ onSelect, onEdit, childMap, blockedBy }: Inputs): {
  open: (e: React.MouseEvent, task: Task) => void;
  menu: ReactNode;
  modals: ReactNode;
} {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { data: config } = useConfig();
  const sessions = useSessions();

  const spawn = useSpawn();
  const kill = useKillSession();
  const setStatus = useSetTaskStatus();
  const send = useSendInput();
  const update = useUpdateTask();
  const setExec = useSetTaskExec();
  const close = useCloseTask();
  const del = useDeleteTask();
  const deleteMission = useDeleteMission();
  const approve = useApproveGate();
  const insert = useInsertPhases();

  const [menuState, setMenuState] = useState<ContextMenuState | null>(null);
  const [depTask, setDepTask] = useState<Task | null>(null);
  const [planTask, setPlanTask] = useState<Task | null>(null);
  const [addPhaseEpic, setAddPhaseEpic] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const fail = (e: unknown) => toast(apiErrorMessage(e), 'error');

  function open(e: React.MouseEvent, task: Task) {
    e.preventDefault();
    const exec = taskExec(task.labels);
    const session = taskSessionName(task);
    const live = sessions.data ?? [];
    const hasSession = !!session && live.includes(session);
    const running = task.status === 'in_progress' && hasSession;
    const kind = task.type === 'epic' && (childMap.get(task.id)?.length ?? 0) > 0 ? 'epic' : task.parent_id ? 'phase' : 'standalone';
    const hasBlockers = (blockedBy.get(task.id)?.length ?? 0) > 0;
    const isGated = task.labels?.some((l) => l.startsWith('gatedby:')) ?? false;
    const models = allModels(config?.customModels, config?.hiddenPresets).filter((m) => !config?.allowedExecs || config.allowedExecs.includes(m.exec));

    // Per-task run handlers — same behaviour as useTaskControls, recomputed here because that hook is
    // per-task and can't be called inside a click handler for an arbitrary row.
    const start = () => spawn.mutate({ taskId: task.id, exec: exec || undefined }, { onSuccess: (r) => toast(t.tasks.launched.replace('{session}', agentDisplayName(r.session))), onError: fail });
    const stop = () => { if (session) kill.mutate(session); setStatus.mutate({ id: task.id, status: 'open' }, { onSuccess: () => toast(t.tasks.stopped.replace('{id}', task.id)), onError: fail }); };
    const pause = () => { if (session) send.mutate({ name: session, keys: ['C-c'] }, { onSuccess: () => toast(t.sessions.interrupted.replace('{name}', agentDisplayName(session))), onError: fail }); };
    const reopen = () => setStatus.mutate({ id: task.id, status: 'open' }, { onSuccess: () => toast(t.tasks.updated.replace('{id}', task.id)), onError: fail });
    const copyId = () => navigator.clipboard.writeText(task.id).then(() => toast(t.tasks.idCopied.replace('{id}', task.id)), () => toast(t.tasks.idCopyFailed, 'error'));
    const runReview = () => insert.mutate({ epicId: task.id, body: { phases: [{ title: t.tasks.reviewPhaseTitle.replace('{title}', task.title), type: 'chore' }] } }, { onSuccess: () => toast(t.tasks.reviewQueued), onError: fail });
    const approveGate = () => approve.mutate(task.id, { onSuccess: (r) => toast(t.tasks.gateApproved.replace('{n}', String(r.released.length))), onError: fail });
    const closeTask = () => close.mutate(task.id, { onSuccess: () => toast(t.tasks.closed.replace('{id}', task.id)), onError: fail });
    const setExecTo = (v: string) => setExec.mutate({ id: task.id, exec: v }, { onSuccess: () => toast(t.tasks.updated.replace('{id}', task.id)), onError: fail });
    const setPriorityTo = (v: string) => update.mutate({ id: task.id, patch: { priority: v } }, { onSuccess: () => toast(t.tasks.updated.replace('{id}', task.id)), onError: fail });
    const setStatusTo = (v: string) => setStatus.mutate({ id: task.id, status: v }, { onSuccess: () => toast(t.tasks.updated.replace('{id}', task.id)), onError: fail });

    const ACTIONS: Record<TaskMenuActionId, { label: string; icon: LucideIcon; onClick: () => void; danger?: boolean }> = {
      open: { label: t.tasks.ctxOpenDetail, icon: Eye, onClick: () => onSelect(task) },
      edit: { label: t.common.edit, icon: Pencil, onClick: () => onEdit(task) },
      start: { label: t.tasks.start, icon: Play, onClick: start },
      stop: { label: t.tasks.stop, icon: Square, onClick: stop },
      pause: { label: t.tasks.pause, icon: Pause, onClick: pause },
      terminal: { label: t.tasks.openTerminal, icon: TerminalSquare, onClick: () => { if (session) openTerminalWindow(session); } },
      dependencies: { label: t.tasks.dependencies, icon: Link2, onClick: () => setDepTask(task) },
      reopen: { label: t.tasks.ctxReopen, icon: RotateCcw, onClick: reopen },
      approveGate: { label: t.tasks.ctxApproveGate, icon: ShieldCheck, onClick: approveGate },
      runReview: { label: t.tasks.ctxRunReview, icon: ScanSearch, onClick: runReview },
      addPhase: { label: t.missions.addPhase, icon: Plus, onClick: () => setAddPhaseEpic(task.id) },
      planMission: { label: t.tasks.ctxPlanMission, icon: Sparkles, onClick: () => setPlanTask(task) },
      close: { label: t.tasks.closeArchive, icon: Archive, onClick: closeTask },
      copyId: { label: t.tasks.copyId, icon: Copy, onClick: copyId },
      delete: { label: t.tasks.deletePermanently, icon: Trash2, danger: true, onClick: () => setConfirm({ kind: 'delete', task }) },
      deleteMission: { label: t.tasks.deleteMission, icon: Trash2, danger: true, onClick: () => setConfirm({ kind: 'deleteMission', task }) },
    };
    const SUBMENUS: Record<TaskMenuSubmenuId, { label: string; icon: LucideIcon; optLabel: (v: string) => string; onPick: (v: string) => void }> = {
      setModel: { label: t.tasks.ctxSetModel, icon: Cpu, optLabel: (v) => v === '' ? t.tasks.ctxDefaultModel : (models.find((m) => m.exec === v)?.label ?? v), onPick: setExecTo },
      setPriority: { label: t.tasks.ctxPriority, icon: Flag, optLabel: (v) => v, onPick: setPriorityTo },
      setStatus: { label: t.tasks.ctxStatus, icon: Activity, optLabel: (v) => statusLabel(t, v), onPick: setStatusTo },
    };

    const spec = buildTaskMenu({ task, kind, running, hasSession, hasBlockers, isGated, canMutate: true, models, currentExec: exec });
    const items: MenuEntry[] = spec.map((entry) => {
      if (entry === SPEC_DIVIDER) return DIVIDER;
      if (entry.kind === 'item') {
        const a = ACTIONS[entry.id];
        return { label: a.label, icon: a.icon, onClick: a.onClick, danger: a.danger, disabled: !entry.enabled };
      }
      const s = SUBMENUS[entry.id];
      return {
        label: s.label, icon: s.icon, disabled: !entry.enabled,
        items: entry.options.map((o) => ({ label: s.optLabel(o.value), onClick: () => s.onPick(o.value), disabled: o.current })),
      };
    });

    setMenuState({ x: e.clientX, y: e.clientY, items });
  }

  const menu = menuState ? <ContextMenu state={menuState} onClose={() => setMenuState(null)} /> : null;
  const modals = (
    <>
      {depTask ? <DepPickerModal task={depTask} onClose={() => setDepTask(null)} /> : null}
      {planTask ? <TaskModal initialMode="planning" initialGoal={planTask.description ? `${planTask.title}\n\n${planTask.description}` : planTask.title} onClose={() => setPlanTask(null)} /> : null}
      {addPhaseEpic ? <AddPhaseModal epicId={addPhaseEpic} onClose={() => setAddPhaseEpic(null)} /> : null}
      {confirm?.kind === 'delete' ? (
        <ConfirmDialog
          open
          title={t.tasks.confirmDeleteTitle.replace('{id}', confirm.task.id)}
          description={t.tasks.confirmDeleteDescription}
          onClose={() => setConfirm(null)}
          onConfirm={() => { const tk = confirm.task; setConfirm(null); del.mutate(tk.id, { onSuccess: () => toast(t.tasks.deleted.replace('{id}', tk.id)), onError: fail }); }}
        />
      ) : null}
      {confirm?.kind === 'deleteMission' ? (
        <ConfirmDialog
          open
          title={t.tasks.confirmDeleteMissionTitle.replace('{id}', confirm.task.id)}
          description={t.tasks.confirmDeleteMissionDescription}
          confirmLabel={t.tasks.deleteMission}
          onClose={() => setConfirm(null)}
          onConfirm={() => { const tk = confirm.task; setConfirm(null); deleteMission.mutate(tk.id, { onSuccess: () => toast(t.tasks.missionDeleted.replace('{id}', tk.id)), onError: fail }); }}
        />
      ) : null}
    </>
  );

  return { open, menu, modals };
}
