'use client';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: 'lg' | 'xl' | 'md' | 'sm';
  /** Optional leading icon shown in a badge before the title. */
  icon?: LucideIcon;
  /** Optional one-line subtitle under the title (e.g. the target id). */
  description?: string;
}

const SIZES = {
  lg: 'h-[88vh] w-[92vw] max-w-[90rem]',
  xl: 'max-h-[90vh] w-full max-w-2xl',
  md: 'max-h-[88vh] w-full max-w-lg',
  sm: 'max-h-[80vh] w-full max-w-md',
};

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'iframe',
  'object',
  'embed',
  'audio[controls]',
  'video[controls]',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(',');

function isTabbable(element: HTMLElement) {
  if (element.tabIndex < 0 || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  if ('disabled' in element && element.disabled) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function tabbableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(isTabbable)
    .map((element, domIndex) => ({ element, domIndex }))
    .sort((a, b) => {
      const aIndex = a.element.tabIndex;
      const bIndex = b.element.tabIndex;
      if (aIndex > 0 && bIndex <= 0) return -1;
      if (bIndex > 0 && aIndex <= 0) return 1;
      if (aIndex > 0 && bIndex > 0 && aIndex !== bIndex) return aIndex - bIndex;
      return a.domIndex - b.domIndex;
    })
    .map(({ element }) => element);
}

function topmostModal() {
  const modals = document.querySelectorAll<HTMLElement>('[data-elowen-modal]');
  return modals.item(modals.length - 1);
}

export function Modal({ title, onClose, children, size = 'lg', icon: Icon, description }: ModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // Portal to <body> so the fixed overlay is positioned against the viewport, not trapped inside a
  // transformed/clipping ancestor (a card with a transform turns `position: fixed` into "fixed to the
  // card" → the modal renders inside the card and flickers with the card's hover state). Mounted-gated
  // because createPortal needs `document`, which isn't there during SSR.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const activeElement = document.activeElement;
    returnFocusRef.current = activeElement instanceof HTMLElement && activeElement !== document.body
      ? activeElement
      : null;
    setMounted(true);

    return () => {
      const returnTarget = returnFocusRef.current;
      if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const dialog = dialogRef.current;
    if (!dialog || dialog.contains(document.activeElement)) return;

    const requestedFocus = dialog.querySelector<HTMLElement>('[data-autofocus], [autofocus]');
    if (requestedFocus && isTabbable(requestedFocus)) {
      requestedFocus.focus({ preventScroll: true });
      return;
    }
    dialog.focus({ preventScroll: true });
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;

    const handler = (e: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || topmostModal() !== dialog) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const tabbables = tabbableElements(dialog);
      if (tabbables.length === 0) {
        e.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = tabbables[0];
      const last = tabbables[tabbables.length - 1];
      const activeElement = document.activeElement;

      if (e.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!e.shiftKey && (activeElement === last || !dialog.contains(activeElement) || activeElement === dialog)) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mounted, onClose]);

  if (!mounted) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        // Portal events still bubble through their React tree. Stop at this backdrop so clicking a
        // nested modal's backdrop cannot also reach and close its parent modal.
        event.stopPropagation();
        if (topmostModal() === dialogRef.current) onClose();
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
        className={`animate-pop-in flex flex-col rounded-lg bg-surface border border-border ${SIZES[size]}`}
        style={{ boxShadow: 'var(--shadow-raised)' }}
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
    <div className={`flex shrink-0 items-center gap-2 border-t border-border px-5 py-3 ${status ? 'justify-between' : 'justify-end'}`}>
      {status ? <div className="min-w-0">{status}</div> : null}
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
