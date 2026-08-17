'use client';
import { Gauge } from 'lucide-react';
import type { MemoryCategory } from '../../lib/types';
import { Slider } from '../../components/ui/Slider';
import { SelectMenu } from '../../components/ui/SelectMenu';
import { CategoryIcon } from '../../lib/categoryIcons';
import { categorySwatch } from './memoryMeta';

/** A 1..5 integer rank (importance) edited as a stepped slider with an "n / 5" readout — NOT a 0..1
 *  weight, so it must never go through pct01 (the server validates importance as an int in 1..5).
 *  Shared by the create and edit memory modals so both expose importance identically. */
export function RankSlider({ label, icon: Icon = Gauge, value, onChange }: { label: string; icon?: typeof Gauge; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="inline-flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        <span className="inline-flex items-center gap-1"><Icon size={11} aria-hidden />{label}</span>
        <span className="font-mono text-text">{value} / 5</span>
      </span>
      <Slider value={value} min={1} max={5} step={1} onChange={onChange} />
    </div>
  );
}

/** Category picker shared by the create and edit memory modals. SelectMenu owns the dropdown chrome
 *  and lets every option carry the same category icon and colour shown by the rest of the memory UI. */
export function CategorySelect({ categories, value, onChange, ariaLabel, noneLabel }: {
  categories: MemoryCategory[]; value: number | null; onChange: (v: number | null) => void; ariaLabel: string; noneLabel: string;
}) {
  return (
    <SelectMenu<string>
      value={value == null ? '' : String(value)}
      onChange={(next) => onChange(next === '' ? null : Number(next))}
      label={ariaLabel}
      options={[
        { value: '', label: noneLabel, icon: <CategoryIcon name={undefined} size={16} /> },
        ...categories.map((category) => ({
          value: String(category.id),
          label: category.name,
          icon: <span style={{ color: categorySwatch(category.color) }}><CategoryIcon name={category.icon} size={16} /></span>,
        })),
      ]}
    />
  );
}
