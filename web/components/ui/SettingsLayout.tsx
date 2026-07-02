'use client';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface SettingsSection {
  id: string;
  label: string;
  icon: LucideIcon;
}

/** Settings-style page body: a sticky category sidebar on the left (VS Code / Vercel style) with the
 *  section content beside it. Below lg the sidebar folds into one horizontally scrollable pill row, so
 *  every category stays reachable on narrow screens. Keyboard/AT semantics match Segmented (radiogroup),
 *  so tests and muscle memory carry over. */
export function SettingsLayout({ sections, value, onChange, ariaLabel, children }: {
  sections: SettingsSection[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-6 lg:grid lg:grid-cols-[230px_minmax(0,1fr)] lg:items-start lg:gap-8">
      <nav
        role="radiogroup"
        aria-label={ariaLabel}
        className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto px-1 lg:sticky lg:top-20 lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0"
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
              className={`flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors lg:w-full ${
                on
                  ? 'bg-accent/12 font-medium text-accent lg:border-l-2 lg:border-accent lg:rounded-l-none'
                  : 'text-text-muted hover:bg-elevated hover:text-text lg:border-l-2 lg:border-transparent lg:rounded-l-none'
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
