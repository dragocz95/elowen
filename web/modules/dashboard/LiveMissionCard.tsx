'use client';
import Link from 'next/link';
import { useQueries } from '@tanstack/react-query';
import { Rocket, Pause, Play, Power, Terminal, FileDiff, ArrowRight, Coins } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { ProgressRibbon } from '../../components/ui/ProgressRibbon';
import { AgentStatusDot } from '../../components/ui/AgentStatusDot';
import { CapacityMeter } from '../../components/ui/CapacityMeter';
import { IconButton } from '../../components/ui/IconButton';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { useSessionPane } from '../../lib/useSessionPane';
import { useSessionStall } from '../../lib/useSessionStall';
import { useMissionChangedFiles } from '../../lib/queries';
import { orcaClient } from '../../lib/orcaClient';
import { taskSessionName } from '../../lib/agentUtils';
import { epicCapacity } from '../../lib/taskTree';
import { parseAnsi } from '../../lib/ansi';
import { formatCost } from '../../lib/format';
import { baseName, dirName } from '../../lib/filePath';
import type { Mission, Task, DerivedSignal } from '../../lib/types';

/** The running phase for a mission: the first in_progress child with a live session (phases run
 *  sequentially). Shared shape with the old spotlight — the live agent is the one to preview. */
function currentRunningPhase(kids: Task[], sessionNames: string[]): Task | null {
  for (const k of kids) {
    if (k.status !== 'in_progress') continue;
    const s = taskSessionName(k);
    if (s && sessionNames.includes(s)) return k;
  }
  return null;
}

function stripAnsi(line: string): string {
  return parseAnsi(line).map((s) => s.text).join('');
}

/** A live mission "card": progress, the running phase's step + a mini terminal preview, the files it
 *  has changed so far, rolled-up cost, and its lifecycle controls. Replaces the old one-line spotlight
 *  row — the single place you watch an autopilot mission work. */
function LiveMissionCard({ mission, epic, kids, sessionNames, signals, onPause, onResume, onDisengage }: {
  mission: Mission;
  epic?: Task;
  kids: Task[];
  sessionNames: string[];
  signals: Record<string, DerivedSignal>;
  onPause: () => void;
  onResume: () => void;
  onDisengage: () => void;
}) {
  const { t } = useTranslation();
  const paused = mission.state === 'paused';
  const disengaged = mission.state === 'disengaged';
  const runningPhase = currentRunningPhase(kids, sessionNames);
  const sessionName = runningPhase ? taskSessionName(runningPhase) : null;
  const live = !!(sessionName && sessionNames.includes(sessionName));
  const signal = sessionName ? signals[sessionName] : undefined;
  const stall = useSessionStall(sessionName ?? '', live && !!sessionName);
  const cap = epicCapacity(kids, sessionNames, mission.max_sessions);

  // Rolled-up mission cost — sums each phase's agent cost, sharing the ['task-usage', id] cache with
  // the task cards. Only phases that actually ran are fetched: an 'open' phase never spun an agent,
  // so its usage is always null — querying it just wastes a round-trip per idle phase.
  const usage = useQueries({
    queries: kids.map((p) => ({ queryKey: ['task-usage', p.id], queryFn: () => orcaClient.taskUsage(p.id), staleTime: 5 * 60 * 1000, enabled: p.status !== 'open' })),
  });
  const totalCost = usage.reduce((sum, q) => sum + (q.data?.costUsd ?? 0), 0);

  const { tail } = useSessionPane(sessionName ?? '', 6, live && !!sessionName);
  const previewLines = tail.split('\n').map(stripAnsi).filter((l) => l.trim()).slice(-5);

  const changed = useMissionChangedFiles(mission.id);
  const files = (changed.data ?? []).slice(0, 5);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="flex items-center gap-2">
        <Link href="/tasks" className="min-w-0 flex-1 truncate text-sm font-semibold text-text hover:text-accent">{epic?.title ?? mission.epic_id}</Link>
        {!disengaged && !paused ? <CapacityMeter running={cap.running} max={cap.max} /> : null}
        <Badge tone={disengaged ? 'muted' : paused ? 'warning' : 'accent'}>{paused ? t.missions.statePaused : disengaged ? t.missions.stateDisengaged : t.missions.stateActive}</Badge>
      </div>

      <ProgressRibbon phases={kids} active className="w-full" />

      {runningPhase ? (
        <div className="flex items-center gap-2 text-[11px] text-text-muted">
          <AgentStatusDot signal={signal} live={live} size="sm" stall={stall.state} silenceSec={stall.silenceSec} />
          <span className="truncate">{runningPhase.title}</span>
        </div>
      ) : (
        <div className="text-[11px] text-text-muted">{t.missions.noTasks}</div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Mini terminal preview of the running phase. */}
        {previewLines.length > 0 ? (
          <div className="flex flex-col gap-1 rounded-md border border-border bg-bg p-2">
            <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-muted"><Terminal size={11} aria-hidden />{t.dashboard.missionTerminal}</span>
            <pre className="overflow-hidden whitespace-pre-wrap break-all font-mono text-[10px] leading-snug text-text-muted">{previewLines.join('\n')}</pre>
          </div>
        ) : null}

        {/* Files the mission has changed so far. */}
        <div className="flex flex-col gap-1 rounded-md border border-border bg-bg p-2">
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-muted"><FileDiff size={11} aria-hidden />{t.dashboard.missionChangedFiles}</span>
          {files.length === 0 ? (
            <span className="text-[11px] text-text-muted">{t.dashboard.missionNoChanges}</span>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {files.map((f) => (
                  <li key={f.path} className="flex items-center gap-1.5 font-mono text-[10px]" title={f.path}>
                    <span className="min-w-0 flex-1 truncate text-text-muted"><span className="opacity-60">{dirName(f.path)}</span><span className="text-text">{baseName(f.path)}</span></span>
                    <span className="shrink-0 tabular-nums text-success">+{f.added}</span>
                    <span className="shrink-0 tabular-nums text-danger">-{f.deleted}</span>
                  </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-border pt-2">
        {totalCost > 0 ? (
          <span className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums text-text-muted"><Coins size={12} className="text-approve" aria-hidden />{formatCost(totalCost)}</span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {disengaged ? null
            : paused ? <IconButton icon={Play} label={t.missions.resume} onClick={onResume} />
            : <IconButton icon={Pause} label={t.missions.pause} onClick={onPause} />}
          <IconButton icon={Power} label={t.missions.disengage} variant="danger" onClick={onDisengage} />
        </div>
      </div>
    </div>
  );
}

/** The live-missions section: one rich card per active/paused mission. Replaces AutopilotSpotlight. */
export function LiveMissions({ missions, tasks, sessionNames, signals, onPause, onResume, onDisengage, isLoading, isError, onRetry }: {
  missions: Mission[];
  tasks: Task[];
  sessionNames: string[];
  signals: Record<string, DerivedSignal>;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDisengage: (id: string) => void;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const active = missions.filter((m) => m.state !== 'disengaged');

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-muted">{t.dashboard.liveMissions}</h2>
        <Link href="/tasks" className="inline-flex items-center gap-1 text-xs font-medium text-accent transition-opacity hover:opacity-80">{t.dashboard.viewAll}<ArrowRight size={12} aria-hidden /></Link>
      </div>
      {isLoading ? <LoadingState variant="cards" />
        : isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={onRetry} />
        : active.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface" style={{ boxShadow: 'var(--shadow-card)' }}>
            <EmptyState title={t.dashboard.noActiveMissions} icon={Rocket} />
          </div>
        )
        : (
          <div className="flex flex-col gap-3">
            {active.map((m) => (
              <LiveMissionCard
                key={m.id}
                mission={m}
                epic={tasks.find((x) => x.id === m.epic_id)}
                kids={tasks.filter((x) => x.parent_id === m.epic_id)}
                sessionNames={sessionNames}
                signals={signals}
                onPause={() => onPause(m.id)}
                onResume={() => onResume(m.id)}
                onDisengage={() => onDisengage(m.id)}
              />
            ))}
          </div>
        )}
    </section>
  );
}
