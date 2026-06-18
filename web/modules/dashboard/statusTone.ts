import type { TaskStatus } from '../../lib/types';
import type { Tone } from '../../components/ui/tone';

const MAP: Record<TaskStatus, Tone> = {
  open: 'success',     // green — ready
  in_progress: 'warning', // amber — actively working
  blocked: 'danger',
  closed: 'danger',    // red — done/closed (per design: like the delete action)
  cancelled: 'muted',
};

export function statusTone(status: TaskStatus): Tone {
  return MAP[status];
}
