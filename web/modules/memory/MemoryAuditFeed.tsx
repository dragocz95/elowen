'use client';
import { History, Plus, Pencil, Trash2, RotateCcw, GitMerge } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useMemoryEvents } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { formatTaskTime } from '../../lib/format';
import { TONE_TEXT } from '../../components/ui/tone';
import { memoryActionLabel, memoryActionTone, eventSummary } from './memoryMeta';

const ACTION_ICON: Record<string, LucideIcon> = {
  add: Plus,
  update: Pencil,
  delete: Trash2,
  restore: RotateCcw,
  merge: GitMerge,
};

/** A memory's audit trail (or the whole-user feed when `memoryId` is null): each event's action, who
 *  did it and why, and when — mirroring TaskConversation's activity log. Always enabled. */
export function MemoryAuditFeed({ memoryId }: { memoryId: number | null }) {
  const { t, locale } = useTranslation();
  const events = useMemoryEvents(memoryId);
  const rows = events.data ?? [];

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{t.memory.auditHeading}</span>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">{t.memory.auditEmpty}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((ev) => {
            const Icon = ACTION_ICON[ev.action] ?? History;
            const when = formatTaskTime(ev.created_at, Date.now(), locale);
            const summary = eventSummary(ev);
            return (
              <li key={ev.id} className="rounded-lg border border-border bg-surface p-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <Icon size={14} className={`shrink-0 ${TONE_TEXT[memoryActionTone(ev.action)]}`} aria-hidden />
                  <span className={`min-w-0 flex-1 truncate font-medium ${TONE_TEXT[memoryActionTone(ev.action)]}`}>{memoryActionLabel(t, ev.action)}</span>
                  <span className="shrink-0 font-mono text-[10px] text-text-muted">{ev.actor}</span>
                  {when.label ? <span className="shrink-0 text-text-muted" title={when.title}>{when.label}</span> : null}
                </div>
                {ev.reason ? <p className="mt-1 whitespace-pre-wrap pl-6 text-text-muted">{ev.reason}</p> : null}
                {summary ? <p className="mt-1 truncate pl-6 text-text-muted/80" title={summary}>{summary}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
