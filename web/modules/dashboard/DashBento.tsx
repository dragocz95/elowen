'use client';
import Link from 'next/link';
import { useMemo } from 'react';
import { Area, AreaChart, XAxis } from 'recharts';
import { ArrowUpRight, Bot, MessagesSquare, Sparkles } from 'lucide-react';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '../../components/ui/shadcn/chart';
import { Skeleton } from '../../components/ui/shadcn/skeleton';
import { useBrainSessions, usePulse, useUsageByDay } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { formatTokens } from '../../lib/format';
import { openBrainComposer } from '../../lib/brainDock';
import { trailingDays } from './metrics';

/** The dashboard's bento: four cards under the hero, each answering ONE question the page was previously
 *  making the reader open a panel for — how much did today cost, is anything running, where was I, what
 *  can I do next. The panels below are unchanged and still hold the full tiles; this is the layer that
 *  makes the landing screen worth landing on.
 *
 *  It reads nothing new. `usePulse`, `useUsageByDay` and `useBrainSessions` are the same react-query keys
 *  the panels and the navigation column already use, so opening /dash costs the requests the page was
 *  going to make anyway and one refresh moves every surface that shows the number.
 *
 *  Every card states its own loading shape with `Skeleton` rather than collapsing to nothing: a bento
 *  whose tiles appear one by one relayouts the page under the pointer, which is the one thing a grid of
 *  cards must not do. */

/** The seven-day usage series. Tokens rather than spend: spend is unavailable on an instance whose
 *  rollup cannot price a turn, and a sparkline that is blank on those instances is a worse default than
 *  one that always has a shape. */
function UsageCard({ days }: { days: number }) {
  const { t, locale } = useTranslation();
  const usage = useUsageByDay(days);
  const pulse = usePulse().data;
  const totals = pulse?.totals;

  const series = useMemo(
    () => trailingDays(usage.data, Date.now(), days).map((day) => ({ day: day.day, tokens: day.tokens })),
    [days, usage.data],
  );
  const config = { tokens: { label: t.dashboard.pulseColTokens, color: 'var(--color-chart-1)' } } satisfies ChartConfig;

  return (
    <article className="dash-bento__card dash-bento__card--wide">
      <header className="dash-bento__head">
        <h2 className="dash-bento__title">{t.dashboard.stripLabel}</h2>
        <span className="dash-bento__meta">{t.dashboard.last30d.replace('30', String(days))}</span>
      </header>
      {totals ? (
        <p className="dash-bento__figure">
          {formatTokens(totals.tokens)}
          <span className="dash-bento__unit">{t.dashboard.pulseColTokens.toLocaleLowerCase(locale)}</span>
        </p>
      ) : <Skeleton className="h-10 w-40" />}
      {/* `aria-hidden`: the shape is a restatement of the figure above it, and a screen reader reading
          seven unlabelled day values is noise, not the summary the card already gave. */}
      <ChartContainer config={config} className="dash-bento__chart" aria-hidden>
        <AreaChart data={series} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="dash-bento-usage" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-tokens)" stopOpacity={0.32} />
              <stop offset="100%" stopColor="var(--color-tokens)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="day" hide />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Area dataKey="tokens" type="monotone" stroke="var(--color-tokens)" strokeWidth={1.5} fill="url(#dash-bento-usage)" />
        </AreaChart>
      </ChartContainer>
    </article>
  );
}

function AgentsCard() {
  const { t } = useTranslation();
  const totals = usePulse().data?.totals;
  const running = totals?.runningAgents ?? 0;
  return (
    <article className="dash-bento__card" data-live={running > 0 || undefined}>
      <header className="dash-bento__head">
        <h2 className="dash-bento__title"><Bot size={15} strokeWidth={1.5} aria-hidden />{t.dashboard.pulseRunningAgents}</h2>
      </header>
      {totals
        ? <p className="dash-bento__figure">{running}</p>
        : <Skeleton className="h-10 w-16" />}
      <p className="dash-bento__foot">{running > 0 ? t.dashboard.pulseAgentsBusy : t.dashboard.pulseAgentsIdle}</p>
    </article>
  );
}

function ConversationsCard() {
  const { t } = useTranslation();
  const sessions = useBrainSessions();
  const recent = (sessions.data ?? []).slice(0, 3);
  return (
    <article className="dash-bento__card">
      <header className="dash-bento__head">
        <h2 className="dash-bento__title"><MessagesSquare size={15} strokeWidth={1.5} aria-hidden />{t.dashboard.recentChats}</h2>
        <Link href="/chat" className="dash-bento__more">{t.dashboard.openChat}<ArrowUpRight size={13} strokeWidth={1.5} aria-hidden /></Link>
      </header>
      {sessions.data === undefined ? (
        <ul className="dash-bento__list">
          {[0, 1, 2].map((row) => <li key={row}><Skeleton className="h-4 w-full" /></li>)}
        </ul>
      ) : recent.length === 0 ? (
        <p className="dash-bento__foot">{t.dashboard.eventStreamEmpty}</p>
      ) : (
        <ul className="dash-bento__list">
          {recent.map((session) => (
            <li key={session.id}>
              <Link href={`/chat?session=${encodeURIComponent(session.id)}`} className="dash-bento__row">
                {session.running ? <span aria-hidden className="live-dot dash-bento__dot" /> : null}
                <span className="dash-bento__row-title">{session.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function ActionsCard({ actions }: { actions: { id: string; label: string; prompt: string }[] }) {
  const { t } = useTranslation();
  return (
    <article className="dash-bento__card">
      <header className="dash-bento__head">
        <h2 className="dash-bento__title"><Sparkles size={15} strokeWidth={1.5} aria-hidden />{t.dashboard.quickActions}</h2>
      </header>
      <ul className="dash-bento__list">
        {actions.map((action) => (
          <li key={action.id}>
            <button type="button" className="dash-bento__row" onClick={() => openBrainComposer(action.prompt)}>
              <span className="dash-bento__row-title">{action.label}</span>
              <ArrowUpRight size={13} strokeWidth={1.5} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </article>
  );
}

export function DashBento({ days = 7 }: { days?: number }) {
  const { t } = useTranslation();
  const actions = [
    { id: 'summary', label: t.dashboard.pillSummary, prompt: t.dashboard.pillSummaryPrompt },
    { id: 'plan', label: t.dashboard.pillPlan, prompt: t.dashboard.pillPlanPrompt },
    { id: 'agent', label: t.dashboard.pillAgent, prompt: t.dashboard.pillAgentPrompt },
  ];
  // `--stagger` per card, read by `.animate-rise-in` (app/styles/animations.css) — the same entrance the
  // navigation rows use, so the two surfaces arrive with one rhythm rather than two.
  const cards = [<UsageCard key="usage" days={days} />, <AgentsCard key="agents" />, <ConversationsCard key="chats" />, <ActionsCard key="actions" actions={actions} />];
  return (
    <section aria-label={t.dashboard.overview} className="dash-bento">
      {cards.map((card, index) => (
        <div key={card.key} className="dash-bento__slot animate-rise-in" style={{ '--stagger': index } as React.CSSProperties}>
          {card}
        </div>
      ))}
    </section>
  );
}
