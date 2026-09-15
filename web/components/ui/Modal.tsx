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
  /** `page` is the intercepted-page frame and is owned by `PageOverlay`; the rest are ordinary dialogs. */
  size?: 'lg' | 'xl' | 'md' | 'sm' | 'page';
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
  /** What this dialog is for, and the only thing a call site knows that the rules cannot work out for
   *  themselves. It picks the z-band — `inspect` is a browsing surface on the drawer band, `edit` is a
   *  working surface on the modal band above it — and feeds the shared presentation rule, whose phone
   *  answer is currently the full viewport either way. A dialog is an editing surface unless it says
   *  otherwise. */
  intent?: OverlayIntent;
  /** A softer veil is reserved for inspection surfaces whose surrounding visual context is part of what
   *  the reader is inspecting (for example a selected node in the memory brain). Geometry, focus isolation
   *  and dismissal stay identical; only the shared scrim token changes. */
  scrim?: 'default' | 'soft';
  /** Whether the surface is a panel. `card` — the default — is every dialog, drawer and sheet in the app:
   *  the header with its title, subtitle, actions and close control, and the shared material drawn around
   *  a scrolling body.
   *
   *  `bare` is a surface whose content IS the frame. The header is not rendered, so `title` names the
   *  dialog to a screen reader without being drawn above it (`icon`, `description`, `headerActions` and
   *  `closeLabel` are header parts and have nowhere to go), and `children` are the surface's own content
   *  rather than a body inside one. The portal, the overlay stack, the focus trap, Escape, the backdrop
   *  rule and the return of focus are the same code, which is the entire reason a frameless overlay is a
   *  presentation of this component instead of a second implementation beside it. Today: the chat image
   *  lightbox, where a card around a picture is the thing the reader clicked past. */
  chrome?: 'card' | 'bare';
  /** Accessible name of the header's close control. Defaults to the app's own "Close"; passed only by
   *  callers that already hold a translated label of their own. */
  closeLabel?: string;
  /** Blocks header, Escape, and backdrop dismissal while an owned async save is in flight. */
  closeDisabled?: boolean;
  /** This dialog IS a page rather than a step taken from one: an intercepted route (`/settings`)
   *  presented over the surface that linked to it. Two things follow, and they are the same statement.
   *  Anything opened from inside it resolves at the depth the canonical page would give it, so the first
   *  editor raised from Settings is still a right-hand drawer; and the surface itself takes the page band
   *  BELOW those drawers, because a stand-in that outranked what it opens would paint over it. */
  standsInForPage?: boolean;
  /** Widens a drawer for content that genuinely needs the room (log tables, diagnostics). Defaults to
   *  wide for `size="lg"`, so a dialog that already declared it needs a large frame keeps that room
   *  when it renders as a drawer instead. Ignored by the other presentations, which take `size`. */
  drawerWidth?: 'default' | 'wide';
  /** Announces that the dialog's own work is still running (a progress window over a durable operation). */
  'aria-busy'?: true;
  /** Addresses the dialog surface itself from a test. */
  'data-testid'?: string;
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
export function Modal({ title, onClose, children, size = 'lg', icon: Icon, description, headerActions, presentation = 'auto', intent = 'edit', scrim = 'default', chrome = 'card', standsInForPage = false, drawerWidth, closeLabel, closeDisabled = false, 'aria-busy': busy, 'data-testid': testId }: ModalProps) {
  const requestClose = () => { if (!closeDisabled) onClose(); };
  const wide = (drawerWidth ?? (size === 'lg' ? 'wide' : 'default')) === 'wide';
  const automatic = useOverlayPresentation(intent);
  const resolved = presentation === 'auto' ? automatic : presentation;
  // The headerless presentation. Everything below the header stays shared, which is the point of raising
  // a frameless surface through this component rather than beside it.
  const bare = chrome === 'bare';
  // The resolved SHAPE owns the z-band. Only a top-level drawer belongs under modal dialogs; an inspect
  // surface forced or nested into a centered/fullscreen presentation must stay on the modal band, or it
  // paints underneath the dialog that opened it. A page stand-in is the exception the shape cannot state:
  // it ranks below both, because everything it opens is opened FROM it.
  const layer = standsInForPage ? 'page' : resolved === 'drawer' ? 'drawer' : 'modal';
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
    <Dialog open onOpenChange={(open) => { if (!open) requestClose(); }}>
      <DialogOverlay
        ref={overlayRef}
        presentation={resolved}
        layer={layer}
        scrim={scrim}
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
          requestClose();
        }}
      >
        <DialogContent
          ref={dialogRef}
          presentation={resolved}
          chrome={chrome}
          size={size}
          width={wide ? 'wide' : 'default'}
          // A header names a dialog by showing a heading and pointing at it; a bare surface has no heading
          // to point at, so the very same title is stated as the surface's label instead — heard, not drawn.
          aria-label={bare ? title : undefined}
          aria-labelledby={bare ? undefined : titleId}
          aria-describedby={!bare && description ? descriptionId : undefined}
          aria-busy={busy}
          data-elowen-modal
          data-testid={testId}
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
          onClick={(e) => e.stopPropagation()}
        >
          {/* One branch, and it is only about what is DRAWN: a bare surface has no header to draw and no
              body region to scroll, because its content is the surface. Everything above this — portal,
              overlay stack, focus trap, Escape, the backdrop rule — is shared by both, and the card branch
              is exactly what it was. */}
          {bare ? (
            <OverlayDepthProvider standsInForPage={standsInForPage}>{children}</OverlayDepthProvider>
          ) : (
            <>
              <DialogHeader
                title={title}
                titleId={titleId}
                description={description}
                descriptionId={description ? descriptionId : undefined}
                icon={Icon}
                actions={headerActions}
                closeLabel={closeLabel ?? t.common.close}
                closeDisabled={closeDisabled}
                onClose={requestClose}
              />
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <OverlayDepthProvider standsInForPage={standsInForPage}>{children}</OverlayDepthProvider>
              </div>
            </>
          )}
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
 *  its natural height; the region scrolls.
 *
 *  `overscroll-contain` stops the scroll CHAINING at the ends of that region: without it, a flick past
 *  the last row hands the remaining momentum to whatever scrolls underneath — the page behind the
 *  overlay, or on a touch device the browser's own pull-to-refresh. The overlay stack already locks
 *  `body` while an overlay is up, which is why the page rarely moved; a drawer opened over another
 *  scrolling surface had no such protection, and the detail rail carried this containment in its own
 *  stylesheet precisely because it needed it. It belongs to the one scroll region every overlay uses. */
export function ModalBody({ children, gap = 5 }: { children: ReactNode; gap?: 4 | 5 | 6 }) {
  const gapClass = gap === 4 ? 'gap-4' : gap === 6 ? 'gap-6' : 'gap-5';
  return <div className={`flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-5 ${gapClass} [&>*]:shrink-0`}>{children}</div>;
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
