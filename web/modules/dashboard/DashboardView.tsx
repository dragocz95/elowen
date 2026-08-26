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
    </WorkspacePage>
  );
}
