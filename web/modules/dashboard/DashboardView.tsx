'use client';
import { useState, useEffect } from 'react';
import * as m from 'motion/react-m';
import { NeedsInputBanner } from '../../components/ui/NeedsInputBanner';
import { FinishSetupBanner } from '../../components/ui/FinishSetupBanner';
import { MotionReveal } from '../../components/ui/Motion';
import { motionTransition } from '../../lib/motion';
import { useEffects } from '../../lib/useEffects';
import { HeroNowTile } from './HeroNowTile';
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

  return (
    <WorkspacePage className="dashboard-workspace flex flex-col gap-5">
      <FinishSetupBanner />
      <NeedsInputBanner />

      {/* Transform-only entrance. Fractional opacity over the hero's blurred presence aura makes
          Chromium brighten the whole hero before it settles (same artifact RouteTransition works
          around), so the hero rises without fading. */}
      <m.div
        initial={resolvedMode === 'full' ? { y: 10 } : false}
        animate={{ y: 0 }}
        transition={motionTransition}
      >
        <HeroNowTile now={nowMs} />
      </m.div>

      {/* One continuous journal below the hero — open sections in the cosmos atmosphere (glowing
          labels, an ember spine) instead of hairline-ruled boxes; the operational signals orbit the
          mascot in the hero cosmos above. */}
      <MotionReveal delay={0.06} className="@container">
        <div className="flex max-w-[46rem] flex-col gap-2">
          <ActivityTile />
          <TodayTasksTile now={nowMs} />
        </div>
      </MotionReveal>
    </WorkspacePage>
  );
}
