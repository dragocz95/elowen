'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Languages } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import type { Locale } from '../../lib/i18n/dictionaries';

// Language names always render in their own language, independent of the active UI locale.
const LANGS: { value: Locale; name: string }[] = [
  { value: 'en', name: 'English' },
  { value: 'cs', name: 'Čeština' },
  { value: 'sk', name: 'Slovenčina' },
];

/**
 * Accessible language dropdown. Opens on click, closes on outside click or Esc, and is
 * keyboard-navigable (Arrow/Home/End move the active option, Enter selects). Selection persists via
 * the i18n store.
 *
 * `collapsed` narrows the BUTTON to a bare icon (the top bar drops the locale label on small
 * screens); it deliberately does not move the menu. The menu always drops below the button and is
 * right-aligned to it, because the only mount point is the top bar — an earlier variant opened the
 * collapsed menu sideways and bottom-aligned, which put it off-screen on a phone and made the
 * language unreachable there.
 */
export function LanguageSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { locale, setLocale, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback(() => { setOpen(false); btnRef.current?.focus(); }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Move DOM focus onto the active option so keyboard users land inside the menu when it opens.
  useEffect(() => { if (open) itemRefs.current[active]?.focus(); }, [open, active]);

  const openMenu = () => {
    const i = LANGS.findIndex((l) => l.value === locale);
    setActive(i < 0 ? 0 : i);
    setOpen(true);
  };

  const choose = (l: Locale) => { setLocale(l); setOpen(false); btnRef.current?.focus(); };

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % LANGS.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + LANGS.length) % LANGS.length); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(LANGS.length - 1); }
  };

  const currentName = LANGS.find((l) => l.value === locale)?.name ?? locale.toUpperCase();

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t.common.language}: ${currentName}`}
        title={`${t.common.language}: ${currentName}`}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={collapsed
          ? 'flex h-7 w-7 items-center justify-center rounded-md border border-border text-text-muted transition-colors hover:border-border-strong hover:text-text'
          : 'flex h-9 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-text-muted transition-colors hover:border-border-strong hover:text-text'}
        style={{ transitionDuration: 'var(--motion-fast)' }}
      >
        <Languages size={collapsed ? 14 : 16} aria-hidden />
        {!collapsed && <span className="font-mono uppercase tracking-wide">{locale}</span>}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t.common.language}
          onKeyDown={onMenuKey}
          className="overlay-layer-menu absolute right-0 top-full mt-2 min-w-[9rem] overflow-hidden rounded-lg border border-border bg-surface py-1"
          style={{ boxShadow: 'var(--shadow-raised)' }}
        >
          {LANGS.map((l, i) => {
            const selected = l.value === locale;
            return (
              <button
                key={l.value}
                ref={(el) => { itemRefs.current[i] = el; }}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                tabIndex={-1}
                onClick={() => choose(l.value)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-elevated hover:text-text ${selected ? 'text-text' : 'text-text-muted'}`}
                style={{ transitionDuration: 'var(--motion-fast)' }}
              >
                <Check size={14} aria-hidden className={selected ? 'opacity-100' : 'opacity-0'} />
                {l.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
