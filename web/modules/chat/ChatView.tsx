'use client';
import { useRef } from 'react';
import { useFillHeight } from '../../lib/useFillHeight';
import { useMobileViewport } from '../../lib/useMobile';
import { BrainChatSurface } from '../advisor/BrainChatSurface';
import { TelemetryPanel } from '../advisor/TelemetryPanel';
import { useTelemetryRail } from '../advisor/telemetryRailState';
import { WorkflowModal } from '../advisor/WorkflowModal';
import { ChatDeckHero } from './ChatDeckHero';

/** The full-page chat host. It reads the ONE controller mounted in ShellLayout via the surface
 *  (useBrainChat) — it must NEVER wrap its own <BrainChatProvider>, or a second controller + SSE stream
 *  would open. An Elowen-style stat hero sits on top; the conversation renders natively in the content
 *  below (no card frame). This page mounts no conversation list of its own: the header's switcher opens
 *  the one the provider owns. useFillHeight gives the
 *  surface a MIN height of one viewport (so a short conversation still fills the screen and pins the
 *  composer to the bottom); a longer transcript grows past it and the page itself scrolls — no inner
 *  scroll box, the whole width is used, and older messages page in on scroll-up.
 *
 *  The telemetry rail is NOT mounted here on desktop any more. It is a full-height dock owned by the
 *  shell (components/shell/Shell.tsx → ChatRailSplit), because a rail rendered as a sibling of the
 *  transcript sits inside this page's centred frame and below the top bar — which is exactly the inset the
 *  redesign removes. What stays here is the phone presentation, where the rail is an overlay rather than a
 *  column: a second column on a phone would squeeze the conversation off the screen. Until the viewport is
 *  measured NEITHER variant mounts — guessing desktop would put the column on a phone for one commit.
 *
 *  Both ends address one `useTelemetryRail()` state, so the toggle in the conversation's header and the
 *  panel it toggles cannot disagree about whether the rail is collapsed. */
export function ChatView() {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const fillHeight = useFillHeight(surfaceRef);
  const mobile = useMobileViewport();
  const rail = useTelemetryRail();

  return (
    <>
      {/* The hero mounts at EVERY width, because it carries the page's <h1> and a route with no level-1
          heading is a route a screen reader cannot orient in. What a small screen cannot afford is the
          stat row, not the heading — so the hero drops its own metrics through a container query in
          chat.css rather than being withheld here. Being CSS it also holds from the first paint instead
          of waiting for the viewport measurement. */}
      <ChatDeckHero />
      <div
        ref={surfaceRef}
        style={fillHeight ? { minHeight: fillHeight } : undefined}
        className="relative flex"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <BrainChatSurface
            variant="full"
            onOpenTelemetry={mobile ? () => rail?.setMobileOpen(true) : () => rail?.toggleCollapsed()}
            telemetryShown={mobile ? undefined : !(rail?.collapsed ?? false)}
          />
        </div>
        {/* The phone presentation of the telemetry rail: one full-screen overlay on the canonical
            Dialog/overlay-stack path, rendering the very same body the desktop dock does. */}
        {mobile === true ? (
          <TelemetryPanel
            variant="drawer"
            open={rail?.mobileOpen ?? false}
            onClose={() => rail?.setMobileOpen(false)}
            {...(rail ? { onOpenWorkflow: rail.openWorkflow } : {})}
          />
        ) : null}
        {/* Tracked by workflow id, not by a click-time copy, so the modal follows the live snapshot while
            its nodes run — the same rule the rail's process modal follows. The rail raises it and this
            page renders it, because the rail is no longer a child of this page. */}
        {rail?.workflowId ? <WorkflowModal workflowId={rail.workflowId} onClose={rail.closeWorkflow} /> : null}
      </div>
    </>
  );
}
