export interface ProgressRibbonPhase {
  id: string;
  title: string;
  status: string;
}

/** One ribbon segment per phase, coloured by its generic lifecycle status. */
const phaseColor = (status: string, active: boolean): string =>
  status === 'closed' ? (active ? 'bg-primary' : 'bg-primary/40')
  : status === 'in_progress' ? (active ? 'bg-primary/60' : 'bg-primary/30')
  : status === 'blocked' ? 'bg-destructive'
  : status === 'cancelled' ? 'bg-muted'
  : 'bg-border-strong';

/** Compact segmented progress bar for any ordered set of phases. */
export function ProgressRibbon({ phases, className = '', active = true }: { phases: ProgressRibbonPhase[]; className?: string; active?: boolean }) {
  return (
    <div className={`flex h-1.5 gap-0.5 overflow-hidden rounded-full ${className}`}>
      {phases.length === 0
        ? <div className="h-full flex-1 rounded-full bg-muted" />
        : phases.map((phase) => <div key={phase.id} className={`h-full flex-1 rounded-full transition-colors ${phaseColor(phase.status, active)}`} style={{ transitionDuration: 'var(--motion-base)' }} title={`${phase.title} — ${phase.status}`} />)}
    </div>
  );
}
