'use client';
import Link from 'next/link';
import { useMemo, type ReactNode } from 'react';
import { ShieldQuestion, Coins, Radio, AlarmClock, ArrowUpRight, type LucideIcon } from 'lucide-react';
import { currentMonthBounds } from './metrics';
import { buildUsageSummary } from '../stats/usageBars';
import { nextCronRun } from '../../lib/cron';
import { formatCost } from '../../lib/format';
import { useTranslation } from '../../lib/i18n';
import {
  usePendingAsks, useEscalations, useModelUsage, useUsageByDay, useSessionInfos, useCronJobs, useMe,
} from '../../lib/queries';
import type { SessionInfo } from '../../lib/types';

function SignalRow({ icon: Icon, label, value, detail, href, alert = false }: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  href?: string;
  alert?: boolean;
}) {
  const content = (
    <>
      <Icon size={14} aria-hidden className={`mt-0.5 shrink-0 ${alert ? 'text-warning' : 'text-text-muted'}`} />
      <span className="min-w-0">
        <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">{label}</span>
        {detail ? <span className="mt-1 block truncate text-[11px] text-text-muted">{detail}</span> : null}
      </span>
      <span className={`flex items-center gap-1 font-mono text-sm font-semibold tabular-nums ${alert ? 'text-warning' : 'text-text'}`}>
        {value}{href ? <ArrowUpRight size={11} aria-hidden className="opacity-0 transition-opacity group-hover:opacity-100" /> : null}
      </span>
    </>
  );
  const className = "group grid grid-cols-[1rem_minmax(0,1fr)_auto] gap-3 border-t border-border/70 py-4 first:border-t-0";
  return href ? <Link href={href} className={className}>{content}</Link> : <div className={className}>{content}</div>;
}

/** Compact human-attention rail. Operational signals share one typographic column instead of four
 *  interchangeable cards, leaving the journal as the dashboard's main reading flow. */
export function AttentionRail({ now }: { now: number }) {
  const { t, locale } = useTranslation();
  const asks = usePendingAsks();
  const escalations = useEscalations();
  const decisions = (asks.data?.length ?? 0) + escalations.length;

  const infos = useSessionInfos();
  const agents = (infos.data ?? []).filter((session: SessionInfo) => session.role === 'agent').length;

  const me = useMe();
  const jobs = useCronJobs(me.data?.user?.is_admin ?? false);
  const next = useMemo(() => {
    let best: { at: number; name: string } | null = null;
    for (const job of jobs.data ?? []) {
      const at = nextCronRun(job, now);
      if (at != null && (!best || at < best.at)) best = { at, name: job.name };
    }
    return best;
  }, [jobs.data, now]);

  const monthBounds = useMemo(() => currentMonthBounds(now), [now]);
  const monthly = useModelUsage(undefined, monthBounds);
  const daily = useUsageByDay(undefined, 7);
  const summary = buildUsageSummary(monthly.data);
  const days = useMemo(() => {
    const byDay = new Map((daily.data ?? []).map((day) => [day.day, day]));
    return Array.from({ length: 7 }, (_, index) => {
      const key = new Date(now - (6 - index) * 86_400_000).toISOString().slice(0, 10);
      return byDay.get(key) ?? { day: key, tokens: 0, cost: null };
    });
  }, [daily.data, now]);
  const max = Math.max(1, ...days.map((day) => day.tokens));
  const today = days[days.length - 1];
  const todayLabel = today.cost != null ? formatCost(today.cost) : '—';

  return (
    <aside aria-labelledby="dashboard-attention" className="border-t border-border/80 px-1 py-6 @sm:px-3 @2xl:px-5 @3xl:border-l @3xl:border-t-0">
      <h2 id="dashboard-attention" className="mb-2 text-sm font-semibold text-text">{t.dashboard.attention}</h2>
      <SignalRow
        icon={ShieldQuestion}
        label={t.dashboard.signalDecisionsWaiting}
        value={decisions}
        detail={decisions > 0 ? t.dashboard.decisionsUnit : t.dashboard.allClear}
        href={decisions > 0 ? '/escalations' : undefined}
        alert={decisions > 0}
      />
      <SignalRow
        icon={AlarmClock}
        label={t.dashboard.nextRunLabel}
        value={next ? new Date(next.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '—'}
        detail={next?.name ?? t.dashboard.noCron}
        href={next ? '/settings?section=cron' : undefined}
      />
      <SignalRow
        icon={Radio}
        label={t.dashboard.signalAgentsActive}
        value={agents}
        detail={agents > 0 ? t.dashboard.agentsWorkingUnit : t.dashboard.allQuiet}
        href="/sessions"
      />

      <div className="border-t border-border/70 py-4">
        <div className="flex items-start justify-between gap-3">
          <span className="flex items-center gap-3">
            <Coins size={14} aria-hidden className="text-text-muted" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">{t.dashboard.signalMonthCost}</span>
          </span>
          <span className="font-mono text-sm font-semibold tabular-nums text-text">{summary.totalCostLabel}</span>
        </div>
        <div className="mt-4 flex h-7 items-end gap-1" aria-hidden>
          {days.map((day, index) => (
            <span
              key={day.day}
              className={`flex-1 rounded-t-sm transition-[height] duration-500 ${index === days.length - 1 ? 'bg-accent' : 'bg-border-strong/70'}`}
              style={{ height: `${Math.max(10, (day.tokens / max) * 100)}%` }}
            />
          ))}
        </div>
        <p className="mt-2 text-[10px] text-text-muted">{t.dashboard.last7d} · {t.dashboard.today.replace('{cost}', todayLabel)}</p>
      </div>
    </aside>
  );
}
