'use client';
import { Sun, Moon, Monitor, type LucideIcon } from 'lucide-react';
import { useTheme, type Theme } from '../../lib/useTheme';
import { useTranslation } from '../../lib/i18n';

const OPTIONS: { value: Theme; icon: LucideIcon }[] = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
];

/**
 * Light / Dark / System theme control for the sidebar footer. Reads and writes the shared
 * `useTheme` store (persisted to localStorage, applied via `data-theme`). Expanded shows an
 * icon-only segmented radiogroup styled to match the footer's bordered controls; the collapsed
 * rail shows a single button that cycles through the three modes to stay compact.
 */
export function ThemeToggle({ collapsed = false }: { collapsed?: boolean }) {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();

  const label = (v: Theme) => (v === 'light' ? t.common.themeLight : v === 'dark' ? t.common.themeDark : t.common.themeSystem);

  if (collapsed) {
    const idx = OPTIONS.findIndex((o) => o.value === theme);
    const current = OPTIONS[idx] ?? OPTIONS[2];
    const Icon = current.icon;
    const next = OPTIONS[(idx + 1) % OPTIONS.length].value;
    return (
      <button
        type="button"
        onClick={() => setTheme(next)}
        aria-label={`${t.common.theme}: ${label(theme)}`}
        title={`${t.common.theme}: ${label(theme)}`}
        className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-text-muted transition-colors hover:border-border-strong hover:text-text"
        style={{ transitionDuration: 'var(--motion-fast)' }}
      >
        <Icon size={14} aria-hidden />
      </button>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label={t.common.theme}
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5"
    >
      {OPTIONS.map((o) => {
        const Icon = o.icon;
        const active = o.value === theme;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label(o.value)}
            title={label(o.value)}
            onClick={() => setTheme(o.value)}
            className={`inline-flex h-6 w-7 items-center justify-center rounded transition-colors ${active ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-elevated hover:text-text'}`}
            style={{ transitionDuration: 'var(--motion-fast)' }}
          >
            <Icon size={14} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
