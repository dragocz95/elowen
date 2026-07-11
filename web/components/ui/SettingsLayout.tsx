'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Search } from 'lucide-react';
import { Input } from './Input';
import { ElowenPresence } from '../../modules/dashboard/ElowenPresence';

export interface SettingsSection {
  id: string;
  label: string;
  icon: LucideIcon;
}

function orbitPoint(index: number, count: number): { left: string; top: string } {
  const angle = -90 + (index * 360) / Math.max(count, 1);
  return {
    left: `${50 + Math.cos((angle * Math.PI) / 180) * 43}%`,
    top: `${48 + Math.sin((angle * Math.PI) / 180) * 42}%`,
  };
}

/** Full spatial settings workspace: an independent orbital scene and a flat control surface. */
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
  const activeSection = sections.find((section) => section.id === value) ?? sections[0];
  const selectedVisible = visible.some((section) => section.id === value);
  const ActiveIcon = activeSection?.icon;

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

  return (
    <div className="spatial-settings grid min-w-0 gap-8 lg:grid-cols-[33rem_minmax(0,1fr)] xl:grid-cols-[40rem_minmax(0,1fr)]">
      <aside className="min-w-0 lg:sticky lg:top-5">
        <div className="relative mb-3 lg:hidden">
          <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder} className="h-9 pl-9 text-xs" />
        </div>

        <nav role="radiogroup" aria-label={ariaLabel} className="scrollbar-none flex gap-3 overflow-x-auto lg:relative lg:block lg:h-[25rem] lg:w-[26rem] lg:translate-x-[11rem] lg:overflow-visible">
          <div className="spatial-orbits pointer-events-none absolute inset-[2%] hidden lg:block" aria-hidden>
            <span className="absolute inset-0 rounded-[48%] border border-accent/20" />
            <span className="absolute inset-[16%] rounded-[50%] border border-accent/14" />
            <span className="absolute inset-[33%] rounded-full border border-accent/10 shadow-[0_0_42px_rgb(255_82_54_/_0.07)]" />
          </div>

          <div className="pointer-events-none absolute left-1/2 top-[48%] hidden w-[15rem] -translate-x-1/2 -translate-y-1/2 lg:block">
            <ElowenPresence state="idle" label="Elowen" />
          </div>

          {visible.map(({ id, label, icon: Icon }, index) => {
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
                className={`group z-10 flex shrink-0 items-center gap-2.5 whitespace-nowrap text-sm transition-[color,transform] lg:absolute lg:-translate-x-1/2 lg:-translate-y-1/2 ${on ? 'font-medium text-accent' : 'text-text-muted hover:text-text'}`}
                style={{ ...orbitPoint(index, visible.length), transitionDuration: 'var(--motion-fast)' }}
              >
                <span className={`grid shrink-0 place-items-center rounded-full border bg-black transition-[width,height,border-color,box-shadow] ${on ? 'h-14 w-14 border-accent shadow-[0_0_36px_rgb(255_82_54_/_0.34)]' : 'h-11 w-11 border-border-strong/80 group-hover:border-accent/45'}`}>
                  <Icon size={on ? 21 : 17} aria-hidden />
                </span>
                <span className={on ? 'text-base' : 'text-sm'}>{label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <section className="future-settings-panel min-w-0 bg-black pb-8">
        {activeSection && ActiveIcon ? (
          <header className="flex min-h-24 items-center gap-4 border-b border-border/45 px-3 py-5">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-border-strong/70 bg-[rgb(255_255_255_/_0.018)] text-text-muted">
              <ActiveIcon size={20} aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold tracking-tight text-text">{activeSection.label}</h2>
              <p className="mt-1 text-xs text-text-muted">Elowen control surface</p>
            </div>
          </header>
        ) : null}
        <div className="flex min-w-0 flex-col gap-0 px-3">{children}</div>
      </section>
    </div>
  );
}
