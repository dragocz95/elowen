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
 * Single-icon theme control for the sidebar footer. Shows the icon of the active mode and cycles
 * Light → Dark → System on each click, reading/writing the shared `useTheme` store (persisted to
 * localStorage, applied via `data-theme`). One compact button in both the expanded footer row and
 * the collapsed rail.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();

  const label = (v: Theme) => (v === 'light' ? t.common.themeLight : v === 'dark' ? t.common.themeDark : t.common.themeSystem);

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
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-text-muted transition-colors hover:border-border-strong hover:text-text"
      style={{ transitionDuration: 'var(--motion-fast)' }}
    >
      <Icon size={14} aria-hidden />
    </button>
  );
}
