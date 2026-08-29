'use client';
import { Palette } from 'lucide-react';
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
export function SkinSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation();
  const { choice, allowed, cycle } = useSkin();

  if (allowed.length < 2) return null;

  const name = skinDisplayName(t, choice);
  const label = `${t.common.skin}: ${name}`;

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={label}
      title={`${label} — ${t.common.skinCycle}`}
      className="skin-switcher__button flex h-9 items-center gap-1.5 rounded-full px-2.5 text-text-muted transition-colors hover:bg-elevated hover:text-text"
    >
      <Palette size={17} aria-hidden />
      {/* The name is the only way to tell two dark skins apart at a glance, so it stays visible wherever
          there is room. `collapsed` is the narrow rail, where the icon carries it and the title attribute
          and aria-label still say which skin is on. */}
      {collapsed ? null : <span className="skin-switcher__name hidden text-[11px] font-medium uppercase tracking-wide lg:inline">{name}</span>}
    </button>
  );
}
