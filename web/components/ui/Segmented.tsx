'use client';
import type { LucideIcon } from 'lucide-react';

export interface SegmentedOption { value: string; label: string; icon?: LucideIcon }

export function Segmented({ options, value, onChange }: { options: SegmentedOption[]; value: string; onChange: (value: string) => void }) {
  return (
    <div role="radiogroup" className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={o.label}
            onClick={() => onChange(o.value)}
            className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors ${active ? 'border-accent/50 bg-accent/15 text-accent' : 'border-border bg-elevated text-text-muted hover:border-border-strong hover:text-text'}`}
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
