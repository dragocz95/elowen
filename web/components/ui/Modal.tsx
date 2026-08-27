'use client';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useDialogOverlay } from './overlayStack';
import { OverlayDepthProvider, useOverlayPresentation, type OverlayIntent } from './overlayDepth';

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
  /** What this dialog is for. Only consulted while `presentation` is `auto`, and only changes the
   *  answer on a phone, where a surface you read wants a bottom sheet and a surface you work in wants
   *  the screen. A dialog is an editing surface unless it says otherwise. */
  intent?: OverlayIntent;
  /** Widens a drawer for content that genuinely needs the room (log tables, diagnostics). Defaults to
   *  wide for `size="lg"`, so a dialog that already declared it needs a large frame keeps that room
   *  when it renders as a drawer instead. Ignored by the other presentations, which take `size`. */
  drawerWidth?: 'default' | 'wide';
}

/** dvh throughout: a mobile browser's collapsing toolbar makes `vh` taller than the screen actually
 *  is, which put the footer of every one of these under the browser chrome. */
const SIZES = {
  lg: 'h-[88dvh] w-[92vw] max-w-[90rem]',
  xl: 'max-h-[90dvh] w-full max-w-2xl',
  md: 'max-h-[88dvh] w-full max-w-lg',
  sm: 'max-h-[80dvh] w-full max-w-md',
};

export function Modal({ title, onClose, children, size = 'lg', icon: Icon, description, headerActions, presentation = 'auto', intent = 'edit', drawerWidth }: ModalProps) {
  const wide = (drawerWidth ?? (size === 'lg' ? 'wide' : 'default')) === 'wide';
  const automatic = useOverlayPresentation(intent);
  const resolved = presentation === 'auto' ? automatic : presentation;
  const drawer = resolved === 'drawer';
  const sheet = resolved === 'sheet';
  const fullscreen = resolved === 'fullscreen';
  // Sheets and fullscreen dialogs are laid out by `.overlay-surface[data-presentation]`, which owns the
  // dvh height and the safe-area insets in one place for every overlay in the app.
  const surface = sheet || fullscreen;
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Portal to <body> so the fixed overlay is positioned against the viewport, not trapped inside a
  // transformed/clipping ancestor (a card with a transform turns `position: fixed` into "fixed to the
  // card" → the modal renders inside the card and flickers with the card's hover state). Mounted-gated
  // because createPortal needs `document`, which isn't there during SSR.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useDialogOverlay({ enabled: mounted, rootRef: overlayRef, dialogRef, onClose });

  if (!mounted) return null;
  return createPortal(
    <div
      ref={overlayRef}
      className={`overlay-layer-modal fixed inset-0 flex bg-bg/70 ${drawer ? 'justify-end' : surface ? 'items-stretch justify-stretch p-0' : 'items-center justify-center'}`}
      // A centered dialog keeps its 1rem breathing room, widened to the safe area where the device has
      // one — in landscape the notch is on a SIDE, so a fixed inset is not enough on its own.
      style={drawer || surface ? undefined : {
        paddingBlock: 'max(1rem, var(--safe-top)) max(1rem, var(--safe-bottom))',
        paddingInline: 'max(1rem, var(--safe-left)) max(1rem, var(--safe-right))',
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        // Portal events still bubble through their React tree. Stop at this backdrop so clicking a
        // nested modal's backdrop cannot also reach and close its parent modal.
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        data-elowen-modal
        data-presentation={resolved}
        // `focus:outline-none` on the dialog itself: the overlay focuses this element on open
        // (overlayStack.ts) so the focus trap and screen readers have an anchor, but it is `tabIndex={-1}`
        // and not interactive, so the browser's focus ring around the whole window says nothing. Opening a
        // modal from the keyboard — a slash command, for instance — made `:focus-visible` match and drew a
        // bright outline around the entire dialog that vanished on the first click inside. Controls INSIDE
        // keep their own rings; this only silences the container's.
        className={drawer
          ? `animate-drawer-in flex h-full ${wide ? 'w-[min(72rem,calc(100vw-3rem))]' : 'w-[min(38rem,calc(100vw-3rem))]'} flex-col rounded-l-lg border-l border-border focus:outline-none`
          : sheet
            ? 'overlay-surface flex min-h-0 w-full flex-col focus:outline-none'
            : fullscreen
              ? 'overlay-surface animate-pop-in relative flex min-h-0 w-full flex-col border border-border bg-surface focus:outline-none'
              : `animate-pop-in flex flex-col rounded-lg bg-surface border border-border focus:outline-none ${SIZES[size]}`}
        // Drawers and sheets share the workspace detail rail's near-black document tone, not the
        // lighter surface tone of centered windows.
        style={drawer
          ? { background: 'var(--color-document)', boxShadow: '-2rem 0 5rem rgb(0 0 0 / 0.72)' }
          : sheet
            ? { background: 'var(--color-document)' }
            : { boxShadow: 'var(--shadow-raised)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          {Icon ? (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated">
              <Icon size={18} className="text-accent" aria-hidden />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-sm font-semibold text-text">{title}</h2>
            {description ? <p id={descriptionId} className="truncate text-xs text-text-muted">{description}</p> : null}
          </div>
          {headerActions ? <div className="flex shrink-0 items-center gap-2">{headerActions}</div> : null}
          <button
            type="button"
            aria-label={t.common.close}
            onClick={onClose}
            className="overlay-touch-target flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            ×
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <OverlayDepthProvider>{children}</OverlayDepthProvider>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Scrollable content region for a modal. Pair with `ModalFooter` to keep actions pinned
 *  below the scroll. `gap` tunes the vertical rhythm between fields. */
export function ModalBody({ children, gap = 5 }: { children: ReactNode; gap?: 4 | 5 | 6 }) {
  const gapClass = gap === 4 ? 'gap-4' : gap === 6 ? 'gap-6' : 'gap-5';
  return <div className={`flex min-h-0 flex-1 flex-col overflow-y-auto p-5 ${gapClass}`}>{children}</div>;
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
