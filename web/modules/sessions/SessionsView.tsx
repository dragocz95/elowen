'use client';
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { TerminalSquare, ArrowRight } from 'lucide-react';
import { useSessions, useSessionSignals } from '../../lib/queries';
import { needsInputSessions } from '../../lib/agentUtils';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Segmented } from '../../components/ui/Segmented';
import { Button } from '../../components/ui/Button';
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

  // Persist the density preference across sessions.
  useEffect(() => {
    const saved = localStorage.getItem('orca.sessions.density');
    if (saved === 'compact' || saved === 'comfortable') setDensity(saved);
  }, []);
  const changeDensity = (v: string) => {
    const next = v as 'comfortable' | 'compact';
    setDensity(next);
    try { localStorage.setItem('orca.sessions.density', next); } catch { /* ignore quota/SSR */ }
  };

  const compact = density === 'compact';

  const filter = params.get('filter') === 'needs_input' ? 'needs_input' : 'all';
  const allNames = sessions.data ?? [];
  // Sort: needs_input first, then working sessions, then the rest (alphabetical fallback).
  const rank = (name: string): number => {
    const s = signals[name]?.type;
    if (s === 'needs_input') return 0;
    if (s === 'working') return 1;
    return 2;
  };
  const sortedAll = [...allNames].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
  const names = filter === 'needs_input' ? needsInputSessions(sortedAll, signals) : sortedAll;
  const setFilter = (f: string) => router.replace(f === 'needs_input' ? '/sessions?filter=needs_input' : '/sessions');

  return (
    <>
      <ModuleHeader title={t.page.sessions} count={names.length} icon={TerminalSquare}>
        {allNames.length > 0 ? (
          <>
            <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: t.sessions.filterAll }, { value: 'needs_input', label: t.sessions.filterNeedsInput }]} />
            <Segmented value={density} onChange={changeDensity} options={[{ value: 'comfortable', label: t.sessions.comfortable }, { value: 'compact', label: t.sessions.compact }]} />
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
          : <EmptyState title={t.sessions.empty} description={t.sessions.emptyDescription} icon={TerminalSquare} action={<Button variant="accent" icon={ArrowRight} onClick={() => router.push('/tasks')}>{t.sessions.emptyAction}</Button>} />}

      {openTerm && (
        <Modal title={t.sessions.terminalTitle.replace('{name}', openTerm)} onClose={() => setOpenTerm(null)}>
          <TerminalPanel name={openTerm} onKilled={() => setOpenTerm(null)} />
        </Modal>
      )}
    </>
  );
}
