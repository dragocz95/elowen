'use client';
import type { ReactNode } from 'react';
import { Eye, Settings2 } from 'lucide-react';

interface SelectionSummaryProps {
  /** Count line, e.g. "14 models · 5 providers". Empty hides the line (chip-only summaries). */
  countText: string;
  /** A few representative chips (the caller slices, typically first 3). `id` keeps equal visible labels
   * distinct when two providers expose the same model; older callers may omit it. */
  samples: { id?: string; label: string; icon?: ReactNode }[];
  /** How many more items exist beyond the samples — renders a "+N" chip when > 0. */
  moreCount: number;
  onManage: () => void;
  manageLabel: string;
  /** More specific accessible name when several managed selections share one page. */
  manageAriaLabel?: string;
  /** Quiet document treatment for settings pages: no raised surface or chip chrome. */
  variant?: 'default' | 'line';
  /** The summary opens a display-only list (ManageSelectionModal in `readOnly` mode): the action is an
   *  EYE rather than a gear, so the button does not promise a setting the modal will not offer. */
  readOnly?: boolean;
  /** Chips the CALLER renders, shown after `samples`. For a summary whose membership the component
   *  cannot compute: a plugin connector knows whether it is currently linked and nothing here does, so
   *  it contributes the chip itself — through {@link SummaryChip}, so it is the same chip and not a
   *  lookalike. Renders nothing when the contributor decides it has nothing to claim. */
  extraSamples?: ReactNode;
}

/** One chip of a summary. Exported so a caller that owns a fact this component cannot see can still put
 *  it in the same row looking like everything beside it. */
export function SummaryChip({ icon, label, variant = 'default' }: { icon?: ReactNode; label: string; variant?: 'default' | 'line' }) {
  const line = variant === 'line';
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 text-[11px] ${line ? 'text-foreground' : 'rounded-md border border-border bg-muted px-2 py-0.5 text-muted-foreground'}`}>
      {icon ? <span aria-hidden className="shrink-0">{icon}</span> : null}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** Compact on-page summary for a managed selection: a count line, sample chips and a
 *  "Manage" button that opens the ManageSelectionModal. Replaces long toggle-pill rows. */
export function SelectionSummary({ countText, samples, moreCount, onManage, manageLabel, manageAriaLabel, variant = 'default', readOnly = false, extraSamples }: SelectionSummaryProps) {
  const line = variant === 'line';
  return (
    <div
      data-selection-summary
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${line ? 'border-b border-border/80 py-2.5' : 'rounded-xl border border-border bg-card px-3.5 py-3'}`}
      style={line ? undefined : { boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {countText ? <span className="text-xs font-medium text-foreground">{countText}</span> : null}
        {(samples.length > 0 || moreCount > 0 || extraSamples) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {samples.map((s) => (
              <SummaryChip key={s.id ?? s.label} icon={s.icon} label={s.label} variant={variant} />
            ))}
            {extraSamples}
            {moreCount > 0 && (
              <span className={`font-mono text-[11px] text-muted-foreground ${line ? '' : 'rounded-md border border-border bg-muted px-2 py-0.5'}`}>+{moreCount}</span>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        data-selection-manage
        onClick={onManage}
        aria-label={manageAriaLabel}
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground ${line ? '' : 'border border-border bg-transparent'}`}
      >
        {readOnly ? <Eye size={13} aria-hidden /> : <Settings2 size={13} aria-hidden />}
        {manageLabel}
      </button>
    </div>
  );
}
