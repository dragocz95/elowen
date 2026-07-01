import type { Task } from '../../lib/types';

/** One ribbon segment per phase, coloured by its status. When `active` is false the accent-toned
 *  states (done / running) soften to a lighter blue — so a list of cards reads gently blue and the
 *  colour sharpens on the opened card. */
const phaseColor = (status: string, active: boolean): string =>
  status === 'closed' ? (active ? 'bg-accent' : 'bg-accent/40')
  : status === 'in_progress' ? (active ? 'bg-accent/60' : 'bg-accent/30')
  : status === 'blocked' ? 'bg-danger'
  : status === 'cancelled' ? 'bg-elevated'
  : 'bg-border-strong';

/** Compact segmented progress bar for an epic/mission's phases. */
export function ProgressRibbon({ phases, className = '', active = true }: { phases: Task[]; className?: string; active?: boolean }) {
  return (
    <div className={`flex h-1.5 gap-0.5 overflow-hidden rounded-full ${className}`}>
      {phases.length === 0
        ? <div className="h-full flex-1 rounded-full bg-elevated" />
        : phases.map((p) => <div key={p.id} className={`h-full flex-1 rounded-full transition-colors ${phaseColor(p.status, active)}`} style={{ transitionDuration: 'var(--motion-base)' }} title={`${p.title} — ${p.status}`} />)}
    </div>
  );
}
