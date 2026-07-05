'use client';
import type { ReactNode } from 'react';

/** A labelled row of single-select pills (accent when active), mirroring the app's pill styling.
 *  Shared by the account sections (Personality's style picker, Orca AI's thinking level). */
export function PillGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-tiny font-semibold uppercase tracking-wide text-text-muted">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

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
