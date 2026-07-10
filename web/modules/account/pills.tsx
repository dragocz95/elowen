'use client';
import type { ReactNode } from 'react';

export function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`inline-flex items-center rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${on ? 'border-accent/50 bg-accent/15 text-accent' : 'border-border bg-elevated text-text-muted hover:border-border-strong hover:text-text'}`}
      style={{ transitionDuration: 'var(--motion-fast)' }}
    >
      {children}
    </button>
  );
}
