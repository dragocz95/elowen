'use client';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useDialogOverlay } from './overlayStack';

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
  /** Fullscreen keeps the same portal/overlay/focus contract while using the available viewport. */
  presentation?: 'center' | 'drawer' | 'fullscreen';
}

const SIZES = {
  lg: 'h-[88vh] w-[92vw] max-w-[90rem]',
  xl: 'max-h-[90vh] w-full max-w-2xl',
  md: 'max-h-[88vh] w-full max-w-lg',
  sm: 'max-h-[80vh] w-full max-w-md',
};

export function Modal({ title, onClose, children, size = 'lg', icon: Icon, description, headerActions, presentation = 'center' }: ModalProps) {
  const drawer = presentation === 'drawer';
  const fullscreen = presentation === 'fullscreen';
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
      className={`overlay-layer-modal fixed inset-0 flex bg-black/70 ${drawer ? 'justify-end' : fullscreen ? 'items-stretch justify-stretch p-0 sm:p-2' : 'items-center justify-center p-4'}`}
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
        // `focus:outline-none` on the dialog itself: the overlay focuses this element on open
        // (overlayStack.ts) so the focus trap and screen readers have an anchor, but it is `tabIndex={-1}`
        // and not interactive, so the browser's focus ring around the whole window says nothing. Opening a
        // modal from the keyboard — a slash command, for instance — made `:focus-visible` match and drew a
        // bright outline around the entire dialog that vanished on the first click inside. Controls INSIDE
        // keep their own rings; this only silences the container's.
        className={drawer
          ? 'animate-drawer-in flex h-full w-[min(38rem,calc(100vw-3rem))] flex-col rounded-l-lg border-l border-border focus:outline-none'
          : fullscreen
            ? 'animate-pop-in relative flex min-h-0 w-full flex-col border border-border bg-surface focus:outline-none sm:rounded-lg'
            : `animate-pop-in flex flex-col rounded-lg bg-surface border border-border focus:outline-none ${SIZES[size]}`}
        // Drawers share the workspace detail rail's near-black document tone, not the lighter
        // surface tone of centered windows.
        style={drawer
          ? { background: 'var(--color-document)', boxShadow: '-2rem 0 5rem rgb(0 0 0 / 0.72)' }
          : fullscreen
            ? { height: 'calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom))', boxShadow: 'var(--shadow-raised)' }
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
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            ×
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {children}
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
