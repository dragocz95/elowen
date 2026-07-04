'use client';
import { Activity } from 'lucide-react';
import { BentoTile } from './BentoTile';
import { Chip, type ChipTone } from './Chip';
import { eventIcon, markerTone } from '../timeline/eventMeta';
import { useActivity } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { parseTs, compactElapsed } from '../../lib/format';
import type { Tone } from '../../components/ui/tone';
import type { ActivityEvent } from '../../lib/types';
import type { LocaleDict } from '../../lib/i18n/types';

/** Marker tones collapse onto the chip palette (chips have no neutral `default`). */
const TONE_CHIP: Record<Tone, ChipTone> = {
  default: 'muted', muted: 'muted', accent: 'accent', success: 'success', warning: 'warning', danger: 'danger',
};

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

function EventRow({ event }: { event: ActivityEvent }) {
  const { t } = useTranslation();
  const tone = markerTone(event.type, event.detail);
  const ts = parseTs(event.ts);
  return (
    <div className="flex items-center gap-3 rounded-lg px-1.5 py-2 transition-colors hover:bg-elevated">
      <Chip tone={TONE_CHIP[tone]} icon={eventIcon(event.type)} size="sm" />
      <span className="min-w-0 flex-1 truncate text-[13px]">
        <span className="font-semibold">{eventVerb(t, event.type, event.detail)}</span>{' '}
        <span className="text-text-muted">{event.label || event.target}</span>
      </span>
      {ts != null && <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-muted">{compactElapsed(Date.now() - ts)}</span>}
    </div>
  );
}

/** The activity feed as a wide bento tile: the daemon's chronological log (signal churn filtered out),
 *  newest first, each row a colored chip + verb + subject + relative time. */
export function ActivityTile({ limit = 5 }: { limit?: number }) {
  const { t } = useTranslation();
  const activity = useActivity();
  const rows = (activity.data ?? []).filter((e) => e.type !== 'signal').slice(0, limit);
  return (
    <BentoTile tone="accent" icon={Activity} label={t.dashboard.eventStream} span="wide"
      trailing={<span className="rounded-full border border-border bg-elevated px-2.5 py-1 text-[11px] font-semibold text-text-muted">{t.dashboard.live}</span>}>
      {rows.length === 0 ? (
        <p className="flex flex-1 items-center justify-center py-4 text-center text-xs text-text-muted">{t.dashboard.eventStreamEmpty}</p>
      ) : (
        <div className="-mx-1.5 flex flex-col">{rows.map((e) => <EventRow key={e.id} event={e} />)}</div>
      )}
    </BentoTile>
  );
}
