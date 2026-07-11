'use client';
import { useState, useEffect } from 'react';
import { NeedsInputBanner } from '../../components/ui/NeedsInputBanner';
import { FinishSetupBanner } from '../../components/ui/FinishSetupBanner';
import { MotionReveal } from '../../components/ui/Motion';
import { HeroNowTile } from './HeroNowTile';
import { AttentionRail } from './SignalTiles';
import { ActivityTile } from './ActivityTile';
import { TodayTasksTile } from './TodayTasksTile';
import { SpatialWorkspaceLayout } from '../../components/ui/WorkspacePrimitives';
import { ControlSurfaceDocument } from '../../components/ui/ControlSurface';
import { useAgentPresence } from './useAgentPresence';
import { useTranslation } from '../../lib/i18n';

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
  const presence = useAgentPresence();
  const { t } = useTranslation();
  const hour = now.getHours();
  const greeting = hour < 12 ? t.dashboard.greetingMorning : hour < 18 ? t.dashboard.greetingAfternoon : t.dashboard.greetingEvening;
  const statusLine = presence.state === 'offline'
    ? t.dashboard.presence.offline
    : presence.waitingCount > 0
      ? t.dashboard.presence.waiting.replace('{count}', String(presence.waitingCount))
      : presence.activeCount > 0
        ? t.dashboard.agentsWorking.replace('{count}', String(presence.activeCount))
        : t.dashboard.allQuiet;
  const mascotState = presence.state === 'offline' || presence.state === 'error' ? 'error'
    : presence.state === 'working' || presence.state === 'thinking' ? 'saving'
      : presence.state === 'success' ? 'success' : 'idle';

  return (
    <SpatialWorkspaceLayout
      className="dashboard-workspace"
      hero={{
        eyebrow: t.dashboard.rightNow,
        title: greeting,
        description: statusLine,
        mascotState,
        metrics: <HeroNowTile now={nowMs} presence={presence} />,
      }}
    >
      <ControlSurfaceDocument>
        <FinishSetupBanner />
        <NeedsInputBanner />

        {/* One continuous journal below the hero. Activity and today's work form the story; compact
            signals sit in a narrow attention rail instead of competing as a grid of equal cards. */}
        <MotionReveal delay={0.06} className="@container">
          <div className="overflow-hidden @3xl:grid @3xl:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="min-w-0 divide-y divide-border/80">
              <ActivityTile />
              <TodayTasksTile now={nowMs} />
            </div>
            <AttentionRail now={nowMs} />
          </div>
        </MotionReveal>
      </ControlSurfaceDocument>
    </SpatialWorkspaceLayout>
  );
}
