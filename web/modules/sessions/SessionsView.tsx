'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { TerminalSquare, ArrowRight, List, Bell, Maximize2, Minimize2 } from 'lucide-react';
import { useSessionInfos, useSessionSignals } from '../../lib/queries';
import { needsInputSessions } from '../../lib/agentUtils';
import { usePersistentState } from '../../lib/usePersistentState';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Segmented } from '../../components/ui/Segmented';
import { Button } from '../../components/ui/Button';
import { TerminalModal } from '../../components/terminal/TerminalModal';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { SessionCard } from './SessionCard';
import { BrainSessionsPanel } from './BrainSessionsPanel';

export function SessionsView() {
  const sessions = useSessionInfos();
  const signals = useSessionSignals();
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useTranslation();
  const [openTerm, setOpenTerm] = useState<string | null>(null);
  const [density, setDensity] = usePersistentState<'comfortable' | 'compact'>('elowen.sessions.density', 'comfortable', ['comfortable', 'compact']);

  const compact = density === 'compact';

  const filter = params.get('filter') === 'needs_input' ? 'needs_input' : 'all';
  const infos = sessions.data ?? [];
  const byName = new Map(infos.map((i) => [i.name, i] as const));
  const allNames = infos.map((i) => i.name);
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
            <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: t.sessions.filterAll, icon: List }, { value: 'needs_input', label: t.sessions.filterNeedsInput, icon: Bell }]} nowrap />
            <Segmented value={density} onChange={(v) => setDensity(v as 'comfortable' | 'compact')} options={[{ value: 'comfortable', label: t.sessions.comfortable, icon: Maximize2 }, { value: 'compact', label: t.sessions.compact, icon: Minimize2 }]} nowrap />
          </>
        ) : null}
      </ModuleHeader>

      <div className="@container">
      <div className="flex flex-col gap-6 @3xl:flex-row @3xl:items-start">
        {/* Main: the live agent (tmux) sessions. */}
        <div className="min-w-0 flex-1">
          {sessions.isLoading ? <LoadingState variant="cards" />
            : sessions.isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={() => sessions.refetch()} />
            : names.length > 0 ? (
              <div className="@container">
              <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
                {names.map((s) => {
                  const info = byName.get(s);
                  if (!info) return null;
                  return <SessionCard key={s} info={info} compact={compact} onOpenTerminal={() => setOpenTerm(s)} />;
                })}
              </div>
              </div>
            ) : filter === 'needs_input' && allNames.length > 0
              ? <EmptyState title={t.sessions.filterNeedsInput} description={t.sessions.noNeedsInput} icon={TerminalSquare} />
              : <EmptyState title={t.sessions.empty} description={t.sessions.emptyDescription} icon={TerminalSquare} action={<Button variant="accent" icon={ArrowRight} onClick={() => router.push('/tasks')}>{t.sessions.emptyAction}</Button>} />}
        </div>

        {/* Right rail: brain conversations — admins see all users' (oversight), a regular user sees
            their own. Clickable → open/continue in the web chat. */}
        <aside className="flex shrink-0 flex-col gap-4 @3xl:w-72">
          <BrainSessionsPanel />
        </aside>
      </div>
      </div>

      {openTerm && <TerminalModal session={openTerm} onClose={() => setOpenTerm(null)} />}
    </>
  );
}
