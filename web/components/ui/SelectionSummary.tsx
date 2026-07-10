'use client';
import type { ReactNode } from 'react';
import { Settings2 } from 'lucide-react';

interface SelectionSummaryProps {
  /** Count line, e.g. "14 models · 5 providers". Empty hides the line (chip-only summaries). */
  countText: string;
  /** A few representative chips (the caller slices, typically first 3). */
  samples: { label: string; icon?: ReactNode }[];
  /** How many more items exist beyond the samples — renders a "+N" chip when > 0. */
  moreCount: number;
  onManage: () => void;
  manageLabel: string;
  /** Quiet document treatment for settings pages: no raised surface or chip chrome. */
  variant?: 'default' | 'line';
}

/** Compact on-page summary for a managed selection: a count line, sample chips and a
 *  "Manage" button that opens the ManageSelectionModal. Replaces long toggle-pill rows. */
export function SelectionSummary({ countText, samples, moreCount, onManage, manageLabel, variant = 'default' }: SelectionSummaryProps) {
  const line = variant === 'line';
  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${line ? 'border-b border-border/80 py-2.5' : 'rounded-xl border border-border bg-surface px-3.5 py-3'}`}
      style={line ? undefined : { boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {countText ? <span className="text-xs font-medium text-text">{countText}</span> : null}
        {(samples.length > 0 || moreCount > 0) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {samples.map((s) => (
              <span key={s.label} className={`inline-flex max-w-full items-center gap-1.5 text-[11px] ${line ? 'text-text' : 'rounded-md border border-border bg-elevated px-2 py-0.5 text-text-muted'}`}>
                {s.icon ? <span aria-hidden className="shrink-0">{s.icon}</span> : null}
                <span className="truncate">{s.label}</span>
              </span>
            ))}
            {moreCount > 0 && (
              <span className={`font-mono text-[11px] text-text-muted ${line ? '' : 'rounded-md border border-border bg-elevated px-2 py-0.5'}`}>+{moreCount}</span>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onManage}
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-elevated hover:text-text ${line ? '' : 'border border-border bg-transparent'}`}
      >
        <Settings2 size={13} aria-hidden />
        {manageLabel}
      </button>
    </div>
  );
}
