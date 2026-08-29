'use client';
import { eventIcon, surfaceIcon } from '../../lib/eventMeta';
import { useActivity, usePresence } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { parseTs, compactElapsed } from '../../lib/format';
import { LoadingState } from '../../components/ui/states';
import { Avatar } from '../../components/ui/Avatar';
import { PlatformIcon } from '../../components/ui/PlatformIcon';
import { ToolTrail } from './ToolTrail';
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
  // Drawn only when an account is actually behind the row — an unattributable turn, or one whose
  // account was deleted, has nobody to picture and falls back to the event medallion.
  const face = teamFeed && event.actor_user_id !== null && event.actor_label
    ? { id: event.actor_user_id, username: event.actor_username ?? event.actor_label, name: event.actor_label,
        ...(event.actor_avatar ? { avatar: event.actor_avatar } : {}) }
    : null;

  return (
    <li className="group relative grid grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-x-3 py-2">
      {/* The spine runs through the middle of the 2rem medallion column. */}
      {!last ? <span aria-hidden className="dash-beam absolute bottom-[-0.5rem] left-[0.96875rem] top-[2.25rem] w-px" /> : null}

      <span className="relative z-[1]">
        {face ? (
          <Avatar user={face} size={32} />
        ) : (
          <span
            data-trunk-dot
            className="grid h-8 w-8 place-items-center rounded-full border border-primary/30 bg-bg shadow-[0_0_10px_rgb(var(--primary-rgb)_/_0.14)] transition-colors group-hover:border-primary/60"
          >
            <Icon size={14} className="text-text-muted" aria-hidden />
          </span>
        )}
        {/* Where the work happened, as the platform's own mark — the same badge the pulse table uses,
            so Discord reads as Discord on both halves of the dashboard instead of a generic glyph. */}
        {teamFeed ? (
          <span className="absolute -bottom-1 -right-1 grid h-[18px] w-[18px] place-items-center rounded-full border-2 border-bg bg-elevated">
            <PlatformIcon platform={event.surface} size={11} />
          </span>
        ) : null}
      </span>

      <span className="min-w-0">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-medium leading-tight text-text">
            {teamFeed
              ? (event.actor_label || t.dashboard.ev.someone)
              : eventVerb(t, event.type, event.detail)}
          </span>
          {teamFeed && event.count > 1 ? (
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-text-subtle">×{event.count}</span>
          ) : null}
        </span>
        {/* What the turn actually ran. Falls back to the surface label when the daemon has no transcript
            for that window — an older row, or a turn whose tools have aged out of the read window. */}
        <span className="mt-1 block min-w-0">
          {teamFeed && event.tools?.length ? (
            <ToolTrail tools={event.tools} />
          ) : (
            <span className="block truncate text-[11px] leading-tight text-text-muted">
              {teamFeed
                ? `${t.dashboard.ev.turn} · ${surfaceLabel(t, event.surface)}`
                : (event.label || event.target)}
            </span>
          )}
        </span>
      </span>

      {ts != null && (
        <span className="pt-1 font-mono text-[10px] tabular-nums text-text-subtle">
          {compactElapsed(Date.now() - ts)}
        </span>
      )}
    </li>
  );
}

/** The journal's chronological spine: newest daemon activity first, without a card shell. */
export function ActivityTile({ limit = 14 }: { limit?: number }) {
  const { t } = useTranslation();
  // Fetch well past what the tile shows: rows are dropped client-side below, and asking for the exact
  // limit would leave the spine short. The server-side default is 200 rows.
  const activity = useActivity(undefined, limit * 5);
  // Presence also carries recently-seen people for the pulse rail; this line is only about NOW.
  const working = (usePresence().data ?? []).filter((p) => p.working);
  // A turn with no tools has nothing to say beyond "somebody was here", which the pulse tile already
  // reports better. Tools age out of the daemon's read window, so this also keeps the feed to the
  // stretch of the day it can actually describe rather than padding it with empty rows.
  const rows = (activity.data ?? [])
    .filter((e) => e.type !== 'signal')
    .filter((e) => e.type !== 'turn' || (e.tools?.length ?? 0) > 0)
    .slice(0, limit);
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
