'use client';
import { useState, useEffect, useRef } from 'react';
import * as m from 'motion/react-m';
import { NeedsInputBanner } from '../../components/ui/NeedsInputBanner';
import { FinishSetupBanner } from '../../components/ui/FinishSetupBanner';
import { MotionReveal } from '../../components/ui/Motion';
import { motionTransition } from '../../lib/motion';
import { useEffects } from '../../lib/useEffects';
import { HeroNowTile } from './HeroNowTile';
import { JournalTrunk } from './JournalTrunk';
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
  const { resolvedMode } = useEffects();
  const fieldRef = useRef<HTMLDivElement>(null);

  return (
    <WorkspacePage className="dashboard-workspace flex flex-col gap-5">
      <FinishSetupBanner />
      <NeedsInputBanner />

      {/* One field for the hero and the journal: the trunk filament flows from the mascot's core
          down into the journal spine, so the whole page hangs off the same being. */}
      <div ref={fieldRef} className="relative flex flex-col gap-5">
        <JournalTrunk containerRef={fieldRef} />

        {/* Transform-only entrance. Fractional opacity over the hero's blurred presence aura makes
            Chromium brighten the whole hero before it settles (same artifact RouteTransition works
            around), so the hero rises without fading. */}
        <m.div
          className="relative z-[1]"
          initial={resolvedMode === 'full' ? { y: 10 } : false}
          animate={{ y: 0 }}
          transition={motionTransition}
        >
          <HeroNowTile now={nowMs} />
        </m.div>

        {/* One continuous journal below the hero — open sections in the cosmos atmosphere (glowing
            labels, the shared spine) instead of hairline-ruled boxes; the operational signals orbit
            the mascot in the hero cosmos above. */}
        <MotionReveal delay={0.06} className="relative z-[1] @container">
          <div className="flex max-w-[46rem] flex-col gap-2">
            <ActivityTile />
            <TodayTasksTile now={nowMs} />
          </div>
        </MotionReveal>
      </div>
    </WorkspacePage>
  );
}
