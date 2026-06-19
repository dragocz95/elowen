'use client';
import dynamic from 'next/dynamic';
import { TerminalSquare } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useTasks } from '../../lib/queries';
import { taskForSession, agentDisplayName } from '../../lib/agentUtils';
import { useCloseOnAgentDone } from '../../lib/useCloseOnAgentDone';

// xterm references browser-only `self`; skip SSR to avoid prerender errors.
const TerminalPanel = dynamic(() => import('./TerminalPanel').then((m) => m.TerminalPanel), { ssr: false });

/** The full agent terminal in a modal. Titled by the friendly agent name (orca-Iris → Iris)
 *  with the task it's working on as subtitle, and auto-closes once the agent is done. */
export function TerminalModal({ session, onClose }: { session: string; onClose: () => void }) {
  const tasks = useTasks();
  const task = taskForSession(tasks.data ?? [], session);
  useCloseOnAgentDone(session, task, onClose);
  return (
    <Modal title={agentDisplayName(session)} description={task?.title} onClose={onClose} icon={TerminalSquare}>
      <TerminalPanel name={session} onKilled={onClose} />
    </Modal>
  );
}
