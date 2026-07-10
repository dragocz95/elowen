'use client';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Search } from 'lucide-react';
import { Input } from './Input';

export interface SettingsSection {
  id: string;
  label: string;
  icon: LucideIcon;
}

/** Shared settings workspace. Desktop gets a calm local sidebar and searchable sections; smaller
 *  widths keep the same sections in a horizontal rail. Search intentionally filters navigation only
 *  (the selected panel is never unmounted), so an in-progress form cannot disappear mid-edit. */
export function SettingsLayout({ sections, value, onChange, ariaLabel, searchPlaceholder = 'Search settings…', children }: {
  sections: SettingsSection[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  searchPlaceholder?: string;
  children: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? sections.filter((section) => section.label.toLocaleLowerCase().includes(needle)) : sections;
  }, [query, sections]);
  const selectedVisible = visible.some((section) => section.id === value);
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % visible.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + visible.length) % visible.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = visible.length - 1;
    const section = next == null ? undefined : visible[next];
    if (!section) return;
    event.preventDefault();
    onChange(section.id);
    buttonRefs.current[section.id]?.focus();
  };

  const buttons = visible.map(({ id, label, icon: Icon }, index) => {
    const on = id === value;
    return (
      <button
        key={id}
        type="button"
        role="radio"
        aria-checked={on}
        tabIndex={on || (!selectedVisible && index === 0) ? 0 : -1}
        ref={(node) => { buttonRefs.current[id] = node; }}
        onClick={() => onChange(id)}
        onKeyDown={(event) => move(event, index)}
        className={`group flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm transition-colors lg:w-full ${
          on ? 'bg-accent/12 font-medium text-accent' : 'text-text-muted hover:bg-elevated hover:text-text'
        }`}
        style={{ transitionDuration: 'var(--motion-fast)' }}
      >
        <Icon size={16} aria-hidden className="shrink-0" />
        <span className="truncate">{label}</span>
        {on ? <span className="ml-auto hidden h-1.5 w-1.5 rounded-full bg-accent lg:block" aria-hidden /> : null}
      </button>
    );
  });

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:items-start">
      <aside className="min-w-0 lg:sticky lg:top-5">
        <div className="relative mb-2">
          <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-9 pl-9 text-xs"
          />
        </div>
        <nav
          role="radiogroup"
          aria-label={ariaLabel}
          className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto px-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
        >
          {buttons}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-col gap-6">{children}</div>
    </div>
  );
}
