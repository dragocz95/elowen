'use client';
import { useEffect } from 'react';
import type { Task } from './types';
import { useSessions } from './queries';

/** Auto-close an open terminal once its agent is done: either the task finished
 *  (closed/cancelled) or the live tmux session disappeared (the agent exited and the
 *  session was reaped). Keeps the user from staring at a dead pane. */
export function useCloseOnAgentDone(session: string, task: Task | null | undefined, onClose: () => void): void {
  const sessions = useSessions();
  const live = sessions.data;
  const finished = task ? task.status === 'closed' || task.status === 'cancelled' : false;
  // Only treat "gone" once we actually have the session list, so we never close on a cold cache.
  const gone = Array.isArray(live) && !live.includes(session);

  useEffect(() => {
    if (finished || gone) onClose();
  }, [finished, gone, onClose]);
}
