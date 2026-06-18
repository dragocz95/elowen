'use client';
import { type ReactNode, useEffect } from 'react';
import { useTranslation } from '../../lib/i18n';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: 'lg' | 'xl' | 'md' | 'sm';
}

const SIZES = {
  lg: 'h-[88vh] w-[92vw]',
  xl: 'max-h-[90vh] w-full max-w-2xl',
  md: 'max-h-[88vh] w-full max-w-lg',
  sm: 'max-h-[80vh] w-full max-w-md',
};

export function Modal({ title, onClose, children, size = 'lg' }: ModalProps) {
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`animate-pop-in flex flex-col rounded-lg bg-surface border border-border ${SIZES[size]}`}
        style={{ boxShadow: 'var(--shadow-raised)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <span className="text-sm font-medium text-text">{title}</span>
          <button
            type="button"
            aria-label={t.common.close}
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            ×
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  );
}
