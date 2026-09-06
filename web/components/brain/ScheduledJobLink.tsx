import { Clock } from 'lucide-react';
import type { ConversationJobLink } from '../../lib/types';

/** Labels a scheduled-job row needs, in the caller's locale. Passed in rather than read here so this
 *  renders inside a table cell and inside a sidebar row without either surface owning the wording. */
export interface ScheduledJobLabels {
  /** `Open the schedule: {name}` — the accessible name of the link. */
  open: string;
  active: string;
  paused: string;
}

/** The accessible name of a job link: what it opens, plus the state, because the paused mark next to the
 *  name is visual and a reader who cannot see it still has to learn that this schedule is not running. */
export function scheduledJobName(link: ConversationJobLink, labels: ScheduledJobLabels): string {
  return `${labels.open.replace('{name}', link.name)}, ${(link.enabled ? labels.active : labels.paused).toLowerCase()}`;
}

/** The visible content of one scheduled-job navigation row, shared by the chat sidebar and the
 *  conversation register so both describe the same schedule the same way.
 *
 *  A running schedule carries no state word: it is the normal case, and repeating "active" down a narrow
 *  sidebar is the clutter this feature exists to avoid. Only a PAUSED job says so, which is the state a
 *  reader actually needs to notice — and the accessible name above states both regardless. */
export function ScheduledJobLink({ link, labels }: { link: ConversationJobLink; labels: ScheduledJobLabels }) {
  return (
    <>
      <Clock size={12} aria-hidden className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{link.name}</span>
      {link.enabled ? null : (
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-tiny text-muted-foreground">{labels.paused}</span>
      )}
    </>
  );
}
