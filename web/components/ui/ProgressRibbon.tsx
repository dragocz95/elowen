import type { Task } from '../../lib/types';

/** One ribbon segment per phase, coloured by its status. */
const phaseColor = (status: string): string =>
  status === 'closed' ? 'bg-accent'
  : status === 'in_progress' ? 'bg-accent/60'
  : status === 'blocked' ? 'bg-danger'
  : status === 'cancelled' ? 'bg-elevated'
  : 'bg-border-strong';

/** Compact segmented progress bar for an epic/mission's phases. */
export function ProgressRibbon({ phases, className = '' }: { phases: Task[]; className?: string }) {
  return (
    <div className={`flex h-1.5 gap-0.5 overflow-hidden rounded-full ${className}`}>
      {phases.length === 0
        ? <div className="h-full flex-1 rounded-full bg-elevated" />
        : phases.map((p) => <div key={p.id} className={`h-full flex-1 rounded-full transition-colors ${phaseColor(p.status)}`} style={{ transitionDuration: 'var(--motion-base)' }} title={`${p.title} — ${p.status}`} />)}
    </div>
  );
}
