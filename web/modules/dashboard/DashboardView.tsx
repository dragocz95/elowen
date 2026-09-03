'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { MotionReveal } from '../../components/ui/Motion';
import { HomeComposer } from './HomeComposer';
import { DashBento } from './DashBento';
import { ActivityTile } from './ActivityTile';
import { TeamPulseTile } from './TeamPulseTile';
import { MetricsTile } from './MetricsTile';
import { openBrainComposer } from '../../lib/brainDock';
import { useNow } from '../../lib/useNow';
import { useTranslation } from '../../lib/i18n';
import { useBrand } from '../../lib/brand';
import { useDashRecap, useMe, usePulse, useSystemReadiness } from '../../lib/queries';
import { RecapStrip } from './RecapStrip';
import { formatCost, formatTokens } from '../../lib/format';
import { usePresence } from './usePresence';
import type { DashRecap } from '../../lib/types';

/** The workspace home in its Fable shape: a thin strip of today's figures under the top bar, then a
 *  centred conversational hero — a personalised greeting over the ask line, quick-action pills that seed
 *  the advisor composer, the composer itself — and three disclosure buttons that reveal at most ONE
 *  panel (activity, team pulse, metrics) below.
 *
 *  Nothing heavy mounts on first paint on purpose: the feed, the pulse gauges and the donut rings render
 *  only inside the open panel, so the landing screen states four numbers and asks one question. The
 *  panels reuse the existing tiles wholesale — same queries, same SSE refresh — so opening one costs the
 *  requests that panel actually reads and nothing more. */

type PanelId = 'feed' | 'pulse' | 'metrics';

const PANELS: PanelId[] = ['feed', 'pulse', 'metrics'];

export function DashboardView({ recapSeed = null }: { recapSeed?: DashRecap | null } = {}) {
  const nowMs = useNow(30_000);
  const { t, locale } = useTranslation();
  const { appName } = useBrand();
  const presence = usePresence();
  const me = useMe();
  const user = me.data?.user;
  const readiness = useSystemReadiness(user?.is_admin === true);
  const needsSetup = readiness.data?.checks?.find((check) => check.id === 'chat')?.ok === false;
  // The SAME request the presence hook makes — one react-query key, one fetch. The strip reports the
  // instance's headline totals for today; the panels below divide these numbers further on demand.
  const pulse = usePulse().data;
  const totals = pulse?.totals;
  // Three states, kept apart on purpose: no answer yet, a rollup that cannot price the day, and a day
  // whose turns carried no price. Collapsing any of them into "0" would state a spend nobody measured.
  const spendToday = totals === undefined ? '—'
    : pulse?.spendAvailable === false ? t.dashboard.pulseSpendOff
    : totals.cost === null ? t.dashboard.pulseUnpriced
    : formatCost(totals.cost, 2);

  const [open, setOpen] = useState<PanelId | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Move focus to the revealed panel's heading, exactly as the disclosure pattern asks: the button that
  // was pressed keeps aria-expanded, the reader lands on what expanded.
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>('h2')?.focus();
  }, [open]);

  const closePanel = (returnFocus: boolean) => {
    const was = open;
    setOpen(null);
    if (returnFocus && was) document.getElementById(`dash-reveal-${was}`)?.focus();
  };
  const togglePanel = (id: PanelId) => {
    if (open === id) closePanel(true);
    else setOpen(id);
  };

  const date = new Date(nowMs);
  const hour = date.getHours();
  const greeting = hour < 12 ? t.dashboard.greetingMorning : hour < 18 ? t.dashboard.greetingAfternoon : t.dashboard.greetingEvening;
  // Addressed to whoever is signed in — first name only, from the real account. The nominative is used
  // as-is: declining a name into the vocative cannot be done reliably for arbitrary names.
  const firstName = user ? (user.name || user.username).trim().split(/\s+/)[0] : null;
  // The personalized layer (admin-toggled, per-caller): the agent-written greeting replaces the
  // static time-of-day line and the agent-written pills replace the static quick actions — each with
  // the static content as its fallback, so a missing/erroring recap leaves today's page untouched.
  const recap = useDashRecap(recapSeed).data;
  const digest = recap?.digest?.status === 'ready' ? recap.digest : undefined;
  const agentGreeting = digest?.greeting?.trim() || null;
  // Written by the agent so it lands in the user's own language and register — the dictionary's line is
  // the fallback, and it follows the INTERFACE locale, which is not necessarily what the user writes in.
  const agentAsk = digest?.ask?.trim() || null;
  // An unreachable daemon is the one fact nothing else on this page can report, because everything else
  // on this page comes FROM it.
  const statusLine = presence.state === 'offline' ? t.dashboard.presence.offline : undefined;

  // Practical seeds for the advisor composer — the existing compose channel, not a second send path.
  // The costs pill opens the metrics panel instead: the answer to that one is already on this page.
  // When the agent wrote today's pills (Settings → Dashboard), they take the row over — except while
  // setup is incomplete, where the setup CTA must stay reachable and the static set wins.
  const staticPills: ({ id: string; label: string; act: () => void } | { id: string; label: string; href: string })[] = [
    { id: 'summary', label: t.dashboard.pillSummary, act: () => openBrainComposer(t.dashboard.pillSummaryPrompt) },
    { id: 'plan', label: t.dashboard.pillPlan, act: () => openBrainComposer(t.dashboard.pillPlanPrompt) },
    { id: 'costs', label: t.dashboard.pillCosts, act: () => setOpen('metrics') },
    { id: 'agent', label: t.dashboard.pillAgent, act: () => openBrainComposer(t.dashboard.pillAgentPrompt) },
    { id: 'find', label: t.dashboard.pillFind, act: () => openBrainComposer(t.dashboard.pillFindPrompt) },
    needsSetup
      ? { id: 'setup', label: t.dashboard.finishSetup.cta, href: '/settings?cat=brain' }
      : { id: 'capabilities', label: t.dashboard.pillCapabilities, act: () => openBrainComposer(t.dashboard.pillCapabilitiesPrompt) },
  ];
  const pills = !needsSetup && digest?.pills?.length
    ? digest.pills.map((p, i) => ({ id: `agent-${i}`, label: p.label, act: () => openBrainComposer(p.prompt) }))
    : staticPills;

  const revealLabel: Record<PanelId, string> = {
    feed: t.dashboard.showFeed,
    pulse: t.dashboard.showPulse,
    metrics: t.dashboard.showMetrics,
  };

  return (
    <div className="dashboard-view flex flex-col">
      {/* Today at a glance: the only permanent figures on the page. One flat row that scrolls on a
          phone instead of wrapping the hero further down. `pt-4` is the shell's own rhythm (ModuleShell
          gap) — the strip reads as the page's first line, not as part of the app bar above it. */}
      <div className="flex items-center gap-4 border-b border-border px-4 pb-3 pt-4 md:px-0">
        <div role="list" aria-label={t.dashboard.stripLabel} style={{ scrollbarWidth: 'none' }} className="flex min-w-0 items-baseline gap-5 overflow-x-auto whitespace-nowrap [&::-webkit-scrollbar]:hidden @sm:gap-8">
          <span role="listitem" className="flex shrink-0 items-baseline gap-1.5">
            <b className="font-mono text-[13.5px] font-semibold tabular-nums text-foreground">{totals?.turns ?? '—'}</b>
            <span className="text-[13px] text-muted-foreground">{t.dashboard.pulseColTurns.toLocaleLowerCase(locale)}</span>
          </span>
          <span role="listitem" className="flex shrink-0 items-baseline gap-1.5">
            <b className="font-mono text-[13.5px] font-semibold tabular-nums text-foreground">{totals ? formatTokens(totals.tokens) : '—'}</b>
            <span className="text-[13px] text-muted-foreground">{t.dashboard.pulseColTokens.toLocaleLowerCase(locale)}</span>
          </span>
          <span role="listitem" className="flex shrink-0 items-baseline gap-1.5">
            <b className="font-mono text-[13.5px] font-semibold tabular-nums text-foreground">{spendToday}</b>
            <span className="text-[13px] text-muted-foreground">{t.dashboard.pulseColCost.toLocaleLowerCase(locale)}</span>
          </span>
          <span role="listitem" className="flex shrink-0 items-center gap-1.5">
            {(presence.activeCount ?? 0) > 0 ? <span aria-hidden className="live-dot h-1.5 w-1.5 rounded-full bg-primary" /> : null}
            <b className="font-mono text-[13.5px] font-semibold tabular-nums text-foreground">{presence.activeCount ?? '—'}</b>
            <span className="text-[13px] text-muted-foreground">{t.dashboard.workingNow.toLocaleLowerCase(locale)}</span>
          </span>
        </div>
        <span className="ml-auto hidden shrink-0 text-xs text-muted-foreground md:inline">
          <span className="capitalize">{date.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
          {' · '}
          <span className="font-mono tabular-nums">{date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</span>
        </span>
      </div>

      {/* `dash-hero` adds nothing to the layout — it is the hook the accent atmosphere hangs off
          (app/styles/components/dash-bento.css), drawn as a pseudo-element behind the greeting so the
          light bleeds past the section's own box without the section gaining a background. */}
      <section aria-labelledby="dash-greeting" className="dash-hero mx-auto w-full max-w-3xl px-4 pt-10 text-center sm:px-0 sm:pt-[clamp(3.5rem,13dvh,9rem)]">
        <MotionReveal>
          {/* The ember period is the page's signature and is drawn HERE, never by the model — the
              agent-written greeting arrives with trailing punctuation already stripped. */}
          <h1 id="dash-greeting" className="text-[clamp(2.15rem,4.8vw,4.3rem)] font-semibold leading-[1.06] tracking-[-0.03em] text-foreground">
            {agentGreeting ?? <>{greeting}{firstName ? `, ${firstName}` : ''}</>}<span aria-hidden className="text-primary">.</span>
          </h1>
          <p className="mt-3 text-[clamp(1.2rem,2.4vw,2.1rem)] font-normal leading-tight tracking-[-0.014em] text-muted-foreground">
            {agentAsk ?? t.dashboard.heroAsk}
          </p>
          {statusLine ? <p className="mt-3 text-sm text-muted-foreground">{statusLine}</p> : null}
        </MotionReveal>

        <MotionReveal delay={0.08}>
          <ul aria-label={t.dashboard.quickActions} className="mx-auto mt-8 flex max-w-xl flex-wrap justify-center gap-2.5 @sm:mt-10">
            {pills.map((pill) => {
              const className = 'inline-flex rounded-full border border-border px-4 py-1.5 text-sm text-foreground transition-[background-color,border-color,transform] hover:-translate-y-px hover:border-muted-foreground hover:bg-accent active:bg-muted';
              return (
                <li key={pill.id}>
                  {'href' in pill
                    ? <Link href={pill.href} className={className}>{pill.label}</Link>
                    : <button type="button" onClick={pill.act} className={className}>{pill.label}</button>}
                </li>
              );
            })}
          </ul>
        </MotionReveal>

        <MotionReveal delay={0.16}>
          <div className="mx-auto mt-7 w-full max-w-2xl text-left">
            <HomeComposer placeholder={t.dashboard.composerPlaceholder} actionLabel={t.dashboard.composerAction.replace('{agentName}', appName)} />
          </div>
        </MotionReveal>

        <MotionReveal delay={0.2}>
          <RecapStrip recap={recap} />
        </MotionReveal>

        {/* The bento. It sits inside the hero section so it inherits the same measure and gutters, and
            it is left-aligned inside a centred column — a grid of cards centred as text reads as a
            poster rather than as a dashboard. */}
        <MotionReveal delay={0.24}>
          <div className="mt-12 text-left @sm:mt-14">
            <DashBento />
          </div>
        </MotionReveal>

        <MotionReveal delay={0.28}>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 @sm:mt-12">
            {PANELS.map((id) => (
              <Button
                key={id}
                id={`dash-reveal-${id}`}
                variant="ghost"
                size="sm"
                aria-expanded={open === id}
                {...(open === id ? { 'aria-controls': `dash-panel-${id}` } : {})}
                onClick={() => togglePanel(id)}
                className={open === id ? 'text-foreground' : 'text-muted-foreground'}
              >
                {revealLabel[id]}
              </Button>
            ))}
          </div>
        </MotionReveal>
      </section>

      {/* Progressive disclosure: at most one panel, mounted only while it is open — which is what keeps
          the feed, the gauges and the ring charts (and their queries) off the first paint. */}
      {open ? (
        <MotionReveal className="mx-auto mt-5 w-full max-w-4xl px-4 pb-10 md:px-0">
          <div
            id={`dash-panel-${open}`}
            ref={panelRef}
            className="dash-panel @container rounded-2xl border border-border bg-card shadow-card"
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.stopPropagation(); closePanel(true); }
            }}
          >
            <div className="flex justify-end pr-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => closePanel(true)}>{t.dashboard.closePanel}</Button>
            </div>
            {open === 'feed' ? <ActivityTile /> : open === 'pulse' ? <TeamPulseTile /> : <MetricsTile now={nowMs} />}
          </div>
        </MotionReveal>
      ) : null}
    </div>
  );
}
