'use client';

import { useMemo, useState } from 'react';
import { ListChecks, Trash2 } from 'lucide-react';
import { useBrainChat } from './BrainChatProvider';
import { useSessionTasks } from '../../lib/queries';
import { useDeleteSessionTask, useUpdateSessionTask } from '../../lib/mutations';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import { Input } from '../../components/ui/Input';
import { IconButton } from '../../components/ui/IconButton';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { Modal, ModalBody } from '../../components/ui/Modal';
import type { SessionTask } from '../../lib/types';

export function TasksModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { activeSessionId, syncSessionTasks } = useBrainChat();
  const tasksQuery = useSessionTasks(activeSessionId);
  const updateTask = useUpdateSessionTask();
  const deleteTask = useDeleteSessionTask();
  const [filter, setFilter] = useState('');
  const [pendingDelete, setPendingDelete] = useState<SessionTask | null>(null);

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

  return (
    <>
      <Modal title={t.tasksModal.modalTitle} onClose={onClose} size="md" icon={ListChecks}>
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
            <div className="flex flex-col gap-px overflow-hidden rounded-md border border-border bg-border/50">
              {rows.map((task) => (
                <div key={task.id} className="flex items-start gap-3 bg-surface px-3 py-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-sm font-medium text-text">{task.subject}</span>
                    <span className="whitespace-pre-wrap text-xs text-text-muted">{task.description}</span>
                    {task.blockedBy.length > 0 ? (
                      <span className="text-xs text-warning">{t.tasksModal.blockedBy}: {task.blockedBy.map((id) => `#${id}`).join(', ')}</span>
                    ) : null}
                  </div>
                  <select
                    aria-label={`${t.tasksModal.status}: ${task.subject}`}
                    value={task.status}
                    disabled={updateTask.isPending || deleteTask.isPending}
                    onChange={(event) => setStatus(task, event.target.value as SessionTask['status'])}
                    className="h-8 rounded-md border border-border bg-elevated px-2 text-xs text-text"
                  >
                    <option value="pending">{t.tasksModal.statusPending}</option>
                    <option value="in_progress">{t.tasksModal.statusInProgress}</option>
                    <option value="completed">{t.tasksModal.statusCompleted}</option>
                  </select>
                  <IconButton
                    icon={Trash2}
                    label={t.common.delete}
                    variant="danger"
                    disabled={updateTask.isPending || deleteTask.isPending}
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
    </>
  );
}
