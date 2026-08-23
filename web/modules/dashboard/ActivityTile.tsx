'use client';
import { eventIcon, surfaceIcon } from '../../lib/eventMeta';
import { useActivity, usePresence } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { parseTs, compactElapsed } from '../../lib/format';
import { LoadingState } from '../../components/ui/states';
import type { ActivityEvent } from '../../lib/types';
import type { LocaleDict } from '../../lib/i18n/types';

/** A short human verb for an event, from its type + status detail (moved here from the old EventStream).
 *  The detail is a status string ('open'/'closed'/'complete'/'active'/'paused'…) or a review verdict
 *  ('approved: …'/'escalated: …'). */
export function eventVerb(t: LocaleDict, type: string, detail: string): string {
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
  if (type === 'sso.denied') return e.signInDenied;
  if (type === 'sso.provision') return e.accountProvisioned;
  if (type === 'sso.link') return e.accountLinked;
  if (type === 'sso.login') return e.signedIn;
  // The task ladder is reachable ONLY for a task row. It used to be the fallback for every type this
  // function did not recognise, so a sign-in — and any `plugin:<name>` row — rendered as "task
  // completed" beside a raw object id: the timeline confidently describing something that never
  // happened. An unrecognised row now says only that something happened, which is all it knows.
  if (type === 'task') {
    if (detail === 'open') return e.taskOpen;
    if (detail === 'working' || detail === 'in_progress') return e.taskWorking;
    if (detail === 'blocked') return e.taskBlocked;
    if (detail === 'cancelled') return e.taskCancelled;
    return e.taskDone;
  }
  return e.activity;
}

/** How a surface is named to a reader. An unrecognised one (including the honest 'unknown' the daemon
 *  records for a client that did not identify itself) is shown as-is rather than mislabelled. */
function surfaceLabel(t: LocaleDict, surface: string): string {
  const s = t.dashboard.surfaces as Record<string, string | undefined>;
  return s[surface] ?? surface;
}

function EventRow({ event, last }: { event: ActivityEvent; last: boolean }) {
  const { t } = useTranslation();
  // A team-feed row is about a PERSON, so it leads with their name and is drawn by where they worked;
  // every other row keeps the timeline's original shape (verb + object).
  const teamFeed = event.type === 'turn';
  const Icon = teamFeed ? surfaceIcon(event.surface) : eventIcon(event.type);
  // `ts` is the first occurrence in a folded row; the reader cares when it last happened.
  const ts = parseTs(teamFeed ? (event.last_ts ?? event.ts) : event.ts);
  return (
    <li className="group relative grid grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-x-3 py-2.5">
      {!last ? <span aria-hidden className="dash-beam absolute bottom-[-0.625rem] left-[0.59375rem] top-[1.75rem] w-px" /> : null}
      <span data-trunk-dot className="relative z-[1] mt-0.5 grid h-5 w-5 place-items-center rounded-full border border-accent/30 bg-bg shadow-[0_0_10px_rgb(255_82_54_/_0.14)] transition-colors group-hover:border-accent/60">
        <Icon size={11} className="text-text-muted" aria-hidden />
      </span>
      <span className="min-w-0 truncate text-[13px] leading-5">
        {teamFeed ? (
          <>
            <span className="font-medium text-text">{event.actor_label || t.dashboard.ev.someone}</span>{' '}
            <span className="text-text-muted">
              {t.dashboard.ev.turn} · {surfaceLabel(t, event.surface)}
              {event.count > 1 ? ` ×${event.count}` : ''}
            </span>
          </>
        ) : (
          <>
            <span className="font-medium text-text">{eventVerb(t, event.type, event.detail)}</span>{' '}
            <span className="text-text-muted">{event.label || event.target}</span>
          </>
        )}
      </span>
      {ts != null && <span className="pt-0.5 font-mono text-[10px] tabular-nums text-text-muted">{compactElapsed(Date.now() - ts)}</span>}
    </li>
  );
}

/** The journal's chronological spine: newest daemon activity first, without a card shell. */
export function ActivityTile({ limit = 5 }: { limit?: number }) {
  const { t } = useTranslation();
  // Fetch a little more than the tile shows: `signal` rows are dropped client-side, and asking for the
  // exact limit could leave the spine short. The server-side default is 200 rows — far more than a
  // five-row tile can use.
  const activity = useActivity(undefined, limit * 2 + 2);
  // Presence also carries recently-seen people for the pulse rail; this line is only about NOW.
  const working = (usePresence().data ?? []).filter((p) => p.working);
  const rows = (activity.data ?? []).filter((e) => e.type !== 'signal').slice(0, limit);
  return (
    <section aria-labelledby="dashboard-activity" className="px-1 py-6 @sm:px-3 @2xl:px-5">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 id="dashboard-activity" className="dash-label">{t.dashboard.eventStream}</h2>
        <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[10px] tabular-nums text-text-muted">
          <span aria-hidden className="live-dot h-1.5 w-1.5 rounded-full bg-success" />
          {/* Presence is the daemon's live view of running turns. Nobody working → the plain "live"
              badge, so the line never claims activity that is not happening. */}
          <span className="truncate">
            {working.length > 0 ? `${t.dashboard.workingNow}: ${working.map((w) => w.label).join(', ')}` : t.dashboard.live}
          </span>
        </span>
      </header>
      {activity.isLoading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <p className="py-5 text-sm text-text-muted">{t.dashboard.eventStreamEmpty}</p>
      ) : (
        <ol>{rows.map((e, index) => <EventRow key={e.id} event={e} last={index === rows.length - 1} />)}</ol>
      )}
    </section>
  );
}
