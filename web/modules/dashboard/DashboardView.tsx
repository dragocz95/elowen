'use client';
import { useRef } from 'react';
import { FinishSetupBanner } from '../../components/ui/FinishSetupBanner';
import { MotionReveal } from '../../components/ui/Motion';
import { JournalTrunk } from './JournalTrunk';
import { ActivityTile } from './ActivityTile';
import { TeamPulseTile } from './TeamPulseTile';
import { WorkspacePage } from '../../components/ui/WorkspacePrimitives';

/** The workspace home: setup posture, recent activity and team presence. */
export function DashboardView() {
  const fieldRef = useRef<HTMLDivElement>(null);
  return (
    <WorkspacePage className="dashboard-workspace flex flex-col gap-5">
      <FinishSetupBanner />
      <div ref={fieldRef} className="relative flex flex-col gap-5">
        <JournalTrunk containerRef={fieldRef} />
        <MotionReveal delay={0.06} className="relative z-[1] @container">
          <div className="grid w-full grid-cols-1 gap-x-10 gap-y-2 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <ActivityTile />
            <TeamPulseTile />
          </div>
        </MotionReveal>
      </div>
    </WorkspacePage>
  );
}
