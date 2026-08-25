import type { Tone } from '../components/ui/tone';

type StatusToneState = 'open' | 'in_progress' | 'blocked' | 'closed' | 'cancelled';

/** Stable visual tones for the generic lifecycle states shared by host and plugin surfaces. */
const MAP: Record<StatusToneState, Tone> = {
  open: 'success',     // green — ready
  in_progress: 'warning', // amber — actively working
  blocked: 'danger',
  closed: 'danger',    // red — done/closed (per design: like the delete action)
  cancelled: 'muted',
};

export function statusTone(status: StatusToneState): Tone {
  return MAP[status];
}
