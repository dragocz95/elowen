'use client';
import dynamic from 'next/dynamic';
import { TerminalSquare } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useTasks, useSessionInfos } from '../../lib/queries';
import { taskForSession, agentDisplayName } from '../../lib/agentUtils';
import { useCloseOnAgentDone } from '../../lib/useCloseOnAgentDone';
import { useTranslation } from '../../lib/i18n';

// xterm references browser-only `self`; skip SSR to avoid prerender errors.
const TerminalPanel = dynamic(() => import('./TerminalPanel').then((m) => m.TerminalPanel), { ssr: false });

/** The full agent terminal in a modal. Titled by the session's role/identity (Autopilot, Planner,
 *  or the friendly agent name) with the task it's working on as subtitle; auto-closes when done. */
export function TerminalModal({ session, onClose }: { session: string; onClose: () => void }) {
  const tasks = useTasks();
  const { t } = useTranslation();
  const info = useSessionInfos().data?.find((s) => s.name === session);
  const task = taskForSession(tasks.data ?? [], session);
  useCloseOnAgentDone(session, task, onClose);
  const title = info?.role === 'overseer' ? t.sessions.roleOverseer
    : info?.role === 'pilot' ? t.sessions.rolePilot
    : agentDisplayName(session);
  return (
    <Modal title={title} description={task?.title} onClose={onClose} icon={TerminalSquare}>
      <TerminalPanel name={session} onKilled={onClose} />
    </Modal>
  );
}
