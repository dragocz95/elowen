'use client';
import { useRef } from 'react';
import { FinishSetupBanner } from '../../components/ui/FinishSetupBanner';
import { MotionReveal } from '../../components/ui/Motion';
import { HeroNowTile } from './HeroNowTile';
import { JournalTrunk } from './JournalTrunk';
import { ActivityTile } from './ActivityTile';
import { TeamPulseTile } from './TeamPulseTile';
import { useNow } from '../../lib/useNow';
import { WorkspacePage } from '../../components/ui/WorkspacePrimitives';

/** The workspace home: setup posture, who is working right now, recent activity and team presence. */
export function DashboardView() {
  const fieldRef = useRef<HTMLDivElement>(null);
  const nowMs = useNow();
  return (
    <WorkspacePage className="dashboard-workspace flex flex-col gap-5">
      <FinishSetupBanner />
      {/* One field for the hero and the journal: the trunk filament flows from the mascot's core down
          into the journal spine, so the whole page hangs off the same being. */}
      <div ref={fieldRef} className="relative flex flex-col gap-5">
        <JournalTrunk containerRef={fieldRef} />
        <MotionReveal className="relative z-[1]">
          <HeroNowTile now={nowMs} />
        </MotionReveal>
        <MotionReveal delay={0.06} className="relative z-[1] @container">
          {/* Not an even split: the feed is a list of short rows and reads fine narrow, while the pulse
              tile carries a chart and a seven-column table that earn every pixel they get. */}
          <div className="grid w-full grid-cols-1 gap-x-8 gap-y-2 @4xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <ActivityTile />
            <TeamPulseTile />
          </div>
        </MotionReveal>
      </div>
    </WorkspacePage>
  );
}
