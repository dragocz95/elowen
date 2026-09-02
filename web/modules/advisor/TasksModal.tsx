'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, ChevronRight, Circle, CircleDot, ListChecks, ListX, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useBrainChat } from './BrainChatProvider';
import { useSessionTasks } from '../../lib/queries';
import { useClearSessionTasks, useDeleteSessionTask, useUpdateSessionTask } from '../../lib/mutations';
import { interpolate, useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { ActionMenu, type ActionMenuItem } from '../../components/ui/ActionMenu';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/shadcn/badge';
import { Checkbox } from '../../components/ui/shadcn/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/shadcn/collapsible';
import { formatDuration } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import type { SessionTask } from '../../lib/types';

/** One task, as a row that can be read and changed in place.
 *
 *  The tick box is the row's primary control and covers the move the list is opened for — finishing a
 *  task, or reopening one ticked too early. Everything rarer (the third status, renaming, deleting) lives
 *  behind the row's ⋯ menu, so the row itself stays a line of text rather than a toolbar.
 *
 *  The description is agent context: useful when checking what a task actually means, noise in a list of
 *  twenty. It folds away under the subject and opens on click, which is also why the subject is the
 *  Collapsible's trigger — a task with nothing to reveal simply has no trigger. */
function TaskRow({ task, disabled, onStatus, onRename, onDelete }: {
  task: SessionTask;
  disabled: boolean;
  onStatus: (task: SessionTask, status: SessionTask['status']) => void;
  onRename: (task: SessionTask, subject: string) => void;
  onDelete: (task: SessionTask) => void;
}) {
  const { t } = useTranslation();
  const now = useNow();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(task.subject);
  const inputRef = useRef<HTMLInputElement>(null);

  const startRename = (): void => { setDraft(task.subject); setRenaming(true); };
  // Enter and blur are the two ways out of a field that replaced a label in place, and both save: a
  // rename the reader typed and then clicked away from is a rename they made. An unchanged or blank name
  // is not a change, so it sends nothing rather than a patch the daemon would only refuse.
  const commitRename = (): void => {
    setRenaming(false);
    const next = draft.trim();
    if (next && next !== task.subject) onRename(task, next);
  };
  const cancelRename = (): void => setRenaming(false);

  const expandable = task.description.trim().length > 0;
  const elapsed = task.status === 'in_progress' && task.startedAt != null
    ? formatDuration(now - task.startedAt)
    : null;
  const items: ActionMenuItem[] = [
    { label: t.tasksModal.statusPending, icon: Circle, onSelect: () => onStatus(task, 'pending') },
    { label: t.tasksModal.statusInProgress, icon: CircleDot, onSelect: () => onStatus(task, 'in_progress') },
    { label: t.tasksModal.statusCompleted, icon: CheckCircle2, onSelect: () => onStatus(task, 'completed') },
    // Radix hands focus back to the trigger as the menu closes, so the field is focused only once that
    // has happened — otherwise the restore would pull the caret straight back out of it.
    { label: t.tasksModal.rename, icon: Pencil, onSelect: startRename, onAfterClose: () => inputRef.current?.focus() },
    { label: t.common.delete, icon: Trash2, tone: 'danger', onSelect: () => onDelete(task) },
  ];

  return (
    <Collapsible data-testid="task-row" className="bg-card px-3 py-2">
      <div className="flex items-center gap-2">
        {task.status === 'in_progress' ? (
          <span className="shrink-0 text-primary" role="img" aria-label={t.tasksModal.statusInProgress}>◐</span>
        ) : (
          <Checkbox
            checked={task.status === 'completed'}
            disabled={disabled}
            onCheckedChange={() => onStatus(task, task.status === 'completed' ? 'pending' : 'completed')}
            aria-label={`${task.status === 'completed' ? t.tasksModal.markPending : t.tasksModal.markCompleted}: ${task.subject}`}
            className="shrink-0"
          />
        )}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">#{task.id}</span>
        {renaming ? (
          <Input
            ref={inputRef}
            value={draft}
            autoFocus
            aria-label={`${t.tasksModal.renameLabel}: ${task.subject}`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
              if (event.key === 'Escape') { event.preventDefault(); cancelRename(); }
            }}
            className="h-7 min-w-0 flex-1 text-sm"
          />
        ) : expandable ? (
          <CollapsibleTrigger
            className={`min-w-0 flex-1 truncate text-left text-sm transition-colors hover:text-foreground ${task.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground'}`}
          >
            {task.subject}
          </CollapsibleTrigger>
        ) : (
          <span className={`min-w-0 flex-1 truncate text-sm ${task.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
            {task.subject}
          </span>
        )}
        {elapsed ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{elapsed}</span> : null}
        {task.owner ? (
          <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[10px]" title={t.tasksModal.owner}>{task.owner}</Badge>
        ) : null}
        <ActionMenu
          items={items}
          label={`${t.tasksModal.taskActions}: ${task.subject}`}
          align="right"
          trigger={<MoreHorizontal size={15} aria-hidden />}
          triggerClassName="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        />
      </div>
      {task.blockedBy.length > 0 ? (
        <p className="pl-6 text-xs text-muted-foreground">
          {t.tasksModal.blockedBy}: {task.blockedBy.map((id) => `#${id}`).join(', ')}
        </p>
      ) : null}
      {expandable ? (
        <CollapsibleContent>
          <p className="whitespace-pre-wrap pl-6 pt-1 text-xs text-muted-foreground">{task.description}</p>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}

/** A hairline-separated stack of rows — separators rather than a box per task, so twenty of them read as
 *  one list instead of twenty cards. */
function TaskList({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-px overflow-hidden rounded-md border border-border bg-border/50">{children}</div>;
}

export function TasksModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { activeSessionId, syncSessionTasks } = useBrainChat();
  const tasksQuery = useSessionTasks(activeSessionId);
  const updateTask = useUpdateSessionTask();
  const deleteTask = useDeleteSessionTask();
  const clearTasks = useClearSessionTasks();
  const [filter, setFilter] = useState('');
  const [pendingDelete, setPendingDelete] = useState<SessionTask | null>(null);
  const [pendingClear, setPendingClear] = useState<'completed' | 'all' | null>(null);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = tasksQuery.data?.tasks ?? [];
    if (!needle) return all;
    return all.filter((task) => task.subject.toLowerCase().includes(needle) || task.description.toLowerCase().includes(needle));
  }, [filter, tasksQuery.data]);
  // Finished work is history, not the list: it stays reachable — and reopenable — but folded, so what is
  // still to do is what the list actually shows.
  const openRows = rows.filter((task) => task.status !== 'completed');
  const completedRows = rows.filter((task) => task.status === 'completed');

  const patch = (task: SessionTask, fields: { status?: SessionTask['status']; subject?: string }): void => {
    if (!activeSessionId) return;
    updateTask.mutate(
      { sessionId: activeSessionId, taskId: task.id, ...fields },
      { onSuccess: (result) => syncSessionTasks(result.tasks), onError: (error: Error) => toast(error.message, 'error') },
    );
  };
  const setStatus = (task: SessionTask, status: SessionTask['status']): void => {
    if (status === task.status) return;
    patch(task, { status });
  };
  const rename = (task: SessionTask, subject: string): void => patch(task, { subject });

  const runDelete = (task: SessionTask): void => {
    setPendingDelete(null);
    if (!activeSessionId) return;
    deleteTask.mutate(
      { sessionId: activeSessionId, taskId: task.id },
      { onSuccess: (result) => syncSessionTasks(result.tasks), onError: (error: Error) => toast(error.message, 'error') },
    );
  };

  const runClear = (scope: 'completed' | 'all'): void => {
    setPendingClear(null);
    if (!activeSessionId) return;
    clearTasks.mutate(
      { sessionId: activeSessionId, scope },
      { onSuccess: (result) => syncSessionTasks(result.tasks), onError: (error: Error) => toast(error.message, 'error') },
    );
  };

  const allTasks = tasksQuery.data?.tasks ?? [];
  const hasCompleted = allTasks.some((task) => task.status === 'completed');
  const mutationPending = updateTask.isPending || deleteTask.isPending || clearTasks.isPending;

  return (
    <>
      {/* `inspect`: the turn's task list, read and ticked off beside the conversation it belongs to. On a
          phone it is the shared fullscreen overlay — every automatic overlay is, see overlayDepth.tsx —
          so the list scrolls to its last row under the pinned header. The two clear confirmations below
          are a level deeper and take the screen, which is what a destructive question should do. */}
      <Modal title={t.tasksModal.modalTitle} onClose={onClose} size="md" icon={ListChecks} intent="inspect">
        <ModalBody gap={4}>
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t.tasksModal.filterPlaceholder}
            aria-label={t.tasksModal.filterPlaceholder}
          />

          {tasksQuery.isLoading ? (
            <LoadingState variant="list" />
          ) : tasksQuery.isError ? (
            <ErrorState message={t.common.daemonUnreachable} onRetry={() => tasksQuery.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState title={t.tasksModal.emptyTitle} description={t.tasksModal.emptyDesc} icon={ListChecks} />
          ) : (
            <>
              {openRows.length > 0 ? (
                <TaskList>
                  {openRows.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      disabled={mutationPending}
                      onStatus={setStatus}
                      onRename={rename}
                      onDelete={setPendingDelete}
                    />
                  ))}
                </TaskList>
              ) : null}

              {completedRows.length > 0 ? (
                <Collapsible data-testid="tasks-completed-group" className="flex flex-col gap-2">
                  <CollapsibleTrigger className="group flex items-center gap-1.5 self-start text-xs text-muted-foreground transition-colors hover:text-foreground [&[data-state=open]_svg]:rotate-90">
                    <ChevronRight size={12} aria-hidden className="shrink-0 transition-transform" />
                    {interpolate(t.tasksModal.completedGroup, { n: completedRows.length })}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <TaskList>
                      {completedRows.map((task) => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          disabled={mutationPending}
                          onStatus={setStatus}
                          onRename={rename}
                          onDelete={setPendingDelete}
                        />
                      ))}
                    </TaskList>
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
            </>
          )}
        </ModalBody>
        {allTasks.length > 0 ? (
          <ModalFooter>
            <Button variant="ghost" icon={ListX} disabled={!hasCompleted || mutationPending} onClick={() => setPendingClear('completed')}>
              {t.tasksModal.clearCompleted}
            </Button>
            <Button variant="ghost-danger" icon={Trash2} disabled={mutationPending} onClick={() => setPendingClear('all')}>
              {t.tasksModal.clearAll}
            </Button>
          </ModalFooter>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t.tasksModal.deleteTitle}
        description={pendingDelete?.subject}
        onConfirm={() => { if (pendingDelete) runDelete(pendingDelete); }}
        onClose={() => setPendingDelete(null)}
      />
      <ConfirmDialog
        open={pendingClear !== null}
        title={pendingClear === 'completed' ? t.tasksModal.clearCompletedTitle : t.tasksModal.clearAllTitle}
        description={pendingClear === 'completed' ? t.tasksModal.clearCompletedDescription : t.tasksModal.clearAllDescription}
        confirmLabel={pendingClear === 'completed' ? t.tasksModal.clearCompleted : t.tasksModal.clearAll}
        onConfirm={() => { if (pendingClear) runClear(pendingClear); }}
        onClose={() => setPendingClear(null)}
      />
    </>
  );
}
