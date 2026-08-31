'use client';
import { Languages } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import type { Locale } from '../../lib/i18n/dictionaries';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './shadcn/dropdown-menu';

// Language names always render in their own language, independent of the active UI locale.
const LANGS: { value: Locale; name: string }[] = [
  { value: 'en', name: 'English' },
  { value: 'cs', name: 'Čeština' },
  { value: 'sk', name: 'Slovenčina' },
];

/**
 * Accessible single-choice language menu. Radix owns menu focus, keyboard navigation, outside-press and
 * Escape dismissal, focus restoration and collision-aware placement; selection persists via the i18n
 * store.
 *
 * `collapsed` narrows the button to a bare icon (the top bar drops the locale label on small screens).
 * The menu still prefers below and stays end-aligned to that button so it remains reachable on phones.
 */
export function LanguageSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { locale, setLocale, t } = useTranslation();
  const currentName = LANGS.find((language) => language.value === locale)?.name ?? locale.toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${t.common.language}: ${currentName}`}
          title={`${t.common.language}: ${currentName}`}
          className={collapsed
            ? 'flex h-7 w-7 min-h-[var(--touch-target)] min-w-[var(--touch-target)] items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            : 'flex h-9 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'}
          style={{ transitionDuration: 'var(--motion-fast)' }}
        >
          <Languages size={collapsed ? 16 : 18} strokeWidth={1.5} aria-hidden />
          {!collapsed && <span className="language-switcher__name font-mono uppercase tracking-wide">{locale}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label={t.common.language} align="end" sideOffset={8} className="min-w-36">
        <DropdownMenuRadioGroup value={locale} onValueChange={(value) => setLocale(value as Locale)}>
          {LANGS.map((language) => (
            <DropdownMenuRadioItem
              key={language.value}
              value={language.value}
              className="text-muted-foreground data-[state=checked]:text-foreground"
            >
              {language.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
