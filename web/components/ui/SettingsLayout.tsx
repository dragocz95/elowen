'use client';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface SettingsSection {
  id: string;
  label: string;
  icon: LucideIcon;
}

/** Settings-style page body: one horizontally scrollable pill row of categories on top, with the
 *  section content below — the same nav at every width, so every category stays reachable.
 *  Keyboard/AT semantics match Segmented (radiogroup), so tests and muscle memory carry over. */
export function SettingsLayout({ sections, value, onChange, ariaLabel, children }: {
  sections: SettingsSection[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <nav
        role="radiogroup"
        aria-label={ariaLabel}
        className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto px-1"
      >
        {sections.map(({ id, label, icon: Icon }) => {
          const on = id === value;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(id)}
              className={`flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors ${
                on ? 'bg-accent/12 font-medium text-accent' : 'text-text-muted hover:bg-elevated hover:text-text'
              }`}
              style={{ transitionDuration: 'var(--motion-fast)' }}
            >
              <Icon size={16} aria-hidden className="shrink-0" />
              {label}
            </button>
          );
        })}
      </nav>
      <div className="flex min-w-0 flex-col gap-6">{children}</div>
    </div>
  );
}
