'use client';

import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { focusOverlaySurface, useOverlayIsolation } from './overlayStack';
import { OverlayDepthProvider } from './overlayDepth';
import { Dialog, DialogContent } from './shadcn/dialog';

export interface WorkspaceTakeoverProps {
  /** Names the surface for the header and for the dialog's accessible name. */
  title: string;
  /** Leaves the takeover. Also what Escape and the back control call — a takeover has exactly one exit. */
  onBack: () => void;
  /** Accessible name of the back control. Defaults to the app's own "Back". */
  backLabel?: string;
  /** The surface's own controls, rendered on the trailing side of the header row beside the title. */
  toolbar?: ReactNode;
  children: ReactNode;
}

/** A full-application takeover: one surface occupies the whole viewport, the application behind it is
 *  inert, and the only way out is the labelled back control (or Escape).
 *
 *  It exists because a takeover written by hand gets three things wrong every time, and did:
 *  `h-screen` measures `vh`, which is TALLER than a mobile browser's visible area while the toolbar is
 *  shown, so the bottom of the surface — usually its own toolbar — sits under the browser chrome; a
 *  literal z-index of fifty lands in the middle of the shared overlay scale and collides with the
 *  navigation drawer, the advisor launcher and the toasts; and replacing the whole application
 *  navigation with an unlabelled 28px chevron leaves no accessible, hittable exit.
 *
 *  It is the shadcn `Dialog` (Radix) underneath, on the split `Modal.tsx` documents: Radix owns the
 *  dialog role, the focus trap, Escape and the layer order among several open overlays, while the app
 *  keeps the overlay stack, the `inert` isolation and the focus it gives back.
 *
 *  DEPTH: a takeover DOES participate in the overlay depth stack. It registers with the same
 *  `useOverlayIsolation` every dialog uses, so it owns the top of the stack, inerts the page behind it
 *  and restores focus on the way out; and it wraps its children in `OverlayDepthProvider`, so a dialog
 *  opened from INSIDE it resolves at depth >= 1 and comes up as a centered window (or, on a phone, takes
 *  the screen) instead of trying to be a right-hand drawer beside a surface that already fills the
 *  viewport. What it deliberately does NOT do is ask `useOverlayPresentation` which shape to take: that
 *  rule answers "drawer" at depth 0 with room, and a takeover is fullscreen by definition — it is the
 *  page, not an overlay raised over one. So it pins `data-presentation="fullscreen"` and inherits the
 *  geometry `.overlay-surface[data-presentation='fullscreen']` already owns (dvh-correct `inset: 0`
 *  sizing and the four safe-area paddings) rather than restating any of it. */
export function WorkspaceTakeover({ title, onBack, backLabel, toolbar, children }: WorkspaceTakeoverProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const layerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  // Portalled to <body> for the same reason every other overlay is: `position: fixed` inside a
  // transformed ancestor is fixed to that ancestor, not to the viewport. Mount-gated because
  // createPortal needs `document`.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { restoreFocus } = useOverlayIsolation({ enabled: mounted, rootRef: layerRef });

  const back = backLabel ?? t.common.back;
  if (!mounted) return null;
  return createPortal(
    <Dialog open onOpenChange={(open) => { if (!open) onBack(); }}>
      <div ref={layerRef} className="overlay-layer-modal fixed inset-0">
        <DialogContent
          ref={surfaceRef}
          // A takeover is fullscreen by definition and takes its geometry from
          // `.overlay-surface.workspace-takeover[data-presentation='fullscreen']` (primitives.css),
          // which keeps the full bleed at every width where the primitive's own `fullscreen` variant
          // insets and rounds itself from the tablet breakpoint up. So the geometry variants are
          // declined and the attribute is pinned by hand. `flex flex-col focus:outline-none` still comes
          // from the primitive's base: the surface is focused on open so the trap has an anchor, and a
          // ring around the whole screen says nothing. The controls inside keep their own.
          presentation={null}
          aria-labelledby={titleId}
          aria-describedby={undefined}
          data-elowen-takeover
          data-presentation="fullscreen"
          className="overlay-surface workspace-takeover min-h-0 w-full bg-card"
          // A takeover has exactly one exit and it is the labelled back control. Radix would add a
          // second by dismissing on any press outside the surface — which, edge to edge, is the safe
          // area — and it would answer for a nested dialog's backdrop as well.
          onInteractOutside={(event) => event.preventDefault()}
          // Focus policy stays the app's: the surface (or whatever asked for `[data-autofocus]`) on the
          // way in, the opener on the way out — Radix would take the first control and then hand focus
          // to a trigger that does not exist.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (surfaceRef.current) focusOverlaySurface(surfaceRef.current);
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            {/* The same close affordance contract as Modal's header control: a labelled icon button that
                grows to the touch floor on a coarse pointer through `.overlay-touch-target`. Here it
                reads as "back" rather than "close" because a takeover replaced the navigation the user
                would otherwise have used to leave. */}
            <button
              type="button"
              aria-label={back}
              title={back}
              onClick={onBack}
              className="overlay-touch-target flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <ChevronLeft size={18} aria-hidden />
            </button>
            <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold text-foreground">{title}</h2>
            {toolbar ? <div className="ml-auto flex min-w-0 items-center gap-2">{toolbar}</div> : null}
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <OverlayDepthProvider>{children}</OverlayDepthProvider>
          </div>
        </DialogContent>
      </div>
    </Dialog>,
    document.body,
  );
}
