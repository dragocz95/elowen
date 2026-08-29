'use client';

import type { ReactNode } from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger } from './shadcn/select';

export interface SelectMenuOption<T extends string = string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

/**
 * Shared single-choice dropdown, composed from the shadcn/ui `Select` parts in `./select.tsx`.
 *
 * The keyboard contract — arrows, Home/End, typeahead, Enter, Escape, focus returning to the trigger —
 * is Radix's, not this file's; what stays here is the app's shape: a flat `options` array with an icon
 * per entry, an accessible name taken from `label`, and the `line`/`default` trigger variants. That
 * shape is also the plugin ABI: `SelectMenu` is handed to bundles through
 * `window.ElowenUiRuntime.components`, so its props are a published contract and did not change with
 * the port.
 */
export function SelectMenu<T extends string>({ id, value, onChange, options, label, variant = 'default', className = '' }: {
  id?: string;
  value: T;
  onChange: (value: T) => void;
  options: SelectMenuOption<T>[];
  label: string;
  variant?: 'default' | 'line';
  className?: string;
}) {
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger id={id} aria-label={label} variant={variant} className={className}>
        {selected?.icon ? <span className="flex shrink-0 text-primary" aria-hidden>{selected.icon}</span> : null}
        <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? ''}</span>
      </SelectTrigger>
      <SelectContent aria-label={label}>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            icon={option.icon ? <span className="flex shrink-0 text-muted-foreground" aria-hidden>{option.icon}</span> : null}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
