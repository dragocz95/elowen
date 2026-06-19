'use client';
import { type ReactNode, useEffect } from 'react';
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
  lg: 'h-[88vh] w-[92vw]',
  xl: 'max-h-[90vh] w-full max-w-2xl',
  md: 'max-h-[88vh] w-full max-w-lg',
  sm: 'max-h-[80vh] w-full max-w-md',
};

export function Modal({ title, onClose, children, size = 'lg', icon: Icon, description }: ModalProps) {
  const { t } = useTranslation();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
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
            <h2 className="truncate text-sm font-semibold text-text">{title}</h2>
            {description ? <p className="truncate text-xs text-text-muted">{description}</p> : null}
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
    </div>
  );
}

/** Scrollable content region for a modal. Pair with `ModalFooter` to keep actions pinned
 *  below the scroll. `gap` tunes the vertical rhythm between fields. */
export function ModalBody({ children, gap = 5 }: { children: ReactNode; gap?: 4 | 5 | 6 }) {
  const gapClass = gap === 4 ? 'gap-4' : gap === 6 ? 'gap-6' : 'gap-5';
  return <div className={`flex min-h-0 flex-1 flex-col overflow-y-auto p-5 ${gapClass}`}>{children}</div>;
}

/** Pinned action row at the bottom of a modal, divided from the scrollable body. */
export function ModalFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
      {children}
    </div>
  );
}
