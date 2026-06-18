'use client';
import Link from 'next/link';
import { TriangleAlert, CheckCircle2, XCircle } from 'lucide-react';
import { useTasks, useSessions, useSessionSignals } from '../../lib/queries';
import { needsInputSessions, lastClosedTask } from '../../lib/agentUtils';
import { useTranslation } from '../../lib/i18n';

/** Persistent operations status bar at the foot of the sidebar: agents needing attention,
 *  live agent count, and the last closed task's outcome. Collapses to icon badges. */
export function OpsStatusBar({ expanded }: { expanded: boolean }) {
  const { t } = useTranslation();
  const tasks = useTasks();
  const sessions = useSessions();
  const signals = useSessionSignals();

  const liveCount = (sessions.data ?? []).length;
  const needsCount = needsInputSessions(sessions.data ?? [], signals).length;
  const last = lastClosedTask(tasks.data ?? []);
  const lastFail = last?.outcome === 'fail';

  if (needsCount === 0 && liveCount === 0 && !last) return null;

  const liveDot = (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${liveCount > 0 ? 'live-dot' : ''}`}
      style={{ backgroundColor: liveCount > 0 ? 'var(--color-success)' : 'var(--color-border-strong)', ['--live-ring' as string]: 'color-mix(in srgb, var(--color-success) 50%, transparent)' }}
      aria-hidden
    />
  );

  if (!expanded) {
    return (
      <div className="flex flex-col items-center gap-2 border-t border-border py-2.5">
        {needsCount > 0 && (
          <Link href="/sessions?filter=needs_input" title={t.sidebar.needsAttention.replace('{count}', String(needsCount))} className="relative flex h-7 w-7 items-center justify-center rounded-md text-warning transition-colors hover:bg-elevated">
            <TriangleAlert size={15} aria-hidden />
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warning px-0.5 text-[9px] font-bold text-black">{needsCount}</span>
          </Link>
        )}
        <Link href="/sessions" title={t.sidebar.liveAgents.replace('{count}', String(liveCount))} className="flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-elevated">
          {liveDot}<span className="font-mono text-[11px] text-text-muted">{liveCount}</span>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 border-t border-border px-2 py-2">
      {needsCount > 0 && (
        <Link href="/sessions?filter=needs_input" className="flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium text-warning transition-colors hover:bg-elevated">
          <TriangleAlert size={13} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t.sidebar.needsAttention.replace('{count}', String(needsCount))}</span>
        </Link>
      )}
      <Link href="/sessions" className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-elevated">
        {liveDot}<span className="min-w-0 flex-1 truncate">{t.sidebar.liveAgents.replace('{count}', String(liveCount))}</span>
      </Link>
      {last && (
        <Link href={`/tasks?select=${encodeURIComponent(last.id)}`} title={last.result_summary ?? last.title} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-elevated">
          {lastFail ? <XCircle size={13} className="shrink-0 text-error" aria-hidden /> : <CheckCircle2 size={13} className="shrink-0 text-success" aria-hidden />}
          <span className="min-w-0 flex-1 truncate">{t.sidebar.lastOutcome.replace('{title}', last.title)}</span>
        </Link>
      )}
    </div>
  );
}
