'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { TerminalSquare, ArrowRight, List, Bell } from 'lucide-react';
import { useSessionInfos, useSessionSignals } from '../../lib/queries';
import { needsInputSessions } from '../../lib/agentUtils';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Segmented } from '../../components/ui/Segmented';
import { Button } from '../../components/ui/Button';
import { TerminalModal } from '../../components/terminal/TerminalModal';
import { LoadingState, ErrorState } from '../../components/ui/states';
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
      <ModuleHeader title={t.page.sessions} icon={TerminalSquare} />

      <div className="@container">
      <div className="flex flex-col gap-10">
        <section className="min-w-0">
          <div className="flex flex-col gap-3 border-b border-border/80 pb-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <h2 className="text-base font-semibold text-text">{t.sessions.liveTitle}</h2>
                <span className="font-mono text-xs text-text-muted">{names.length}</span>
              </div>
              <p className="text-xs text-text-muted">{t.sessions.liveHint}</p>
            </div>
            {allNames.length > 0 ? (
              <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: 'all', label: t.sessions.filterAll, icon: List }, { value: 'needs_input', label: t.sessions.filterNeedsInput, icon: Bell }]} nowrap />
            ) : null}
          </div>

          {sessions.isLoading ? <LoadingState variant="list" />
            : sessions.isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={() => sessions.refetch()} />
            : names.length > 0 ? (
              <div data-testid="live-sessions-list" className="flex flex-col">
                {names.map((s) => {
                  const info = byName.get(s);
                  if (!info) return null;
                  return <SessionCard key={s} info={info} compact onOpenTerminal={() => setOpenTerm(s)} />;
                })}
              </div>
            ) : filter === 'needs_input' && allNames.length > 0
              ? <p className="border-b border-border/80 py-7 text-sm text-text-muted">{t.sessions.noNeedsInput}</p>
              : (
                <div className="flex flex-col gap-4 border-b border-border/80 py-6 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-border text-text-muted"><TerminalSquare size={17} aria-hidden /></span>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-text">{t.sessions.empty}</span>
                      <span className="text-xs text-text-muted">{t.sessions.emptyDescription}</span>
                    </div>
                  </div>
                  <Button variant="accent" icon={ArrowRight} onClick={() => router.push('/tasks')}>{t.sessions.emptyAction}</Button>
                </div>
              )}
        </section>

        <BrainSessionsPanel />
      </div>
      </div>

      {openTerm && <TerminalModal session={openTerm} onClose={() => setOpenTerm(null)} />}
    </>
  );
}
