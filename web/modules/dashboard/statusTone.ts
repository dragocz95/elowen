import type { TaskStatus } from '../../lib/types';
import type { Tone } from '../../components/ui/tone';

const MAP: Record<TaskStatus, Tone> = {
  open: 'accent',
  in_progress: 'accent',
  blocked: 'danger',
  closed: 'muted',
  cancelled: 'muted',
};

export function statusTone(status: TaskStatus): Tone {
  return MAP[status];
}
