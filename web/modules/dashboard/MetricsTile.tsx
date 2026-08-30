'use client';
import Link from 'next/link';
import { useMemo } from 'react';
import { currentMonthBounds, trailingWeek } from './metrics';
import { buildUsageSummary } from '../../lib/usageBars';
import { nextCronRun } from '../../lib/cron';
import { formatCost, formatTokens } from '../../lib/format';
import { useTranslation } from '../../lib/i18n';
import { useCronJobs, useMe, useModelUsage, usePluginPresent, usePulse, useUsageByDay } from '../../lib/queries';
import { Sparkline } from '../../components/ui/Sparkline';
import { LoadingState } from '../../components/ui/states';
import { PulseRings } from './PulseRings';
import type { ReactNode } from 'react';

/** The metrics panel: the spend/schedule figures the old hero pods carried, then the four monthly ring
 *  charts. It mounts only while its disclosure is open, so the ring charts (and the usage queries) cost
 *  nothing on the dashboard's first paint.
 *
 *  Two windows on purpose, each labelled: the figures report the current calendar month and today, the
 *  rings divide the trailing thirty days — the same UTC-day basis the rollups behind them are keyed on. */

function Figure({ label, value, detail, href }: { label: string; value: string; detail?: string; href?: string }) {
  const body = (
    <>
      <div className="font-mono text-xl font-medium tabular-nums text-foreground @2xl:text-2xl">{value}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{label}</div>
      {detail ? <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</div> : null}
    </>
  );
  // A figure whose destination belongs to a disabled plugin keeps its reading and loses only the link —
  // not a hole in the row and not a dead click.
  return href
    ? <Link href={href} className="min-w-0 rounded-lg transition-opacity hover:opacity-80">{body}</Link>
    : <div className="min-w-0">{body}</div>;
}

export function MetricsTile({ now }: { now: number }) {
  const { t, locale } = useTranslation();
  const pulse = usePulse();
  const people = pulse.data?.people ?? [];
  const month = pulse.data?.month;

  const me = useMe();
  // Without the cron plugin there is no schedule to read: asking anyway earns a 503 and would render an
  // empty figure that reads as "nothing scheduled" rather than "this instance has no scheduler".
  const cron = usePluginPresent('cronjob');
  // The month figure is core usage and renders either way; only its LINK belongs to the plugin's page.
  const stats = usePluginPresent('stats');
  const jobs = useCronJobs(cron && (me.data?.user?.is_admin ?? false));
  const next = useMemo(() => {
    let best: { at: number; name: string } | null = null;
    for (const job of jobs.data ?? []) {
      const at = nextCronRun(job, now);
      if (at != null && (!best || at < best.at)) best = { at, name: job.name };
    }
    return best;
  }, [jobs.data, now]);

  const monthBounds = useMemo(() => currentMonthBounds(now), [now]);
  const monthly = useModelUsage(monthBounds);
  const daily = useUsageByDay(7);
  const summary = buildUsageSummary(monthly.data);
  const days = useMemo(() => trailingWeek(daily.data, now), [daily.data, now]);
  const today = days[days.length - 1];
  const todayLabel = today.cost != null ? formatCost(today.cost) : '—';

  const figures: { key: string; label: string; value: string; detail?: string; href?: string }[] = [
    { key: 'month-cost', label: t.dashboard.metricsMonthCost, value: summary.totalCostLabel, ...(stats ? { href: '/p/stats' } : {}) },
    { key: 'today-cost', label: t.dashboard.metricsTodayCost, value: todayLabel },
    { key: 'month-tokens', label: t.dashboard.metricsMonthTokens, value: month ? formatTokens(month.tokens) : '—' },
    ...(cron ? [{
      key: 'next-run',
      label: t.dashboard.nextRunLabel,
      value: next ? new Date(next.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '—',
      detail: next?.name ?? t.dashboard.noCron,
      href: '/p/cronjob/settings/jobs',
    }] : []),
  ];

  let rings: ReactNode;
  if (pulse.isLoading) rings = <LoadingState />;
  else if (month) rings = <PulseRings people={people} month={month} t={t} />;
  else rings = <p className="text-sm text-muted-foreground">{t.dashboard.pulseRingEmpty}</p>;

  return (
    <section aria-labelledby="dashboard-metrics" className="px-4 pb-6 pt-1 @sm:px-6">
      <header className="mb-4">
        <h2 id="dashboard-metrics" tabIndex={-1} className="dash-label outline-none">{t.dashboard.metricsTitle}</h2>
      </header>
      <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-3 @2xl:grid-cols-4">
        {figures.map(({ key, ...figure }) => <Figure key={key} {...figure} />)}
      </div>
      {/* Seven days of tokens, today accented — the same series the old cost pod drew. */}
      <Sparkline values={days.map((day) => day.tokens)} colour="var(--color-primary)" variant="bar" highlightLast className="h-8 w-full max-w-xs" />
      <p className="mt-1 text-[11px] text-muted-foreground">{t.dashboard.last7d} · {t.dashboard.today.replace('{cost}', todayLabel)}</p>
      <div className="mt-6">{rings}</div>
    </section>
  );
}
