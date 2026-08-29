'use client';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { focusOverlaySurface, useOverlayIsolation } from './overlayStack';
import { OverlayDepthProvider, useOverlayPresentation, type OverlayIntent } from './overlayDepth';
import { Dialog, DialogContent, DialogHeader, DialogOverlay } from './shadcn/dialog';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: 'lg' | 'xl' | 'md' | 'sm';
  /** Optional leading icon shown in a badge before the title. */
  icon?: LucideIcon;
  /** Optional one-line subtitle under the title (e.g. the target id). */
  description?: string;
  /** Actions rendered in the shared header before the close button. */
  headerActions?: ReactNode;
  /** Every presentation keeps the same portal/overlay/focus contract; only the geometry differs.
   *
   *  Left alone this is `auto`, which `resolveOverlayPresentation` (overlayDepth.tsx) works out from
   *  how deep the overlay already is AND how much room the window has: with room, the first click out
   *  of a section opens a right-hand drawer and anything opened FROM it is a centered window; on a
   *  phone the same dialog takes the screen instead. Pass a literal only to opt out — a confirmation
   *  is a centered dialog wherever it is raised, and a few data-heavy surfaces want the whole
   *  viewport regardless of depth. */
  presentation?: 'auto' | 'center' | 'drawer' | 'sheet' | 'fullscreen';
  /** What this dialog is for. Retained as semantic input to the shared presentation rule; automatic
   *  phone overlays currently all use the full viewport. A dialog is an editing surface unless it says
   *  otherwise. */
  intent?: OverlayIntent;
  /** Widens a drawer for content that genuinely needs the room (log tables, diagnostics). Defaults to
   *  wide for `size="lg"`, so a dialog that already declared it needs a large frame keeps that room
   *  when it renders as a drawer instead. Ignored by the other presentations, which take `size`. */
  drawerWidth?: 'default' | 'wide';
}

/** The app's dialog, on the shadcn `Dialog` in `./shadcn/dialog` and therefore on Radix.
 *
 *  WHAT RADIX OWNS NOW: the focus trap (`FocusScope`, which loops Tab, pulls focus back when it escapes
 *  and pauses the parent scope while a nested dialog is up), Escape and the layer stack that decides
 *  which of several open dialogs Escape belongs to. The hand-written equivalents used to live in
 *  `overlayStack.ts`; running both would mean two implementations answering the same Tab and moving
 *  focus twice, so this component takes `useOverlayIsolation` and nothing more.
 *
 *  WHAT THE APP STILL OWNS, because Radix has no notion of it:
 *   - the overlay stack and its `inert` isolation, which is also what keeps a rail or takeover UNDER a
 *     dialog from acting on the same Escape;
 *   - which element takes focus on open (`[data-autofocus]`, else the surface) and which element gets it
 *     back on close — Radix restores focus to a `Dialog.Trigger`, and this dialog is mounted on open
 *     rather than opened from a trigger, so there is nothing for Radix to restore to;
 *   - the presentation rule (drawer / centered window / fullscreen on a phone);
 *   - the backdrop press, which must stop at the backdrop it was aimed at so a nested dialog cannot also
 *     close its parent. Radix's own outside-press dismissal is turned off for that reason, rather than
 *     left running as a second way to close the same dialog. */
export function Modal({ title, onClose, children, size = 'lg', icon: Icon, description, headerActions, presentation = 'auto', intent = 'edit', drawerWidth }: ModalProps) {
  const wide = (drawerWidth ?? (size === 'lg' ? 'wide' : 'default')) === 'wide';
  const automatic = useOverlayPresentation(intent);
  const resolved = presentation === 'auto' ? automatic : presentation;
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  /** Whether the press that is about to produce a click started on the backdrop itself. */
  const pressedBackdrop = useRef(false);
  // Portal to <body> so the fixed overlay is positioned against the viewport, not trapped inside a
  // transformed/clipping ancestor (a card with a transform turns `position: fixed` into "fixed to the
  // card" → the modal renders inside the card and flickers with the card's hover state). It is also what
  // `overlayStack` requires: it isolates the background by marking every OTHER child of <body> inert, so
  // the overlay root has to BE a child of <body>. Mounted-gated because createPortal needs `document`,
  // which isn't there during SSR.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { restoreFocus } = useOverlayIsolation({ enabled: mounted, rootRef: overlayRef });

  if (!mounted) return null;
  return createPortal(
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogOverlay
        ref={overlayRef}
        presentation={resolved}
        // A backdrop dismissal has to be a press that BEGAN on the backdrop, not merely a click event
        // whose target happens to be it. `click` fires on the common ancestor of the press and the
        // release, so a press that starts on a control and ends anywhere else still arrives here with
        // `target === currentTarget`. Radix Select makes that the normal case rather than an edge one:
        // opening it sets `pointer-events: none` on <body>, so the release no longer hit-tests onto the
        // trigger and the click surfaces on this backdrop — which closed the whole dialog the moment
        // anyone opened a picker inside it. Recording where the press started is what tells the two
        // apart, and it covers every control that disables or unmounts itself between press and release.
        onPointerDown={(event) => { pressedBackdrop.current = event.target === event.currentTarget; }}
        onClick={(event) => {
          if (event.target !== event.currentTarget || !pressedBackdrop.current) return;
          pressedBackdrop.current = false;
          // Portal events still bubble through their React tree. Stop at this backdrop so clicking a
          // nested modal's backdrop cannot also reach and close its parent modal.
          event.stopPropagation();
          onClose();
        }}
      >
        <DialogContent
          ref={dialogRef}
          presentation={resolved}
          size={size}
          width={wide ? 'wide' : 'default'}
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          data-elowen-modal
          // Radix would otherwise dismiss on any press outside the surface, which is a second owner of a
          // decision the backdrop above already makes — and one that does not know a nested dialog's
          // backdrop must not close its parent.
          onInteractOutside={(event) => event.preventDefault()}
          // Focus policy stays the app's; only the trap around it is Radix's. Both defaults are declined:
          // Radix would focus the first tabbable control on open (this app anchors on the surface unless
          // a call site asked for a control) and hand focus to a trigger on close (there is none).
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (dialogRef.current) focusOverlaySurface(dialogRef.current);
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
          // Drawers and sheets share the workspace detail rail's near-black document tone, not the
          // lighter surface tone of centered windows.
          style={resolved === 'drawer'
            // The cast shadow is the page's own canvas at 72%, not a literal black: --color-bg is what a
            // skin moves when it moves the document's darkest tone, and a frozen black under a pale skin
            // is a smudge rather than depth.
            ? { background: 'var(--color-document)', boxShadow: '-2rem 0 5rem color-mix(in srgb, var(--color-bg) 72%, transparent)' }
            : resolved === 'sheet'
              ? { background: 'var(--color-document)' }
              : { boxShadow: 'var(--shadow-raised)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader
            title={title}
            titleId={titleId}
            description={description}
            descriptionId={descriptionId}
            icon={Icon}
            actions={headerActions}
            closeLabel={t.common.close}
            onClose={onClose}
          />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <OverlayDepthProvider>{children}</OverlayDepthProvider>
          </div>
        </DialogContent>
      </DialogOverlay>
    </Dialog>,
    document.body,
  );
}

/** Scrollable content region for a modal. Pair with `ModalFooter` to keep actions pinned
 *  below the scroll. `gap` tunes the vertical rhythm between fields.
 *
 *  `[&>*]:shrink-0` is what makes it SCROLL rather than merely clip. This is a flex column, so its
 *  children take the default `flex-shrink: 1` and a column that overflows compresses them to fit
 *  instead of overflowing itself — `scrollHeight` then equals `clientHeight`, there is nothing to
 *  scroll, and any child carrying `overflow-hidden` (a bordered list, a table frame) silently eats
 *  the rows that no longer fit. On the phone's fullscreen Tasks overlay that clipped 1785px of a
 *  2429px list and squashed the filter input from 36px to 23px. Content in a scrolling region keeps
 *  its natural height; the region scrolls. */
export function ModalBody({ children, gap = 5 }: { children: ReactNode; gap?: 4 | 5 | 6 }) {
  const gapClass = gap === 4 ? 'gap-4' : gap === 6 ? 'gap-6' : 'gap-5';
  return <div className={`flex min-h-0 flex-1 flex-col overflow-y-auto p-5 ${gapClass} [&>*]:shrink-0`}>{children}</div>;
}

/** Pinned action row at the bottom of a modal, divided from the scrollable body. An optional `status`
 *  node (e.g. the auto-save indicator) sits on the left while actions stay right-aligned. */
export function ModalFooter({ children, status }: { children?: ReactNode; status?: ReactNode }) {
  return (
    <div className={`flex shrink-0 flex-col items-stretch gap-2 border-t border-border px-5 py-3 sm:flex-row sm:items-center ${status ? 'sm:justify-between' : 'sm:justify-end'}`}>
      {status ? <div className="min-w-0 w-full sm:w-auto">{status}</div> : null}
      <div className="flex max-w-full flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}
