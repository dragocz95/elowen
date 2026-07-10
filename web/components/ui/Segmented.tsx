'use client';
import { useRef } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface SegmentedOption { value: string; label: string; icon?: LucideIcon }

/** A connected segmented switch: one bordered track holding the options, the active one lifted with an
 *  accent fill. Single source of truth for single-choice toggles (mode, filters, type, priority,
 *  autonomy, PR workflow…). The track wraps when it can't fit, so long option sets degrade gracefully. */
export function Segmented({ options, value, onChange, size = 'md', className, nowrap = false, 'aria-label': ariaLabel }: {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  /** `sm` for tight inline rows (e.g. a manual phase line), `md` for full form fields. */
  size?: 'sm' | 'md';
  className?: string;
  /** Keep the track on one line (no wrapping). Pass it inside the single-line page toolbars so the
   *  header row scrolls horizontally instead of the control folding onto a second line. Off by default
   *  so long option sets (e.g. settings) still degrade gracefully by wrapping. */
  nowrap?: boolean;
  /** Accessible name for the radiogroup — pass it when the control acts as a labelled section nav. */
  'aria-label'?: string;
}) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pad = size === 'sm' ? 'px-2 py-1' : 'px-3 py-1.5';
  const wrap = nowrap ? 'flex-nowrap' : 'max-w-full flex-wrap';
  const selectedIndex = options.findIndex((option) => option.value === value);
  const tabbableIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % options.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next == null || !options[next]) return;
    event.preventDefault();
    onChange(options[next].value);
    buttonRefs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`inline-flex ${wrap} gap-0.5 rounded-md border border-border bg-surface p-0.5 ${className ?? ''}`}>
      {options.map((o, index) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={o.label}
            tabIndex={index === tabbableIndex ? 0 : -1}
            ref={(node) => { buttonRefs.current[index] = node; }}
            onClick={() => onChange(o.value)}
            onKeyDown={(event) => move(event, index)}
            className={`inline-flex items-center gap-1.5 rounded text-xs font-medium transition-colors ${pad} ${active ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-elevated hover:text-text'}`}
            style={{ transitionDuration: 'var(--motion-fast)' }}
          >
            {Icon ? <Icon size={13} aria-hidden /> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
