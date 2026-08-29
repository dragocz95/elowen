'use client';
import { useRef } from 'react';
import { Coins, MessagesSquare, UserRound, Wallet } from 'lucide-react';
import { FinishSetupBanner } from '../../components/ui/FinishSetupBanner';
import { MotionReveal } from '../../components/ui/Motion';
import { HeroNowTile } from './HeroNowTile';
import { JournalTrunk } from './JournalTrunk';
import { ActivityTile } from './ActivityTile';
import { TeamPulseTile } from './TeamPulseTile';
import { useNow } from '../../lib/useNow';
import { useTranslation } from '../../lib/i18n';
import { WorkspaceShell } from '../../components/ui/WorkspaceShell';
import { WorkspaceMetric } from '../../components/ui/WorkspaceHero';
import { usePulse } from '../../lib/queries';
import { formatCost, formatTokens } from '../../lib/format';
import { usePresence } from './usePresence';

/** The workspace home: setup posture, who is working right now, recent activity and team presence.
 *
 *  It is a `single` shell, not a register: there is no collection to browse, no section rail and no
 *  count — one working surface under a title block, which is exactly what the variant means. The title
 *  block is the ordinary WorkspaceHero, so the greeting sits at the same measure, in the same type and
 *  with the same gutter as every other page's <h1>; the page used to hand-roll its own frame and its own
 *  heading and drifted from all of them. `mascot: false` because the being already lives in the hero
 *  cosmos below — the hero's decorative panel would be a second one on the same screen. */
export function DashboardView() {
  const fieldRef = useRef<HTMLDivElement>(null);
  const nowMs = useNow();
  const { t, locale } = useTranslation();
  const presence = usePresence();
  // The SAME request the presence hook and the pulse tile already make — one react-query key, one fetch.
  // The rail reports the instance's headline totals for today; the tile below divides exactly these
  // numbers per person and per channel, which is the division of labour the anatomy asks for.
  const pulse = usePulse().data;
  const totals = pulse?.totals;
  // Three states, kept apart on purpose: no answer yet, a rollup that cannot price the day, and a day
  // whose turns carried no price. Collapsing any of them into "0" would state a spend nobody measured.
  const spendToday = totals === undefined ? '—'
    : pulse?.spendAvailable === false ? t.dashboard.pulseSpendOff
    : totals.cost === null ? t.dashboard.pulseUnpriced
    : formatCost(totals.cost, 2);

  const date = new Date(nowMs);
  const hour = date.getHours();
  const greeting = hour < 12 ? t.dashboard.greetingMorning : hour < 18 ? t.dashboard.greetingAfternoon : t.dashboard.greetingEvening;
  // Only a fact the reader cannot get from the page itself belongs under the greeting. "1 person working"
  // and "all quiet" are both restated a few centimetres below — as the working row, as the live tile and
  // as the pulse — so the line said nothing three times. An unreachable daemon is different: nothing else
  // on this page can report it, because everything else on this page comes FROM it.
  const statusLine = presence.state === 'offline' ? t.dashboard.presence.offline : undefined;

  return (
    <WorkspaceShell
      variant="single"
      className="dashboard-view"
      hero={{
        eyebrow: t.dashboard.rightNow,
        title: greeting,
        description: statusLine,
        // The clock is the hero's status slot rather than a corner of the tile below: it is a fact ABOUT
        // this moment, which is what the eyebrow already announces. A baseline row rather than a stacked
        // pair, so it wraps instead of overflowing on a narrow hero.
        status: (
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-mono text-lg font-semibold tabular-nums text-foreground">
              {date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
            </span>
            <span className="text-xs capitalize text-muted-foreground">
              {date.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}
            </span>
          </span>
        ),
        // The canonical divider rail: heading, then figures. Four facts about TODAY, in the order an
        // operator reads them — how much work happened, what it moved, what it cost, and who is mid-turn
        // right now. `presence.activeCount` is live and is not one of today's totals, which is why it
        // comes from the presence hook rather than from `totals.activePeople` ("active at some point").
        metrics: (
          <>
            <WorkspaceMetric label={t.dashboard.pulseColTurns} value={totals?.turns ?? '—'} icon={MessagesSquare} />
            <WorkspaceMetric label={t.dashboard.pulseColTokens} value={totals ? formatTokens(totals.tokens) : '—'} icon={Coins} />
            <WorkspaceMetric label={t.dashboard.pulseColCost} value={spendToday} icon={Wallet} />
            <WorkspaceMetric label={t.dashboard.workingNow} value={presence.activeCount} icon={UserRound} />
          </>
        ),
      }}
    >
      <div className="flex flex-col gap-5">
        <FinishSetupBanner />
        {/* One field for the hero and the journal: the trunk filament flows from the mascot's core down
            into the journal spine, so the whole page hangs off the same being. */}
        <div ref={fieldRef} className="relative flex flex-col gap-5">
          <JournalTrunk containerRef={fieldRef} />
          <MotionReveal className="relative z-[1]">
            <HeroNowTile now={nowMs} presence={presence} />
          </MotionReveal>
          {/* The pulse tile takes the full width because it now draws four rings side by side; squeezed
              into a column they shrink to the point where the arcs stop being comparable, which is the
              only thing a ring is for. The feed follows underneath — it is a list of short rows and never
              needed the width it used to be given. */}
          <MotionReveal delay={0.06} className="relative z-[1] @container">
            <TeamPulseTile />
          </MotionReveal>
          <MotionReveal delay={0.1} className="relative z-[1] @container">
            <ActivityTile />
          </MotionReveal>
        </div>
      </div>
    </WorkspaceShell>
  );
}
