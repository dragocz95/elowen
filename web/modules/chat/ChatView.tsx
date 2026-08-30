'use client';
import { useRef, useState } from 'react';
import { Library } from 'lucide-react';
import { useFillHeight } from '../../lib/useFillHeight';
import { useMobileViewport } from '../../lib/useMobile';
import { useTranslation } from '../../lib/i18n';
import { Modal, ModalBody } from '../../components/ui/Modal';
import { BrainSessionsPanel } from '../../components/brain/BrainSessionsPanel';
import { BrainChatSurface } from '../advisor/BrainChatSurface';
import { ChatHistoryRail } from '../advisor/ChatHistoryRail';
import { TelemetryPanel } from '../advisor/TelemetryPanel';
import { useTelemetryRail } from '../advisor/telemetryRailState';
import { WorkflowModal } from '../advisor/WorkflowModal';
import { ChatDeckHero } from './ChatDeckHero';

/** The full-page chat host. It reads the ONE controller mounted in ShellLayout via the surface + rail
 *  (both call useBrainChat) — it must NEVER wrap its own <BrainChatProvider>, or a second controller +
 *  SSE stream would open. An Elowen-style stat hero sits on top; the conversation renders natively in the
 *  content below (no card frame). The history list is hidden by default and opens as a left drawer from
 *  the surface header button — cleaner and more minimal than a permanent column. useFillHeight gives the
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
  const { t } = useTranslation();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const fillHeight = useFillHeight(surfaceRef);
  const mobile = useMobileViewport();
  const rail = useTelemetryRail();
  const [historyOpen, setHistoryOpen] = useState(false);
  // The full conversation register (BrainSessionsPanel: channels + task agents, admin oversight) lives
  // behind the history drawer as a modal — core data stays reachable with the agents plugin disabled.
  const [registerOpen, setRegisterOpen] = useState(false);

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
            onOpenHistory={() => setHistoryOpen(true)}
            onOpenTelemetry={mobile ? () => rail?.setMobileOpen(true) : () => rail?.toggleCollapsed()}
            telemetryShown={mobile ? undefined : !(rail?.collapsed ?? false)}
          />
        </div>
        {/* On the frameless design a phone /chat has no TopBar (see Shell), so the drawer that lists
            conversations is also the only way back to the rest of the app — it carries a "← dashboard"
            link. Studio's ruled bar stays up on a phone with its hamburger, where the link is a spare
            exit rather than the only one; desktop keeps the TopBar too. */}
        <ChatHistoryRail
          variant="drawer"
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          homeLink={mobile === true}
          onOpenRegister={() => setRegisterOpen(true)}
        />
        {/* The phone presentation of the same rail: one full-screen overlay on the canonical
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
        {/* `lg` is the WIDEST size (92vw, up to 90rem) despite the name — `xl` is a 42rem dialog, which
            squeezed a six-column register into a third of the screen. */}
        {registerOpen ? (
          <Modal title={t.chat.openRegister} icon={Library} size="lg" onClose={() => setRegisterOpen(false)}>
            <ModalBody>
              {/* Opening a row hands the conversation to THIS page's surface (the shared controller
                  switches it), so the modal dismisses itself instead of covering the loaded chat. */}
              <BrainSessionsPanel afterOpen={() => setRegisterOpen(false)} />
            </ModalBody>
          </Modal>
        ) : null}
      </div>
    </>
  );
}
