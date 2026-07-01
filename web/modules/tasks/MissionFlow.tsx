'use client';
import { type MouseEvent } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Rocket, Coins, Clock, Layers } from 'lucide-react';
import type { Task } from '../../lib/types';
import { orcaClient } from '../../lib/orcaClient';
import { useSessions, useSessionSignals, useConfig } from '../../lib/queries';
import { taskExec, taskSessionName, taskElapsedMs } from '../../lib/agentUtils';
import { formatCost, formatDuration } from '../../lib/format';
import { Badge } from '../../components/ui/Badge';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { statusTone } from '../dashboard/statusTone';
import { statusLabel } from './taskMeta';
import { ResultSummary } from './ResultSummary';
import { PhaseLogRow } from './PhaseLogRow';
import { useTranslation } from '../../lib/i18n';

/** A small rounded metric chip for the mission's headline stats (cost / duration / phases / model). */
function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 py-1 text-xs text-text-muted">
      {children}
    </span>
  );
}

/** Mission view — an autopilot mission rendered "deployment-summary" style: a hero header with the
 *  full goal, the finished result lifted to the top, a row of headline metric pills (total cost, run
 *  time, phase count, model), then a compact log of phases each carrying its agent's note. No graph —
 *  the left list already carries the mission's progress. Clicking a phase drills into its agent
 *  detail. Purely presentational over the shared sessions/signals/usage caches. */
export function MissionFlow({ epic, phases, activeId, onSelectPhase, onContextMenu }: {
  epic: Task;
  phases: Task[];
  activeId?: string | null;
  onSelectPhase: (id: string) => void;
  onContextMenu?: (e: MouseEvent, task: Task) => void;
}) {
  const { t } = useTranslation();
  const sessions = useSessions();
  const signals = useSessionSignals();
  const { data: config } = useConfig();
  const live = new Set(sessions.data ?? []);

  // Batched per-phase cost, sharing the ['task-usage', id] cache with the phase cards / epic rollup.
  const usage = useQueries({
    queries: phases.map((p) => ({
      queryKey: ['task-usage', p.id],
      queryFn: () => orcaClient.taskUsage(p.id),
      staleTime: 5 * 60 * 1000,
    })),
  });

  // Headline metrics. Cost sums what the CLIs recorded (claude/codex report none → stays 0, pill
  // hidden); duration sums each phase's real run time; model lists the distinct execs that ran.
  const totalCost = usage.reduce((sum, u) => sum + (u.data?.costUsd ?? 0), 0);
  const now = Date.now();
  const totalMs = phases.reduce((sum, p) => sum + (taskElapsedMs(p, now) ?? 0), 0);
  const execs = [...new Set(phases.map((p) => taskExec(p.labels) || config?.defaults?.exec || '').filter(Boolean))];

  return (
    <div className="flex flex-col gap-4">
      {/* Hero header — the mission root. The title carries the full goal (autopilot stores the whole
       *  brief as the epic title), so it wraps and is shown in full. */}
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-elevated">
          <Rocket size={22} className="text-accent" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="whitespace-pre-wrap break-words text-base font-semibold leading-snug text-text">{epic.title}</h2>
          {epic.description?.trim() && epic.description.trim() !== epic.title.trim() ? (
            <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-text-muted">{epic.description}</p>
          ) : null}
        </div>
        <Badge tone={statusTone(epic.status)}>{statusLabel(t, epic.status)}</Badge>
      </div>

      {/* Result, lifted to the top — usually the thing you came to read. Hidden while in progress. */}
      <ResultSummary task={epic} />

      {/* Headline metric pills. */}
      <div className="flex flex-wrap items-center gap-2">
        {totalCost > 0 ? <Pill><Coins size={13} className="text-approve" aria-hidden />{formatCost(totalCost)}</Pill> : null}
        {totalMs > 0 ? <Pill><Clock size={13} aria-hidden />{formatDuration(totalMs)}</Pill> : null}
        <Pill><Layers size={13} aria-hidden />{phases.length} {t.tasks.phasesLabel}</Pill>
        {execs.length === 1 ? (
          <Pill><ModelIcon name={execs[0]!} size={14} /><span className="font-mono">{execs[0]}</span></Pill>
        ) : execs.length > 1 ? (
          <span title={execs.join(', ')}><Pill>{execs.map((e) => <ModelIcon key={e} name={e} size={14} />)}</Pill></span>
        ) : null}
      </div>

      {/* Phase log — each agent's step with its note. */}
      <div className="flex flex-col gap-0.5">
        <span className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{t.tasks.missionProgress}</span>
        {phases.map((phase, i) => {
          const session = taskSessionName(phase);
          const running = phase.status === 'in_progress' && !!session && live.has(session);
          const signal = session ? signals[session] : undefined;
          return (
            <PhaseLogRow
              key={phase.id}
              phase={phase}
              index={i}
              running={running}
              signal={signal}
              isActive={running || signal?.type === 'needs_input'}
              exec={taskExec(phase.labels) || config?.defaults?.exec || ''}
              isSelected={activeId === phase.id}
              onSelect={onSelectPhase}
              onContextMenu={onContextMenu}
            />
          );
        })}
      </div>
    </div>
  );
}
