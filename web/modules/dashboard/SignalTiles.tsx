'use client';
import { useMemo } from 'react';
import { ShieldQuestion, Coins, Radio, AlarmClock, ArrowRight } from 'lucide-react';
import { BentoTile } from './BentoTile';
import { currentMonthBounds } from './metrics';
import { buildUsageSummary } from '../stats/usageBars';
import { nextCronRun } from '../../lib/cron';
import { formatCost } from '../../lib/format';
import { useTranslation } from '../../lib/i18n';
import {
  usePendingAsks, useEscalations, useModelUsage, useUsageByDay, useSessionInfos, useCronJobs, useMe,
} from '../../lib/queries';
import type { SessionInfo } from '../../lib/types';

/** A big mono number — the shared metric face across the small tiles. */
function Metric({ value, className = '' }: { value: string; className?: string }) {
  return <span className={`font-mono font-semibold leading-none tabular-nums tracking-[-0.03em] ${className}`}>{value}</span>;
}
function Caption({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] tracking-[0.02em] text-text-muted">{children}</span>;
}
const GoLink = ({ children }: { children: React.ReactNode }) => (
  <span className="mt-auto inline-flex items-center gap-1 text-xs font-semibold text-text-muted transition-colors group-hover:text-text">
    {children}<ArrowRight size={13} aria-hidden />
  </span>
);

/** Decisions a human owes an answer to — pending asks + escalations. Warning-toned when any wait. */
export function DecisionsTile() {
  const { t } = useTranslation();
  const asks = usePendingAsks();
  const escalations = useEscalations();
  const count = (asks.data?.length ?? 0) + escalations.length;
  return (
    <BentoTile tone={count > 0 ? 'warning' : 'muted'} icon={ShieldQuestion} label={t.dashboard.signalDecisionsWaiting} href={count > 0 ? '/escalations' : undefined}>
      <div className="mt-auto flex items-baseline gap-2.5">
        <Metric value={String(count)} className={`text-[40px] ${count > 0 ? 'text-warning' : 'text-text'}`} />
        <Caption>{t.dashboard.decisionsUnit}</Caption>
      </div>
      {count > 0 ? <GoLink>{t.dashboard.decideCta}</GoLink> : <Caption>{t.dashboard.allClear}</Caption>}
    </BentoTile>
  );
}

/** This month's spend + a 7-day activity sparkline (bars by daily token volume). Cost reads "—" when
 *  no settled task carried a price (claude/codex-only). `now` drives the month window + day buckets. */
export function SpendTile({ now }: { now: number }) {
  const { t } = useTranslation();
  const monthBounds = useMemo(() => currentMonthBounds(now), [now]);
  const monthly = useModelUsage(undefined, monthBounds);
  const daily = useUsageByDay(undefined, 7);
  const summary = buildUsageSummary(monthly.data);

  // Last 7 UTC days (oldest→newest) mapped onto the returned buckets; missing days pad to zero. The
  // API keys buckets by UTC date(captured_at), so we build the day keys the same way to line up.
  const days = useMemo(() => {
    const byDay = new Map((daily.data ?? []).map((d) => [d.day, d]));
    return Array.from({ length: 7 }, (_, i) => {
      const key = new Date(now - (6 - i) * 86_400_000).toISOString().slice(0, 10);
      return byDay.get(key) ?? { day: key, tokens: 0, cost: null };
    });
  }, [daily.data, now]);
  const max = Math.max(1, ...days.map((d) => d.tokens));
  const today = days[days.length - 1];
  const todayLabel = today.cost != null ? formatCost(today.cost) : '—';

  return (
    <BentoTile tone="muted" icon={Coins} label={t.dashboard.signalMonthCost} trailing={<Metric value={summary.totalCostLabel} className="text-[15px]" />}>
      <div className="mt-auto flex h-10 items-end gap-1.5" aria-hidden>
        {days.map((d, i) => (
          <span
            key={d.day}
            className={`flex-1 rounded-t-[3px] ${i === days.length - 1 ? 'bg-accent' : 'bg-elevated'}`}
            style={{ height: `${Math.max(6, (d.tokens / max) * 100)}%` }}
          />
        ))}
      </div>
      <Caption>{t.dashboard.last7d} · {t.dashboard.today.replace('{cost}', todayLabel)}</Caption>
    </BentoTile>
  );
}

/** Live agents right now — every session whose role is `agent` (a session exists only while its agent
 *  runs). Accent-toned; links to the sessions view. */
export function AgentsTile() {
  const { t } = useTranslation();
  const infos = useSessionInfos();
  const count = (infos.data ?? []).filter((s: SessionInfo) => s.role === 'agent').length;
  return (
    <BentoTile tone="muted" icon={Radio} label={t.dashboard.signalAgentsActive} href="/sessions">
      <div className="mt-auto flex items-baseline gap-2.5">
        <Metric value={String(count)} className={`text-[40px] ${count > 0 ? 'text-accent' : 'text-text'}`} />
        <Caption>{count > 0 ? t.dashboard.agentsWorkingUnit : t.dashboard.allQuiet}</Caption>
      </div>
      <GoLink>{t.dashboard.viewSessions}</GoLink>
    </BentoTile>
  );
}

/** The next scheduled cron run — soonest `nextCronRun` across enabled jobs, as a local HH:MM + name.
 *  The jobs endpoint is admin-only, so a non-admin simply sees the empty state (no data, no error). */
export function CronTile({ now }: { now: number }) {
  const { t, locale } = useTranslation();
  const me = useMe();
  const jobs = useCronJobs(me.data?.user?.is_admin ?? false); // admin-only endpoint — skip for non-admins
  const next = useMemo(() => {
    let best: { at: number; name: string } | null = null;
    for (const j of jobs.data ?? []) {
      const at = nextCronRun(j, now);
      if (at != null && (!best || at < best.at)) best = { at, name: j.name };
    }
    return best;
  }, [jobs.data, now]);

  return (
    <BentoTile tone="muted" icon={AlarmClock} label={t.dashboard.nextRunLabel} href={next ? '/settings?section=cron' : undefined}>
      {next ? (
        <div className="mt-auto">
          <Metric value={new Date(next.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })} className="text-[28px]" />
          <div className="mt-1.5 truncate font-mono text-[11px] text-text-muted" title={next.name}>{next.name}</div>
        </div>
      ) : (
        <div className="mt-auto"><Caption>{t.dashboard.noCron}</Caption></div>
      )}
    </BentoTile>
  );
}
