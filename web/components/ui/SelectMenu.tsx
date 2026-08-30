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
export function SelectMenu<T extends string>({ id, value, onChange, options, label, variant = 'default', disabled = false, invalid = false, className = '' }: {
  id?: string;
  value: T;
  onChange: (value: T) => void;
  options: SelectMenuOption<T>[];
  label: string;
  variant?: 'default' | 'line';
  /** Locks the control while a mutation is in flight. Callers were already passing this — the msteams
   *  account picker among them — and it was silently dropped, leaving the select interactive during the
   *  save it had just triggered. */
  disabled?: boolean;
  /** Marks the current value as rejected. Surfaces as `aria-invalid`, which the trigger styles the same
   *  way `Input` does, so a bad select and a bad text field read alike. */
  invalid?: boolean;
  className?: string;
}) {
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    // The caller's className sizes the CONTROL, not the trigger. The trigger is `w-full` — that is
    // shadcn's shape and is what makes it fill whatever box it is given — so putting the caller's class
    // on it directly turns the trigger itself into the sized box: dropped into a flex toolbar it then
    // claims the whole line and pushes every sibling filter onto rows of its own. The wrapper is what
    // the pre-port component had, and restoring it keeps `min-w-[9.5rem]` in a toolbar and full width
    // in a form behaving exactly as they did.
    <div className={`min-w-0${className ? ` ${className}` : ''}`}>
    <Select value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label} variant={variant} aria-invalid={invalid || undefined}>
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
    </div>
  );
}
