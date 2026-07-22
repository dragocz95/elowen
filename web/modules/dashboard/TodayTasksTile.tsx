'use client';
import { useMemo } from 'react';
import { Check } from 'lucide-react';
import { useTasks } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { parseTs } from '../../lib/format';
import type { Task } from '../../lib/types';

const isSameDay = (ms: number | null, now: number): boolean => {
  if (ms == null) return false;
  const a = new Date(ms), b = new Date(now);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
};

/** Today's work: everything in progress, plus tasks closed or scheduled for today. Running ones sort
 *  first (with a "now" pill), then scheduled, then the day's completions (struck through). */
export function TodayTasksTile({ now }: { now: number }) {
  const { t } = useTranslation();
  const tasks = useTasks();

  const rows = useMemo(() => {
    const items = (tasks.data ?? []).filter((task: Task) =>
      task.status === 'in_progress'
      || (task.status === 'closed' && isSameDay(parseTs(task.closed_at), now))
      || (task.status !== 'closed' && task.status !== 'cancelled' && isSameDay(parseTs(task.scheduled_at), now)));
    const rank = (task: Task) => (task.status === 'in_progress' ? 0 : task.status === 'closed' ? 2 : 1);
    return items.sort((a, b) => rank(a) - rank(b)).slice(0, 4);
  }, [tasks.data, now]);

  const done = rows.filter((r) => r.status === 'closed').length;

  return (
    <section aria-labelledby="dashboard-tasks" className="px-1 py-6 @sm:px-3 @2xl:px-5">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 id="dashboard-tasks" className="dash-label">{t.dashboard.todayTasks}</h2>
        {rows.length > 0 ? <span className="font-mono text-[10px] tabular-nums text-text-muted">{t.dashboard.todayTasksCount.replace('{done}', String(done)).replace('{total}', String(rows.length))}</span> : null}
      </header>
      {rows.length === 0 ? (
        <p className="py-5 text-sm text-text-muted">{t.dashboard.todayTasksEmpty}</p>
      ) : (
        <div>
          {rows.map((task) => {
            const closed = task.status === 'closed';
            const running = task.status === 'in_progress';
            return (
              <div key={task.id} className="group flex items-center gap-3 py-2.5">
                <span className={`grid h-[17px] w-[17px] shrink-0 place-items-center rounded-full border transition-colors ${closed ? 'border-accent bg-accent text-bg' : running ? 'border-accent/70' : 'border-border-strong group-hover:border-text-muted'}`}>
                  {closed && <Check size={11} strokeWidth={3} aria-hidden />}
                </span>
                <span className={`flex-1 truncate text-[13.5px] ${closed ? 'text-text-muted line-through decoration-text-muted/50' : 'text-text'}`}>{task.title}</span>
                {running && (
                  <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-text-muted">
                    <span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />{t.dashboard.nowPill}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
