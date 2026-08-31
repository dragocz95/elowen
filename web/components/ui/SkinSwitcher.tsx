'use client';
import { Moon, Sun } from 'lucide-react';
import { useSkin } from '../../lib/skinContext';
import { skinDisplayName } from '../../lib/skins';
import { useTranslation } from '../../lib/i18n';

/** Cycles the interface through the skins the instance allows. Deliberately a single button and not a
 *  menu, unlike the language switcher beside it: a skin is judged by looking at it, so the fastest way to
 *  compare two is to flip between them, and a dropdown puts a list of names in the way of that. The names
 *  are still visible — the admin list in Settings is where they are chosen.
 *
 *  Renders NOTHING when fewer than two choices are allowed. A control with one option is not a choice, and
 *  an instance that has not enabled switching should look exactly as it did before this existed. */
export function SkinSwitcher({ collapsed = false, placement = 'topbar' }: { collapsed?: boolean; placement?: 'topbar' | 'drawer' }) {
  const { t } = useTranslation();
  const { choice, allowed, cycle } = useSkin();

  if (allowed.length < 2) return null;

  const name = skinDisplayName(t, choice);
  const label = `${t.common.skin}: ${name}`;
  const Icon = choice === 'studio-oled' ? Moon : Sun;

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={label}
      title={`${label} — ${t.common.skinCycle}`}
      className={`skin-switcher__button flex h-9 items-center gap-1.5 rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground ${collapsed ? 'min-h-[var(--touch-target)] min-w-[var(--touch-target)] justify-center px-0' : 'px-2.5'}`}
    >
      <Icon size={18} strokeWidth={1.5} aria-hidden />
      {/* The name is the only way to tell two dark skins apart at a glance. A top bar may hide it until
          there is room; the drawer explicitly owns a labelled row and must not inherit that viewport rule.
          `collapsed` is the icon-only top-bar form, where the title and aria-label still name the skin. */}
      {collapsed ? null : (
        <span className={`skin-switcher__name text-[11px] font-medium uppercase tracking-wide ${placement === 'drawer' ? '' : 'hidden lg:inline'}`}>
          {name}
        </span>
      )}
    </button>
  );
}
