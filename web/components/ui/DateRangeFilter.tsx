'use client';
import { useState } from 'react';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { cn } from '../../lib/utils';
import { Input } from './Input';
import { Popover, PopoverContent, PopoverTrigger } from './shadcn/popover';
import { selectTriggerVariants } from './shadcn/select';
import type { DateRange, RangePreset } from '../../lib/dateRange';

/** The default preset set (the custom from/to picker rides the `custom` entry). Callers restrict it via
 *  the `presets` prop — e.g. the Timeline offers only 7d/30d/all and no custom picker. */
const DEFAULT_PRESETS: RangePreset[] = ['today', '7d', '30d', '90d', 'all', 'custom'];

/** Compact date-range control shared by every view with a preset/custom window (Tasks, Kanban, Stats,
 *  Timeline): a trigger showing the active window, opening a popover with quick presets and — when the
 *  caller allows it — a custom from/to picker. Pure presentational + a single onChange; all window maths
 *  live in `lib/dateRange.ts`. */
export function DateRangeFilter({ value, onChange, compact = false, presets = DEFAULT_PRESETS }: { value: DateRange; onChange: (r: DateRange) => void; compact?: boolean; presets?: RangePreset[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const presetLabel: Record<RangePreset, string> = {
    '7d': t.common.rangeLast7, '30d': t.common.rangeLast30, '90d': t.common.rangeLast90,
    today: t.common.rangeToday, all: t.common.rangeAll, custom: t.common.rangeCustom,
  };
  const label = value.preset === 'custom'
    ? `${value.from ?? '…'} – ${value.to ?? '…'}`
    : presetLabel[value.preset];

  const PRESETS = presets.filter((p) => p !== 'custom'); // 'custom' is the date picker below, not a button
  const allowCustom = presets.includes('custom');
  const pickPreset = (p: RangePreset) => { onChange({ preset: p, from: null, to: null }); setOpen(false); };
  // Editing either date switches to a custom window, keeping whatever the other end already held.
  const setFrom = (from: string) => onChange({ preset: 'custom', from: from || null, to: value.to });
  const setTo = (to: string) => onChange({ preset: 'custom', from: value.from, to: to || null });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          // The shared picker-trigger surface, so this control cannot drift from the Select and the
          // project filter it sits beside. `w-auto` because a filter is sized by its label, not by its
          // column, and `inline-flex` because it sits in a wrapping toolbar row.
          className={cn(selectTriggerVariants(), 'inline-flex w-auto font-medium focus-visible:ring-2 focus-visible:ring-ring')}
        >
          <CalendarDays size={compact ? 13 : 14} aria-hidden className="text-muted-foreground" />
          <span className={`${compact ? 'max-w-36' : 'max-w-[14rem]'} truncate`}>{label}</span>
          <ChevronDown size={compact ? 13 : 14} aria-hidden className="text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </PopoverTrigger>

      <PopoverContent role="dialog" aria-label={t.common.rangeLabel} align="end" className="w-64 p-3">
        <div className="flex flex-col gap-1">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => pickPreset(p)}
              aria-pressed={value.preset === p}
              className="flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground aria-pressed:bg-primary/10 aria-pressed:font-medium aria-pressed:text-primary"
            >
              {presetLabel[p]}
            </button>
          ))}
        </div>
        {allowCustom && (
          <div className="mt-3 border-t border-border pt-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t.common.rangeCustom}</p>
            <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="w-7 shrink-0">{t.common.rangeFrom}</span>
              <Input type="date" value={value.from ?? ''} max={value.to ?? undefined} onChange={(e) => setFrom(e.target.value)} className="h-8" />
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="w-7 shrink-0">{t.common.rangeTo}</span>
              <Input type="date" value={value.to ?? ''} min={value.from ?? undefined} onChange={(e) => setTo(e.target.value)} className="h-8" />
            </label>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
