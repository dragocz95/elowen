'use client';
import { useRef, useState } from 'react';
import { Library } from 'lucide-react';
import { useFillHeight } from '../../lib/useFillHeight';
import { useMobileViewport } from '../../lib/useMobile';
import { usePersistentState } from '../../lib/usePersistentState';
import { useTranslation } from '../../lib/i18n';
import { Modal, ModalBody } from '../../components/ui/Modal';
import { BrainSessionsPanel } from '../../components/brain/BrainSessionsPanel';
import { BrainChatSurface } from '../advisor/BrainChatSurface';
import { ChatHistoryRail } from '../advisor/ChatHistoryRail';
import { TelemetryPanel } from '../advisor/TelemetryPanel';
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
 *  The telemetry rail is a real column beside the transcript on desktop and a right drawer on mobile:
 *  the choice is made here in JS (not by a CSS breakpoint) so a phone never mounts a second column at
 *  all, which is what would squeeze the conversation off a narrow screen. Until the viewport is measured
 *  (the first commit knows nothing) NEITHER variant mounts — guessing desktop would put the column on a
 *  phone for one commit, queries and all. */
const RAIL_VISIBILITY = ['shown', 'hidden'] as const;
type RailVisibility = typeof RAIL_VISIBILITY[number];

export function ChatView() {
  const { t } = useTranslation();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const fillHeight = useFillHeight(surfaceRef);
  const mobile = useMobileViewport();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [telemetryOpen, setTelemetryOpen] = useState(false);
  // The full conversation register (BrainSessionsPanel: channels + task agents, admin oversight) lives
  // behind the history drawer as a modal — core data stays reachable with the agents plugin disabled.
  const [registerOpen, setRegisterOpen] = useState(false);
  // Whether the docked column is shown is a per-device display choice, like the nav pin and the UI scale:
  // it belongs to the screen you are on, not to the user record. The drawer on a phone is transient and
  // deliberately NOT persisted — a drawer that reopens itself on every visit is a nuisance, not a setting.
  const [railVisibility, setRailVisibility] = usePersistentState<RailVisibility>('elowen.chat.telemetry', 'shown', RAIL_VISIBILITY);
  const railShown = railVisibility === 'shown';
  // Track the open DAG by workflow id, not by a click-time copy, so the modal follows the live snapshot
  // while its nodes run — the same rule the rail's process modal follows.
  const [dagId, setDagId] = useState<string | null>(null);
  const openDag = (id: string) => { setTelemetryOpen(false); setDagId(id); };

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
            onOpenTelemetry={mobile ? () => setTelemetryOpen(true) : () => setRailVisibility(railShown ? 'hidden' : 'shown')}
            telemetryShown={mobile ? undefined : railShown}
          />
        </div>
        {mobile === false && railShown ? <TelemetryPanel variant="column" onOpenWorkflow={openDag} /> : null}
        {/* On a phone the global TopBar is gone (see Shell), so the drawer that lists conversations is also
            the only way back to the rest of the app — it carries a "← dashboard" link. Desktop keeps the
            TopBar, so the link would be redundant there. */}
        <ChatHistoryRail
          variant="drawer"
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          homeLink={mobile === true}
          onOpenRegister={() => setRegisterOpen(true)}
        />
        {mobile === true ? (
          <TelemetryPanel variant="drawer" open={telemetryOpen} onClose={() => setTelemetryOpen(false)} onOpenWorkflow={openDag} />
        ) : null}
        {dagId ? <WorkflowModal workflowId={dagId} onClose={() => setDagId(null)} /> : null}
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
