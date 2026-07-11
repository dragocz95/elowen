'use client';
import { useState, useEffect } from 'react';
import { NeedsInputBanner } from '../../components/ui/NeedsInputBanner';
import { FinishSetupBanner } from '../../components/ui/FinishSetupBanner';
import { MotionReveal } from '../../components/ui/Motion';
import { HeroNowTile } from './HeroNowTile';
import { AttentionRail } from './SignalTiles';
import { ActivityTile } from './ActivityTile';
import { TodayTasksTile } from './TodayTasksTile';
import { WorkspacePage } from '../../components/ui/WorkspacePrimitives';

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
    <WorkspacePage className="dashboard-workspace flex flex-col gap-5">
      <FinishSetupBanner />
      <NeedsInputBanner />

      <MotionReveal>
        <HeroNowTile now={nowMs} />
      </MotionReveal>

      {/* One continuous journal below the hero. Activity and today's work form the story; compact
          signals sit in a narrow attention rail instead of competing as a grid of equal cards. */}
      <MotionReveal delay={0.06} className="@container">
        <div className="overflow-hidden border-y border-border/80 @3xl:grid @3xl:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 divide-y divide-border/80">
            <ActivityTile />
            <TodayTasksTile now={nowMs} />
          </div>
          <AttentionRail now={nowMs} />
        </div>
      </MotionReveal>
    </WorkspacePage>
  );
}
