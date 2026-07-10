'use client';
import { useState, useEffect } from 'react';
import { NeedsInputBanner } from '../../components/ui/NeedsInputBanner';
import { FinishSetupBanner } from '../../components/ui/FinishSetupBanner';
import { MotionReveal } from '../../components/ui/Motion';
import { HeroNowTile } from './HeroNowTile';
import { DecisionsTile, SpendTile, AgentsTile, CronTile } from './SignalTiles';
import { ActivityTile } from './ActivityTile';
import { TodayTasksTile } from './TodayTasksTile';

/** A clock that re-renders every 30s (enough for an HH:MM display, keeps the month window + elapsed live). */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** The personal-agent home: one dominant, conversational Elowen presence followed by a quieter layer
 *  of human attention, today's work and telemetry. Mission control stays in Work/Tasks. */
export function DashboardView() {
  const now = useNow();
  const nowMs = now.getTime();

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <FinishSetupBanner />
      <NeedsInputBanner />

      <MotionReveal>
        <HeroNowTile now={nowMs} />
      </MotionReveal>

      {/* A quiet second layer: human attention and today's story lead, telemetry follows. Unlike the
          old equal dashboard grid, no metric competes with the personal-agent hero. */}
      <MotionReveal delay={0.06} className="@container">
        <div className="grid auto-rows-[minmax(9rem,auto)] grid-cols-1 gap-3.5 @xl:grid-cols-2 @4xl:grid-cols-4">
          <DecisionsTile />
          <TodayTasksTile now={nowMs} />
          <CronTile now={nowMs} />
          <ActivityTile />
          <AgentsTile />
          <SpendTile now={nowMs} />
        </div>
      </MotionReveal>
    </div>
  );
}
