'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { TerminalSquare } from 'lucide-react';
import { useSessions } from '../../lib/queries';
import { Section } from '../../components/ui/Section';
import { Modal } from '../../components/ui/Modal';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { SessionCard } from './SessionCard';

// xterm references browser-only `self`; skip SSR to avoid prerender errors
const TerminalPanel = dynamic(
  () => import('../../components/terminal/TerminalPanel').then((m) => m.TerminalPanel),
  { ssr: false },
);

export function SessionsView() {
  const sessions = useSessions();
  const { t } = useTranslation();
  const [openTerm, setOpenTerm] = useState<string | null>(null);

  return (
    <>
      <Section title={t.page.sessions} icon={TerminalSquare}>
        {sessions.isLoading ? <LoadingState />
          : sessions.isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={() => sessions.refetch()} />
          : sessions.data && sessions.data.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {sessions.data.map((s) => <SessionCard key={s} name={s} onOpenTerminal={() => setOpenTerm(s)} />)}
            </div>
          ) : <EmptyState title={t.sessions.empty} description={t.sessions.emptyDescription} />}
      </Section>

      {openTerm && (
        <Modal title={t.sessions.terminalTitle.replace('{name}', openTerm)} onClose={() => setOpenTerm(null)}>
          <TerminalPanel name={openTerm} onKilled={() => setOpenTerm(null)} />
        </Modal>
      )}
    </>
  );
}
