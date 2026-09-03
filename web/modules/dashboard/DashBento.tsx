'use client';
import Link from 'next/link';
import { useMemo } from 'react';
import { Area, AreaChart, XAxis } from 'recharts';
import { ArrowUpRight, Bot, Coins, MessagesSquare } from 'lucide-react';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '../../components/ui/shadcn/chart';
import { Skeleton } from '../../components/ui/shadcn/skeleton';
import { useBrainSessions, usePulse } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { formatCost, formatTokens } from '../../lib/format';
import { HOURS, deltaPct, toLocalHours } from './pulseSeries';
import type { PulseResponse } from '../../lib/types';

/** The dashboard's bento: four cards under the hero, each answering ONE question the page was previously
 *  making the reader open a panel for — what did today look like, is anything running, where was I, what
 *  did it cost. The disclosure panels below are unchanged and still hold the full tiles; this is the
 *  layer that makes the landing screen worth landing on.
 *
 *  THE FIRST-PAINT BUDGET IS THE CONSTRAINT, not an afterthought. `/dash` deliberately keeps the feed,
 *  the gauges and the day-usage rollup off the landing screen — `tests/modules/dashboard` pins that — so
 *  three of these four cards are drawn from `usePulse`, the single request the metric strip above them
 *  already makes. That is also why the usage sparkline is TODAY BY HOUR rather than a seven-day series:
 *  the hourly basis is in the payload the page already has, and `useUsageByDay` is a panel-only request.
 *  Only the conversation list adds a call, and it is the cheap listing the chat dock reads anyway.
 *
 *  Every card states its own loading shape with `Skeleton` rather than collapsing to nothing: a bento
 *  whose tiles appear one at a time relayouts the page under the pointer, which is the one thing a grid
 *  of cards must not do. */

/** Turns per LOCAL hour across the whole instance today, folded from the per-person series the pulse
 *  already carries. Summed rather than drawn per person: this card states one number and the shape under
 *  it has to be that number's own history, not a stacked comparison the tile below already draws. */
function turnsByHour(pulse: PulseResponse | undefined): number[] {
  const utc = Array<number>(HOURS).fill(0);
  for (const person of pulse?.people ?? []) {
    for (let hour = 0; hour < HOURS; hour += 1) utc[hour] += person.hoursToday?.[hour] ?? 0;
  }
  return toLocalHours(utc);
}

function UsageCard() {
  const { t, locale } = useTranslation();
  const pulse = usePulse().data;
  const totals = pulse?.totals;

  const series = useMemo(
    () => turnsByHour(pulse).map((turns, hour) => ({ hour: `${String(hour).padStart(2, '0')}:00`, turns })),
    [pulse],
  );
  const config = { turns: { label: t.dashboard.pulseColTurns, color: 'var(--color-chart-1)' } } satisfies ChartConfig;

  return (
    <article className="dash-bento__card dash-bento__card--wide">
      <header className="dash-bento__head">
        <h2 className="dash-bento__title">{t.dashboard.stripLabel}</h2>
        <span className="dash-bento__meta">{t.dashboard.pulseTodayLabel}</span>
      </header>
      {totals ? (
        <p className="dash-bento__figure">
          {formatTokens(totals.tokens)}
          <span className="dash-bento__unit">{t.dashboard.pulseColTokens.toLocaleLowerCase(locale)}</span>
        </p>
      ) : <Skeleton className="h-10 w-40" />}
      {/* `aria-hidden`: the shape restates the figure above it, and a screen reader reading twenty-four
          unlabelled hour values is noise rather than the summary the card already gave. */}
      <ChartContainer config={config} className="dash-bento__chart" aria-hidden>
        <AreaChart data={series} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="dash-bento-usage" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-turns)" stopOpacity={0.32} />
              <stop offset="100%" stopColor="var(--color-turns)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="hour" hide />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Area dataKey="turns" type="monotone" stroke="var(--color-turns)" strokeWidth={1.5} fill="url(#dash-bento-usage)" />
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

/** Today's spend, with the one comparison that makes a number mean something. The three states the strip
 *  above already separates are kept apart here too: no answer yet, a rollup that cannot price the day,
 *  and a day whose turns carried no price. Collapsing any of them into "0" would state a spend nobody
 *  measured. */
function SpendCard() {
  const { t, locale } = useTranslation();
  const pulse = usePulse().data;
  const totals = pulse?.totals;
  const delta = totals ? deltaPct(totals.turns, pulse?.yesterday?.turns ?? 0) : null;
  const spend = totals === undefined ? null
    : pulse?.spendAvailable === false ? t.dashboard.pulseSpendOff
    : totals.cost === null ? t.dashboard.pulseUnpriced
    : formatCost(totals.cost, 2);
  return (
    <article className="dash-bento__card">
      <header className="dash-bento__head">
        <h2 className="dash-bento__title"><Coins size={15} strokeWidth={1.5} aria-hidden />{t.dashboard.metricsTodayCost}</h2>
      </header>
      {spend === null ? <Skeleton className="h-10 w-24" /> : <p className="dash-bento__figure">{spend}</p>}
      <p className="dash-bento__foot">
        {delta === null
          ? t.dashboard.pulseNoBaseline
          : Math.round(delta) === 0
            ? t.dashboard.pulseFlat
            : `${delta > 0 ? '+' : ''}${Math.round(delta).toLocaleString(locale)} % ${t.dashboard.pulseVsYesterday}`}
      </p>
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
        {/* Icon only, named by its label. At one grid track the card title and a two-word link do not
            both fit, and truncating the TITLE to keep a link readable is the wrong thing to lose. */}
        <Link href="/chat" className="dash-bento__more" aria-label={t.dashboard.openChat} title={t.dashboard.openChat}>
          <ArrowUpRight size={14} strokeWidth={1.5} aria-hidden />
        </Link>
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

export function DashBento() {
  const { t } = useTranslation();
  // `--stagger` per card, read by `.animate-rise-in` (app/styles/animations.css) — the same entrance the
  // navigation rows use, so the two surfaces arrive with one rhythm rather than two.
  //
  // There is deliberately no quick-actions card: the hero already carries that row, and a second set of
  // the same buttons a screen apart is not a shortcut, it is a question about which one is the real one.
  const cards = [<UsageCard key="usage" />, <AgentsCard key="agents" />, <ConversationsCard key="chats" />, <SpendCard key="spend" />];
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
