import type { Tone } from '../../components/ui/tone';

// The icon map is HOST-owned (web/lib/eventMeta): the core activity tile renders it too, and the
// activity log stays in core when the timeline view moves out. Re-exported for this module's own views.
export { eventIcon } from '../../lib/eventMeta';

export function eventTone(type: string): Tone {
  switch (type) {
    case 'task': return 'accent';
    case 'mission': return 'accent';
    case 'signal': return 'muted';
    case 'review': return 'warning';
    default: return 'default';
  }
}

/** Tone for a single marker, refined by its detail/status (not just its kind). Review verdicts carry
 *  their outcome in the detail (`approved: …` / `escalated: …`), and task/mission events carry a
 *  status — so a closed task reads red, an open one green, a review verdict green/red. Falls back to
 *  the kind's base tone. */
export function markerTone(type: string, detail: string): Tone {
  if (detail.startsWith('escalated')) return 'danger';
  if (detail.startsWith('approved')) return 'success';
  switch (detail) {
    case 'complete': case 'open': return 'success';
    case 'working': case 'in_progress': case 'needs_input': return 'warning';
    case 'closed': case 'blocked': case 'cancelled': return 'danger';
    case 'active': return 'accent';
    default: return eventTone(type);
  }
}
