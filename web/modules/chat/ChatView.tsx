'use client';
import { useRef, useState } from 'react';
import { useFillHeight } from '../../lib/useFillHeight';
import { BrainChatSurface } from '../advisor/BrainChatSurface';
import { ChatHistoryRail } from '../advisor/ChatHistoryRail';
import { ChatDeckHero } from './ChatDeckHero';

/** The full-page chat host. It reads the ONE controller mounted in ShellLayout via the surface + rail
 *  (both call useBrainChat) — it must NEVER wrap its own <BrainChatProvider>, or a second controller +
 *  SSE stream would open. An Elowen-style stat hero sits on top; the conversation renders natively in the
 *  content below (no card frame). The history list is hidden by default and opens as a left drawer from
 *  the surface header button — cleaner and more minimal than a permanent column. useFillHeight gives the
 *  surface a MIN height of one viewport (so a short conversation still fills the screen and pins the
 *  composer to the bottom); a longer transcript grows past it and the page itself scrolls — no inner
 *  scroll box, the whole width is used, and older messages page in on scroll-up. */
export function ChatView() {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const fillHeight = useFillHeight(surfaceRef);
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <>
      <ChatDeckHero />
      <div
        ref={surfaceRef}
        style={fillHeight ? { minHeight: fillHeight } : undefined}
        className="relative flex"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <BrainChatSurface variant="full" onOpenHistory={() => setHistoryOpen(true)} />
        </div>
        <ChatHistoryRail variant="drawer" open={historyOpen} onClose={() => setHistoryOpen(false)} />
      </div>
    </>
  );
}
