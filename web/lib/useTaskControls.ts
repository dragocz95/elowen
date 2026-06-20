'use client';
import type { Task } from './types';
import { apiErrorMessage } from './orcaClient';
import { taskExec } from './taskExec';
import { taskSessionName } from './agentUtils';
import { useSpawn, useKillSession, useSetTaskStatus, useSendInput } from './mutations';
import { useSessions } from './queries';
import { useToast } from '../components/ui/Toast';
import { useTranslation } from './i18n';

export interface TaskControls {
  /** The task's tmux session name (orca-<agent>), or null when it has no agent label. */
  session: string | null;
  /** True when the task is in_progress and its tmux session is actually live. */
  running: boolean;
  start: () => void;
  stop: () => void;
  pause: () => void;
}

/** Shared run controls for a task — used by the task card and the detail pane so start/stop/pause
 *  behave identically everywhere. Self-contained: owns its mutations, toasts and live-state lookup. */
export function useTaskControls(task: Task): TaskControls {
  const spawn = useSpawn();
  const kill = useKillSession();
  const setStatus = useSetTaskStatus();
  const send = useSendInput();
  const sessions = useSessions();
  const { toast } = useToast();
  const { t } = useTranslation();

  const exec = taskExec(task.labels);
  const session = taskSessionName(task);
  const running = task.status === 'in_progress' && !!session && (sessions.data ?? []).includes(session);

  const start = () => spawn.mutate({ taskId: task.id, exec: exec || undefined }, { onSuccess: (r) => toast(t.tasks.launched.replace('{session}', r.session)), onError: (e) => toast(apiErrorMessage(e), 'error') });
  const stop = () => {
    if (session) kill.mutate(session);
    setStatus.mutate({ id: task.id, status: 'open' }, { onSuccess: () => toast(t.tasks.stopped.replace('{id}', task.id)), onError: (e) => toast(apiErrorMessage(e), 'error') });
  };
  const pause = () => { if (session) send.mutate({ name: session, keys: ['C-c'] }, { onSuccess: () => toast(t.sessions.interrupted.replace('{name}', session)), onError: (e) => toast(apiErrorMessage(e), 'error') }); };

  return { session, running, start, stop, pause };
}
