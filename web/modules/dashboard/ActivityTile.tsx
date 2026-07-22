'use client';
import { eventIcon } from '../timeline/eventMeta';
import { useActivity } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { parseTs, compactElapsed } from '../../lib/format';
import type { ActivityEvent } from '../../lib/types';
import type { LocaleDict } from '../../lib/i18n/types';

/** A short human verb for an event, from its type + status detail (moved here from the old EventStream).
 *  The detail is a status string ('open'/'closed'/'complete'/'active'/'paused'…) or a review verdict
 *  ('approved: …'/'escalated: …'). */
function eventVerb(t: LocaleDict, type: string, detail: string): string {
  const e = t.dashboard.ev;
  if (type === 'review') return detail.startsWith('escalated') ? e.reviewEscalated : e.reviewApproved;
  if (type === 'mission') {
    if (detail === 'active') return e.missionActive;
    if (detail === 'paused') return e.missionPaused;
    if (detail === 'stalled') return e.missionStalled;
    return e.missionEnded;
  }
  if (type === 'message') return e.message;
  if (type === 'decision' || type === 'ask') return e.decision;
  if (type === 'signal') return detail === 'needs_input' ? e.needsInput : e.signal;
  if (detail === 'open') return e.taskOpen;
  if (detail === 'working' || detail === 'in_progress') return e.taskWorking;
  if (detail === 'blocked') return e.taskBlocked;
  if (detail === 'cancelled') return e.taskCancelled;
  return e.taskDone;
}

function EventRow({ event, last }: { event: ActivityEvent; last: boolean }) {
  const { t } = useTranslation();
  const Icon = eventIcon(event.type);
  const ts = parseTs(event.ts);
  return (
    <li className="group relative grid grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-x-3 py-2.5">
      {!last ? <span aria-hidden className="dash-beam absolute bottom-[-0.625rem] left-[0.59375rem] top-[1.75rem] w-px" /> : null}
      <span data-trunk-dot className="relative z-[1] mt-0.5 grid h-5 w-5 place-items-center rounded-full border border-accent/30 bg-bg shadow-[0_0_10px_rgb(255_82_54_/_0.14)] transition-colors group-hover:border-accent/60">
        <Icon size={11} className="text-text-muted" aria-hidden />
      </span>
      <span className="min-w-0 truncate text-[13px] leading-5">
        <span className="font-medium text-text">{eventVerb(t, event.type, event.detail)}</span>{' '}
        <span className="text-text-muted">{event.label || event.target}</span>
      </span>
      {ts != null && <span className="pt-0.5 font-mono text-[10px] tabular-nums text-text-muted">{compactElapsed(Date.now() - ts)}</span>}
    </li>
  );
}

/** The journal's chronological spine: newest daemon activity first, without a card shell. */
export function ActivityTile({ limit = 5 }: { limit?: number }) {
  const { t } = useTranslation();
  const activity = useActivity();
  const rows = (activity.data ?? []).filter((e) => e.type !== 'signal').slice(0, limit);
  return (
    <section aria-labelledby="dashboard-activity" className="px-1 py-6 @sm:px-3 @2xl:px-5">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 id="dashboard-activity" className="dash-label">{t.dashboard.eventStream}</h2>
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tabular-nums text-text-muted">
          <span aria-hidden className="live-dot h-1.5 w-1.5 rounded-full bg-success" />{t.dashboard.live}
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="py-5 text-sm text-text-muted">{t.dashboard.eventStreamEmpty}</p>
      ) : (
        <ol>{rows.map((e, index) => <EventRow key={e.id} event={e} last={index === rows.length - 1} />)}</ol>
      )}
    </section>
  );
}
