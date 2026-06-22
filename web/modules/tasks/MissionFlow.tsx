'use client';
import { Fragment } from 'react';
import { Rocket } from 'lucide-react';
import type { Task } from '../../lib/types';
import { useSessions, useSessionSignals, useConfig } from '../../lib/queries';
import { taskExec } from '../../lib/taskExec';
import { taskAgentName, taskSessionName } from '../../lib/agentUtils';
import { epicProgress } from '../../lib/taskTree';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { AgentStatusDot } from '../../components/ui/AgentStatusDot';
import { Badge } from '../../components/ui/Badge';
import { statusTone } from '../dashboard/statusTone';
import { statusLabel } from './taskMeta';
import { useTranslation } from '../../lib/i18n';

/** Mission Flow — a vertical node-graph of an autopilot epic and its sequential phases. Each phase
 *  node hangs off its model + agent sub-chips (like an n8n flow), with animated connectors, a pulsing
 *  active node and hover lift. Clicking a phase node drills into that phase's detail (the agent view).
 *  Purely presentational over data the tasks page already has — no new fetches of its own beyond the
 *  shared sessions/signals/config caches used everywhere else. */
export function MissionFlow({ epic, phases, activeId, onSelectPhase }: {
  epic: Task;
  phases: Task[];
  activeId?: string | null;
  onSelectPhase: (id: string) => void;
}) {
  const { t } = useTranslation();
  const sessions = useSessions();
  const signals = useSessionSignals();
  const { data: config } = useConfig();
  const live = new Set(sessions.data ?? []);
  const { done, total } = epicProgress(phases);

  return (
    <div className="flex flex-col">
      {/* Epic node — the mission root. */}
      <div className="flex items-center gap-3 rounded-xl border border-accent/40 bg-accent/[0.06] p-3" style={{ boxShadow: 'var(--shadow-card)' }}>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated">
          <Rocket size={20} className="text-accent" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-text">{epic.title}</h2>
          <span className="font-mono text-[11px] text-text-muted">{done}/{total} {t.tasks.phasesLabel}</span>
        </div>
        <Badge tone={statusTone(epic.status)}>{statusLabel(t, epic.status)}</Badge>
      </div>

      {phases.map((phase, i) => {
        const exec = taskExec(phase.labels) || config?.defaults?.exec || '';
        const agent = taskAgentName(phase);
        const session = taskSessionName(phase);
        const running = phase.status === 'in_progress' && !!session && live.has(session);
        const signal = session ? signals[session] : undefined;
        const isActive = running || signal?.type === 'needs_input';

        return (
          <Fragment key={phase.id}>
            {/* Vertical connector flowing down from the node above. */}
            <div className="ml-5 flex h-6 w-px justify-center">
              <span className={`h-full w-px ${isActive ? 'flow-edge flow-edge-active' : 'flow-edge'}`} aria-hidden />
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {/* Phase node — the whole card drills into the phase detail (agent view). */}
              <button
                type="button"
                onClick={() => onSelectPhase(phase.id)}
                className={`group flex min-w-0 flex-1 items-center gap-3 rounded-xl border bg-surface p-3 text-left transition-all hover:-translate-y-0.5 ${activeId === phase.id ? 'border-accent' : 'border-border hover:border-border-strong'} ${isActive ? 'flow-active' : ''}`}
                style={{ boxShadow: 'var(--shadow-card)', transitionDuration: 'var(--motion-fast)' }}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-elevated font-mono text-[11px] text-text-muted">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{phase.title}</span>
                <Badge tone={statusTone(phase.status)}>{statusLabel(t, phase.status)}</Badge>
              </button>

              {/* Sub-chips: model + agent hang off the node, like an n8n flow. */}
              {(exec || agent) ? (
                <>
                  <span className="hidden h-px w-6 shrink-0 sm:block flow-edge-h" aria-hidden />
                  <div className="flex shrink-0 flex-col gap-1.5 pl-8 sm:pl-0">
                    {exec ? (
                      <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-elevated px-2 py-1 text-[11px] text-text-muted" title={exec}>
                        <ModelIcon name={exec} size={14} />
                        <span className="font-mono">{exec}</span>
                      </span>
                    ) : null}
                    {agent ? (
                      <button
                        type="button"
                        onClick={() => onSelectPhase(phase.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-elevated px-2 py-1 text-[11px] text-text transition-colors hover:border-border-strong"
                        title={agent}
                      >
                        <AgentStatusDot signal={signal} live={running} size="sm" />
                        <span className="font-mono">{agent}</span>
                      </button>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
