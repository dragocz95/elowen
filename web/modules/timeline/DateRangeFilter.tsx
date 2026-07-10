'use client';
import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import type { DateRange, RangePreset } from './dateRange';
import { RANGE_PRESETS } from './dateRange';

/** Compact date-range control for the Timeline view: a trigger showing the active window, opening a
 *  popover with quick presets (7d / 30d / all). Pure presentational + a single onChange —
 *  all window maths live in `dateRange.ts`. */
export function DateRangeFilter({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const presetLabel: Record<RangePreset, string> = {
    '7d': t.timeline.rangeLast7,
    '30d': t.timeline.rangeLast30,
    all: t.timeline.rangeAll,
  };

  const pickPreset = (p: RangePreset) => { onChange({ preset: p }); setOpen(false); };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-bg px-3 text-sm font-medium text-text transition-colors hover:border-border-strong hover:bg-elevated"
      >
        <CalendarDays size={14} aria-hidden className="text-text-muted" />
        <span className="max-w-[14rem] truncate">{presetLabel[value.preset]}</span>
        <ChevronDown size={14} aria-hidden className="text-text-muted" />
      </button>

      {open && (
        <div role="dialog" aria-label={t.timeline.rangeLabel} className="absolute right-0 z-30 mt-2 w-48 rounded-lg border border-border bg-surface p-2 shadow-[var(--shadow-raised)]">
          <div className="flex flex-col gap-1">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => pickPreset(p)}
                aria-pressed={value.preset === p}
                className={`flex items-center rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${value.preset === p ? 'bg-accent/[0.1] font-medium text-accent' : 'text-text hover:bg-elevated'}`}
              >
                {presetLabel[p]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
