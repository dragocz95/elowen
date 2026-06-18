'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { TerminalSquare } from 'lucide-react';
import { useSessions, useSessionSignals } from '../../lib/queries';
import { needsInputSessions } from '../../lib/agentUtils';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Segmented } from '../../components/ui/Segmented';
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
  const signals = useSessionSignals();
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useTranslation();
  const [openTerm, setOpenTerm] = useState<string | null>(null);
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const compact = density === 'compact';

  const filter = params.get('filter') === 'needs_input' ? 'needs_input' : 'all';
  const allNames = sessions.data ?? [];
  const names = filter === 'needs_input' ? needsInputSessions(allNames, signals) : allNames;
  const setFilter = (f: string) => router.replace(f === 'needs_input' ? '/sessions?filter=needs_input' : '/sessions');

  return (
    <>
      <ModuleHeader title={t.page.sessions} count={names.length} icon={TerminalSquare}>
        {allNames.length > 0 ? (
          <>
            <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: t.sessions.filterAll }, { value: 'needs_input', label: t.sessions.filterNeedsInput }]} />
            <Segmented value={density} onChange={(v) => setDensity(v as 'comfortable' | 'compact')} options={[{ value: 'comfortable', label: t.sessions.comfortable }, { value: 'compact', label: t.sessions.compact }]} />
          </>
        ) : null}
      </ModuleHeader>

      {sessions.isLoading ? <LoadingState variant="cards" />
        : sessions.isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={() => sessions.refetch()} />
        : names.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {names.map((s) => <SessionCard key={s} name={s} compact={compact} onOpenTerminal={() => setOpenTerm(s)} />)}
          </div>
        ) : filter === 'needs_input' && allNames.length > 0
          ? <EmptyState title={t.sessions.filterNeedsInput} description={t.sessions.noNeedsInput} icon={TerminalSquare} />
          : <EmptyState title={t.sessions.empty} description={t.sessions.emptyDescription} icon={TerminalSquare} />}

      {openTerm && (
        <Modal title={t.sessions.terminalTitle.replace('{name}', openTerm)} onClose={() => setOpenTerm(null)}>
          <TerminalPanel name={openTerm} onKilled={() => setOpenTerm(null)} />
        </Modal>
      )}
    </>
  );
}
