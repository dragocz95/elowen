'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, XCircle, Hourglass } from 'lucide-react';
import { useTasks, useSessions } from '../../lib/queries';
import { lastClosedTask } from '../../lib/agentUtils';
import { useSessionStall } from '../../lib/useSessionStall';
import { useTranslation } from '../../lib/i18n';

/** One sensor per live session: reports its stuck state up via callback. Renders nothing. */
function StuckSensor({ name, onStuck }: { name: string; onStuck: (name: string, stuck: boolean) => void }) {
  const { state } = useSessionStall(name, true);
  const stuck = state === 'stuck';
  useEffect(() => { onStuck(name, stuck); }, [name, stuck, onStuck]);
  return null;
}

export function OpsStatusBar({ expanded }: { expanded: boolean }) {
  const { t } = useTranslation();
  const tasks = useTasks();
  const sessions = useSessions();

  const sessionNames = useMemo(() => sessions.data ?? [], [sessions.data]);
  const liveCount = sessionNames.length;
  const last = lastClosedTask(tasks.data ?? []);
  const lastFail = last?.outcome === 'fail';

  const [stuckMap, setStuckMap] = useState<Record<string, boolean>>({});
  const onStuck = useCallback((name: string, stuck: boolean) => {
    setStuckMap((m) => (m[name] === stuck ? m : { ...m, [name]: stuck }));
  }, []);
  // Prune sessions that are no longer live so the count doesn't linger.
  useEffect(() => {
    const live = new Set(sessionNames);
    setStuckMap((m) => {
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const [k, v] of Object.entries(m)) {
        if (live.has(k)) next[k] = v;
        else changed = true;
      }
      return changed ? next : m;
    });
  }, [sessionNames]);
  const stuckCount = sessionNames.filter((s) => stuckMap[s]).length;

  if (liveCount === 0 && !last) return null;

  const liveDot = (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${liveCount > 0 ? 'live-dot' : ''}`}
      style={{ backgroundColor: liveCount > 0 ? 'var(--color-success)' : 'var(--color-border-strong)', ['--live-ring' as string]: 'color-mix(in srgb, var(--color-success) 50%, transparent)' }}
      aria-hidden
    />
  );

  const sensors = sessionNames.map((s) => <StuckSensor key={s} name={s} onStuck={onStuck} />);

  if (!expanded) {
    return (
      <div className="flex flex-col items-center gap-2 border-t border-border py-2.5">
        {sensors}
        {stuckCount > 0 && (
          <Link href="/sessions" title={t.sidebar.stuckAgents.replace('{count}', String(stuckCount))} className="relative flex h-7 w-7 items-center justify-center rounded-md text-danger transition-colors hover:bg-elevated">
            <Hourglass size={15} aria-hidden />
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-danger px-0.5 text-[9px] font-bold text-bg">{stuckCount}</span>
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
      {sensors}
      {stuckCount > 0 && (
        <Link href="/sessions" className="flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium text-danger transition-colors hover:bg-elevated">
          <Hourglass size={13} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t.sidebar.stuckAgents.replace('{count}', String(stuckCount))}</span>
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
