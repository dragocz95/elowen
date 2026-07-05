'use client';
import { Brain, MessagesSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useUserStats } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { ModelIcon } from '../../components/ui/ModelIcon';

/** One compact stat chip: icon + value, with the metric name as a tooltip/label. */
function Chip({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated px-2 py-1 text-xs text-text" title={label}>
      <Icon size={13} className="shrink-0 text-text-muted" aria-hidden />
      <span className="sr-only">{`${label}: `}</span>
      {children}
    </span>
  );
}

/** Compact inline overview of a user's stats — memory count, session count, most-used model — shown in
 *  the detail header beside the name. Each metric has an explicit empty state so a fresh user never
 *  reads as a bare "0", and the (possibly long) model id truncates instead of overflowing. */
export function UserStatsInline({ userId }: { userId: number }) {
  const { t } = useTranslation();
  const stats = useUserStats(userId);
  const d = stats.data;
  if (!d) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Chip icon={Brain} label={t.users.statMemories}>
        {d.memoryCount > 0 ? <span className="font-mono tabular-nums">{d.memoryCount}</span> : <span className="italic text-text-muted">{t.users.noMemories}</span>}
      </Chip>
      <Chip icon={MessagesSquare} label={t.users.statSessions}>
        {d.sessionCount > 0 ? <span className="font-mono tabular-nums">{d.sessionCount}</span> : <span className="italic text-text-muted">{t.users.noSessions}</span>}
      </Chip>
      <span
        className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border border-border bg-elevated px-2 py-1 text-xs text-text"
        title={`${t.users.statTopModel}: ${d.topModel ?? ''}`}
      >
        {d.topModel
          ? <><span className="shrink-0"><ModelIcon name={d.topModel} size={13} /></span><span className="truncate font-mono">{d.topModel}</span></>
          : <span className="italic text-text-muted">{t.users.noModel}</span>}
      </span>
    </div>
  );
}
