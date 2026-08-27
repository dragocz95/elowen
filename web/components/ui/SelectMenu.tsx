'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectMenuOption<T extends string = string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

/**
 * Shared single-choice dropdown. Unlike a native select, the popup stays inside Elowen's visual system,
 * can carry meaningful icons, and implements the expected listbox keyboard controls.
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
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const typeaheadRef = useRef({ text: '', timer: 0 });
  const listId = useId();
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, open]);

  useEffect(() => () => window.clearTimeout(typeaheadRef.current.timer), []);

  const openAt = (index: number) => {
    if (!options.length) return;
    setActiveIndex(Math.min(Math.max(index, 0), options.length - 1));
    setOpen(true);
  };
  const move = (index: number) => {
    if (!options.length) return;
    setActiveIndex((index + options.length) % options.length);
  };
  const choose = (next: T) => {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };
  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); openAt(open ? activeIndex + 1 : selectedIndex); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); openAt(open ? activeIndex - 1 : selectedIndex); }
    else if (event.key === 'Home') { event.preventDefault(); openAt(0); }
    else if (event.key === 'End') { event.preventDefault(); openAt(options.length - 1); }
  };
  const onOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(index + 1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); move(index - 1); return; }
    if (event.key === 'Home') { event.preventDefault(); move(0); return; }
    if (event.key === 'End') { event.preventDefault(); move(options.length - 1); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(options[index]!.value); return; }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    const text = `${typeaheadRef.current.text}${event.key}`.toLocaleLowerCase();
    window.clearTimeout(typeaheadRef.current.timer);
    typeaheadRef.current = {
      text,
      timer: window.setTimeout(() => { typeaheadRef.current.text = ''; }, 500),
    };
    const ordered = [...options.keys()].map((offset) => (index + 1 + offset) % options.length);
    const match = ordered.find((candidate) => options[candidate]!.label.toLocaleLowerCase().startsWith(text));
    if (match !== undefined) move(match);
  };

  return (
    <div ref={rootRef} className={`relative min-w-0 ${className}`}>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={label}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-expanded={open}
        onKeyDown={onTriggerKeyDown}
        onClick={() => open ? setOpen(false) : openAt(selectedIndex)}
        className={`flex h-9 w-full min-w-0 items-center gap-2 text-sm transition-[border-color,background-color,box-shadow] ${variant === 'line'
          ? `border-b px-1 ${open ? 'border-accent text-accent' : 'border-border bg-transparent text-text hover:border-border-strong'}`
          : `rounded-md border px-3 ${open ? 'border-accent/60 bg-accent/10 text-accent shadow-[0_0_0_3px_rgb(255_82_54_/_0.08)]' : 'border-border bg-surface text-text hover:border-border-strong hover:bg-elevated'}`}`}
      >
        {selected?.icon ? <span className="flex shrink-0 text-accent" aria-hidden>{selected.icon}</span> : null}
        <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? ''}</span>
        <ChevronDown size={13} className={`shrink-0 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {open ? (
        <div id={listId} role="listbox" aria-label={label} className="overlay-layer-menu absolute left-0 top-full mt-2 w-max min-w-full max-w-80 origin-top-left animate-fade-up rounded-xl border border-border bg-surface p-1.5 shadow-[var(--shadow-raised)]">
          {options.map((option, index) => {
            const active = option.value === value;
            return (
              <button
                id={`${listId}-option-${index}`}
                key={option.value}
                ref={(node) => { optionRefs.current[index] = node; }}
                type="button"
                role="option"
                aria-selected={active}
                tabIndex={index === activeIndex ? 0 : -1}
                onFocus={() => setActiveIndex(index)}
                onKeyDown={(event) => onOptionKeyDown(event, index)}
                onClick={() => choose(option.value)}
                className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${active ? 'bg-accent/10 text-accent' : 'text-text hover:bg-elevated'}`}
              >
                {option.icon ? <span className={`flex shrink-0 ${active ? 'text-accent' : 'text-text-muted'}`} aria-hidden>{option.icon}</span> : null}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {active ? <Check size={15} className="shrink-0 text-accent" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
