'use client';
import { type MouseEvent } from 'react';
import { Check, X, Circle, Timer } from 'lucide-react';
import type { Task, DerivedSignal } from '../../lib/types';
import { taskAgentName, taskElapsed } from '../../lib/agentUtils';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { AgentStatusDot } from '../../components/ui/AgentStatusDot';

type PhaseState = 'running' | 'done' | 'failed' | 'blocked' | 'pending';

function phaseState(task: Task, running: boolean): PhaseState {
  if (running || task.status === 'in_progress') return 'running';
  if (task.status === 'blocked') return 'blocked';
  if (task.status === 'cancelled') return 'failed';
  if (task.status === 'closed') return task.outcome === 'fail' ? 'failed' : 'done';
  return 'pending';
}

// A mission log reads "done = good" (success/green), unlike the generic status palette where a
// closed task is red. The status glyph sits left of the phase title.
function StateGlyph({ state, isActive }: { state: PhaseState; isActive: boolean }) {
  if (state === 'done') return <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success"><Check size={10} className="text-bg" strokeWidth={3} aria-hidden /></span>;
  if (state === 'failed') return <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-danger"><X size={10} className="text-bg" strokeWidth={3} aria-hidden /></span>;
  if (state === 'running') return <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent ${isActive ? 'flow-active' : ''}`}><span className="h-1.5 w-1.5 rounded-full bg-bg" aria-hidden /></span>;
  if (state === 'blocked') return <span className="h-4 w-4 shrink-0 rounded-full bg-warning" aria-hidden />;
  return <Circle size={16} className="shrink-0 text-border-strong" aria-hidden />;
}

export interface PhaseLogRowProps {
  phase: Task;
  index: number;
  running: boolean;
  signal?: DerivedSignal;
  isActive: boolean;
  exec: string;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onContextMenu?: (e: MouseEvent, task: Task) => void;
}

/** One phase as a compact log line: index · status glyph · title, with the model/agent and run time
 *  on the right, and the agent's note (the phase result summary) tucked beneath. Clicking drills into
 *  the phase's agent detail. */
export function PhaseLogRow({ phase, index, running, signal, isActive, exec, isSelected, onSelect, onContextMenu }: PhaseLogRowProps) {
  const state = phaseState(phase, running);
  const agent = taskAgentName(phase);
  const elapsed = taskElapsed(phase, Date.now());
  const note = phase.result_summary?.trim();

  return (
    <button
      type="button"
      onClick={() => onSelect(phase.id)}
      onContextMenu={(e) => onContextMenu?.(e, phase)}
      className={`group flex w-full flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${isSelected ? 'border-accent/50 bg-accent/[0.06]' : 'border-transparent hover:border-border hover:bg-elevated'}`}
      style={{ transitionDuration: 'var(--motion-fast)' }}
    >
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[11px] tabular-nums text-text-muted">{String(index + 1).padStart(2, '0')}</span>
        <StateGlyph state={state} isActive={isActive} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{phase.title}</span>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-text-muted">
          <ModelIcon name={exec} size={13} />
          {agent ? (
            <>
              <AgentStatusDot signal={signal} live={running} size="sm" />
              <span className="hidden sm:inline">{agent}</span>
            </>
          ) : null}
          {elapsed ? <><Timer size={11} aria-hidden />{elapsed}</> : null}
        </span>
      </div>
      {note ? (
        <p className="line-clamp-2 pl-[3.25rem] text-xs leading-relaxed text-text-muted">{note}</p>
      ) : null}
    </button>
  );
}
