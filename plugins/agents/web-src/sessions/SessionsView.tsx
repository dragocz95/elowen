import { useState } from 'react';
import { TerminalSquare, ArrowRight, List, Bell, MessageSquare, Activity, Bot, Eye } from 'lucide-react';
import { runtime } from '../runtime';
import { SessionCard } from './SessionCard';

const SESSION_VIEWS: readonly ('live' | 'brain')[] = ['live', 'brain'];

/** Deep-link filter (?filter=needs_input), kept in local state + history.replaceState — the plugin
 *  page owns its query string; a filter flip must not push a history entry (parity with the core
 *  page's router.replace). */
function initialFilter(): 'all' | 'needs_input' {
  return new URLSearchParams(window.location.search).get('filter') === 'needs_input' ? 'needs_input' : 'all';
}

export function SessionsView() {
  const { components: C, hooks, utils, navigate } = runtime();
  const sessions = hooks.useSessionInfos();
  const signals = hooks.useSessionSignals();
  const { t } = hooks.useTranslation();
  const [openTerm, setOpenTerm] = useState<string | null>(null);
  const [view, setView] = hooks.usePersistentState<'live' | 'brain'>('elowen.sessions.view', 'live', SESSION_VIEWS);
  const [filter, setFilterState] = useState<'all' | 'needs_input'>(initialFilter);

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
  const names = filter === 'needs_input' ? utils.needsInputSessions(sortedAll, signals) : sortedAll;
  const needsInputCount = utils.needsInputSessions(sortedAll, signals).length;
  const workerCount = infos.filter((info) => info.role !== 'pilot' && info.role !== 'overseer').length;
  const controlCount = infos.length - workerCount;
  const setFilter = (f: string) => {
    const next = f === 'needs_input' ? 'needs_input' : 'all';
    setFilterState(next);
    window.history.replaceState(null, '', next === 'needs_input' ? '/p/agents/sessions?filter=needs_input' : '/p/agents/sessions');
  };

  return (
    <>
      <C.ModuleHeader title={t.page.sessions} icon={TerminalSquare} />
      <C.SpatialWorkspaceLayout
        hero={{
          eyebrow: t.sessions.workspaceEyebrow,
          title: t.page.sessions,
          count: infos.length,
          description: t.sessions.workspaceIntro,
          mascotState: sessions.isLoading ? 'saving' : sessions.isError ? 'error' : 'idle',
          status: !sessions.isLoading && !sessions.isError ? <span className="workspace-status">{t.sessions.workspaceReady}</span> : undefined,
          metrics: <>
            <C.WorkspaceMetric label={t.sessions.metricLive} value={infos.length} icon={Activity} />
            <C.WorkspaceMetric label={t.sessions.metricNeedsInput} value={needsInputCount} icon={Bell} />
            <C.WorkspaceMetric label={t.sessions.metricWorkers} value={workerCount} icon={Bot} />
            <C.WorkspaceMetric label={t.sessions.metricControl} value={controlCount} icon={Eye} />
          </>,
        }}
        navigation={{ sections: [{ id: 'live', label: t.sessions.liveTitle, icon: TerminalSquare }, { id: 'brain', label: t.sessionsPanel.tab, icon: MessageSquare }], value: view, onChange: (id: string) => setView(id as 'live' | 'brain'), ariaLabel: t.page.sessions }}
      >
        <C.ControlSurfaceDocument>
        {view === 'live' ? <section className="min-w-0">
          <C.ControlSurfaceToolbar className="flex-col items-stretch gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <h2 className="text-base font-semibold text-text">{t.sessions.liveTitle}</h2>
                <span className="font-mono text-xs text-text-muted">{names.length}</span>
              </div>
              <p className="text-xs text-text-muted">{t.sessions.liveHint}</p>
            </div>
            {allNames.length > 0 ? (
              <C.Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: 'all', label: t.sessions.filterAll, icon: List }, { value: 'needs_input', label: t.sessions.filterNeedsInput, icon: Bell }]} nowrap />
            ) : null}
          </C.ControlSurfaceToolbar>

          <C.ControlSurfaceRegister>
          {sessions.isLoading ? <C.ControlSurfaceState><C.LoadingState variant="list" /></C.ControlSurfaceState>
            : sessions.isError ? <C.ControlSurfaceState tone="danger"><C.ErrorState message={t.common.daemonUnreachable} onRetry={() => sessions.refetch()} /></C.ControlSurfaceState>
            : names.length > 0 ? (
              <C.EntityList data-testid="live-sessions-list">
                <C.MotionPresence>
                  {names.map((s) => {
                    const info = byName.get(s);
                    if (!info) return null;
                    return (
                      <C.MotionLayoutItem key={s} layoutId={`live-session-${s}`} role="listitem">
                        <SessionCard info={info} compact onOpenTerminal={() => setOpenTerm(s)} />
                      </C.MotionLayoutItem>
                    );
                  })}
                </C.MotionPresence>
              </C.EntityList>
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
                  <C.Button variant="accent" icon={ArrowRight} onClick={() => navigate('/tasks')}>{t.sessions.emptyAction}</C.Button>
                </div>
              )}
          </C.ControlSurfaceRegister>
        </section> : <C.BrainSessionsPanel />}
        </C.ControlSurfaceDocument>
      </C.SpatialWorkspaceLayout>

      {openTerm && <C.TerminalModal session={openTerm} onClose={() => setOpenTerm(null)} />}
    </>
  );
}
