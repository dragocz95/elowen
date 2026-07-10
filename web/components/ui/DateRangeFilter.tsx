'use client';
import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { Input } from './Input';
import type { DateRange, RangePreset } from '../../lib/dateRange';

/** Compact date-range control shared by every view with a Today/7d/30d/90d/All/custom filter (Tasks,
 *  Kanban, Stats): a trigger showing the active window, opening a popover with quick presets and a
 *  custom from/to picker. Pure presentational + a single onChange — all window maths live in
 *  `lib/dateRange.ts`. */
export function DateRangeFilter({ value, onChange, compact = false }: { value: DateRange; onChange: (r: DateRange) => void; compact?: boolean }) {
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
    '7d': t.common.rangeLast7, '30d': t.common.rangeLast30, '90d': t.common.rangeLast90,
    today: t.common.rangeToday, all: t.common.rangeAll, custom: t.common.rangeCustom,
  };
  const label = value.preset === 'custom'
    ? `${value.from ?? '…'} – ${value.to ?? '…'}`
    : presetLabel[value.preset];

  const PRESETS: RangePreset[] = ['today', '7d', '30d', '90d', 'all'];
  const pickPreset = (p: RangePreset) => { onChange({ preset: p, from: null, to: null }); setOpen(false); };
  // Editing either date switches to a custom window, keeping whatever the other end already held.
  const setFrom = (from: string) => onChange({ preset: 'custom', from: from || null, to: value.to });
  const setTo = (to: string) => onChange({ preset: 'custom', from: value.from, to: to || null });

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`inline-flex items-center gap-2 rounded-md border border-border bg-bg font-medium text-text transition-colors hover:border-border-strong hover:bg-elevated ${compact ? 'h-8 px-2.5 text-xs' : 'h-9 px-3 text-sm'}`}
      >
        <CalendarDays size={compact ? 13 : 14} aria-hidden className="text-text-muted" />
        <span className={`${compact ? 'max-w-36' : 'max-w-[14rem]'} truncate`}>{label}</span>
        <ChevronDown size={compact ? 13 : 14} aria-hidden className="text-text-muted" />
      </button>

      {open && (
        <div role="dialog" aria-label={t.common.rangeLabel} className="absolute right-0 z-30 mt-2 w-64 rounded-lg border border-border bg-surface p-3 shadow-[var(--shadow-raised)]">
          <div className="flex flex-col gap-1">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => pickPreset(p)}
                aria-pressed={value.preset === p}
                className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${value.preset === p ? 'bg-accent/[0.1] font-medium text-accent' : 'text-text hover:bg-elevated'}`}
              >
                {presetLabel[p]}
              </button>
            ))}
          </div>
          <div className="mt-3 border-t border-border pt-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">{t.common.rangeCustom}</p>
            <label className="mb-2 flex items-center gap-2 text-xs text-text-muted">
              <span className="w-7 shrink-0">{t.common.rangeFrom}</span>
              <Input type="date" value={value.from ?? ''} max={value.to ?? undefined} onChange={(e) => setFrom(e.target.value)} className="h-8" />
            </label>
            <label className="flex items-center gap-2 text-xs text-text-muted">
              <span className="w-7 shrink-0">{t.common.rangeTo}</span>
              <Input type="date" value={value.to ?? ''} min={value.from ?? undefined} onChange={(e) => setTo(e.target.value)} className="h-8" />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
