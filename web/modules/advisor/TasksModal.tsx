'use client';

import { useMemo, useState } from 'react';
import { ListChecks, ListX, Trash2 } from 'lucide-react';
import { useBrainChat } from './BrainChatProvider';
import { useSessionTasks } from '../../lib/queries';
import { useClearSessionTasks, useDeleteSessionTask, useUpdateSessionTask } from '../../lib/mutations';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { Modal, ModalBody } from '../../components/ui/Modal';
import { formatDuration } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import type { SessionTask } from '../../lib/types';

export function TasksModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const now = useNow();
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

  const setStatus = (task: SessionTask, status: SessionTask['status']): void => {
    if (!activeSessionId || status === task.status) return;
    updateTask.mutate(
      { sessionId: activeSessionId, taskId: task.id, status },
      { onSuccess: (result) => syncSessionTasks(result.tasks), onError: (error: Error) => toast(error.message, 'error') },
    );
  };

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

          {allTasks.length > 0 ? (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" icon={ListX} disabled={!hasCompleted || mutationPending} onClick={() => setPendingClear('completed')}>
                {t.tasksModal.clearCompleted}
              </Button>
              <Button variant="ghost-danger" icon={Trash2} disabled={mutationPending} onClick={() => setPendingClear('all')}>
                {t.tasksModal.clearAll}
              </Button>
            </div>
          ) : null}

          {tasksQuery.isLoading ? (
            <LoadingState variant="list" />
          ) : tasksQuery.isError ? (
            <ErrorState message={t.common.daemonUnreachable} onRetry={() => tasksQuery.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState title={t.tasksModal.emptyTitle} description={t.tasksModal.emptyDesc} icon={ListChecks} />
          ) : (
            <div className="flex flex-col gap-px overflow-hidden rounded-md border border-border bg-border/50">
              {rows.map((task) => (
                <div key={task.id} className="flex items-start gap-3 bg-card px-3 py-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-xs tabular-nums text-muted-foreground">#{task.id}</span>
                      <span className="text-sm font-medium text-foreground">{task.subject}</span>
                      {task.status === 'in_progress' && task.startedAt != null ? (
                        <span className="text-xs tabular-nums text-muted-foreground">· {formatDuration(now - task.startedAt)}</span>
                      ) : null}
                    </div>
                    <span className="whitespace-pre-wrap text-xs text-muted-foreground">{task.description}</span>
                    {task.blockedBy.length > 0 ? (
                      <span className="text-xs text-warning">{t.tasksModal.blockedBy}: {task.blockedBy.map((id) => `#${id}`).join(', ')}</span>
                    ) : null}
                  </div>
                  <select
                    aria-label={`${t.tasksModal.status}: ${task.subject}`}
                    value={task.status}
                    disabled={mutationPending}
                    onChange={(event) => setStatus(task, event.target.value as SessionTask['status'])}
                    className="h-8 rounded-md border border-border bg-muted px-2 text-xs text-foreground"
                  >
                    <option value="pending">{t.tasksModal.statusPending}</option>
                    <option value="in_progress">{t.tasksModal.statusInProgress}</option>
                    <option value="completed">{t.tasksModal.statusCompleted}</option>
                  </select>
                  <IconButton
                    icon={Trash2}
                    label={t.common.delete}
                    variant="danger"
                    disabled={mutationPending}
                    onClick={() => setPendingDelete(task)}
                  />
                </div>
              ))}
            </div>
          )}
        </ModalBody>
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
