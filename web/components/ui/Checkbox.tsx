'use client';
import { Check } from 'lucide-react';

/** OLED-pattern checkbox: a presentational box. The clickable parent owns the toggle,
 *  so render it inside a button/label that flips `checked`. */
export function Checkbox({ checked, className = '' }: { checked: boolean; className?: string }) {
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
        checked ? 'border-accent bg-accent text-white' : 'border-border-strong bg-surface'
      } ${className}`}
      aria-hidden
    >
      <Check
        size={11}
        strokeWidth={3}
        className={`transition-transform duration-150 ${checked ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`}
        style={{ transitionTimingFunction: 'var(--ease-spring)' }}
      />
    </span>
  );
}
