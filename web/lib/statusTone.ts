import type { TaskStatus } from './types';
import type { Tone } from '../components/ui/tone';

/** Tone per task status. HOST-owned like `taskMeta`/`eventMeta` rather than owned by a view: the plugin
 *  UI runtime hands it to every bundle (`utils.statusTone`), so it must not live in a feature module —
 *  the contract would then depend on a module that is free to move into a plugin. */
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
