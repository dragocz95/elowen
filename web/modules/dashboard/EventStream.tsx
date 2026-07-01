'use client';
import { CircleDot, Rocket, ShieldCheck, MessageSquare, GitCommitHorizontal, CircleHelp, type LucideIcon } from 'lucide-react';
import { useActivity } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { markerTone } from '../timeline/eventMeta';
import { parseTs, compactElapsed } from '../../lib/format';
import { TONE_TEXT } from '../../components/ui/tone';
import type { ActivityEvent } from '../../lib/types';
import type { LocaleDict } from '../../lib/i18n/types';

function eventIcon(type: string): LucideIcon {
  if (type === 'review') return ShieldCheck;
  if (type === 'mission') return Rocket;
  if (type === 'message') return MessageSquare;
  if (type === 'change') return GitCommitHorizontal;
  if (type === 'decision' || type === 'ask') return CircleHelp;
  return CircleDot;
}

/** A short human verb for an event, from its type + status detail. The detail is a status string
 *  ('open'/'closed'/'complete'/'active'/'paused'…) or a review verdict ('approved: …'/'escalated: …'). */
function eventVerb(t: LocaleDict, type: string, detail: string): string {
  const e = t.dashboard.ev;
  if (type === 'review') return detail.startsWith('escalated') ? e.reviewEscalated : e.reviewApproved;
  if (type === 'mission') {
    if (detail === 'active') return e.missionActive;
    if (detail === 'paused') return e.missionPaused;
    if (detail === 'stalled') return e.missionStalled;
    return e.missionEnded; // 'disengaged' is the only terminal state — neutral, not "done" (may be a manual abandon)
  }
  if (type === 'message') return e.message;
  if (type === 'decision' || type === 'ask') return e.decision;
  if (type === 'signal') return detail === 'needs_input' ? e.needsInput : e.signal;
  // task
  if (detail === 'open') return e.taskOpen;
  if (detail === 'working' || detail === 'in_progress') return e.taskWorking;
  if (detail === 'blocked') return e.taskBlocked;
  if (detail === 'cancelled') return e.taskCancelled;
  return e.taskDone;
}

function EventRow({ event }: { event: ActivityEvent }) {
  const { t } = useTranslation();
  const tone = markerTone(event.type, event.detail);
  const Icon = eventIcon(event.type);
  const verb = eventVerb(t, event.type, event.detail);
  const title = event.label || event.target;
  const ts = parseTs(event.ts);
  const ago = ts != null ? compactElapsed(Date.now() - ts) : '';
  return (
    <li className="flex items-center gap-2.5 py-1.5">
      <Icon size={13} className={`shrink-0 ${TONE_TEXT[tone]}`} aria-hidden />
      <span className={`shrink-0 text-xs font-medium ${TONE_TEXT[tone]}`}>{verb}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-text-muted">{title}</span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-muted">{ago}</span>
    </li>
  );
}

/** The event stream: the daemon's chronological activity feed rendered as short sentences (icon +
 *  verb + subject + relative time), newest first. Fed by the persisted `/activity` log, kept live by
 *  the SSE `task`/`mission`/`review` events that invalidate it. Signal churn is filtered out — it's
 *  noise here (the constellation already shows live agent state). */
export function EventStream({ limit = 12 }: { limit?: number }) {
  const { t } = useTranslation();
  const activity = useActivity();
  const rows = (activity.data ?? [])
    .filter((e) => e.type !== 'signal')
    .slice(0, limit);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-muted">{t.dashboard.eventStream}</h2>
      <div className="rounded-lg border border-border bg-surface px-4 py-2" style={{ boxShadow: 'var(--shadow-card)' }}>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-text-muted">{t.dashboard.eventStreamEmpty}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {rows.map((e) => <EventRow key={e.id} event={e} />)}
          </ul>
        )}
      </div>
    </section>
  );
}
