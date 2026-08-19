'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Eye, EyeOff, RotateCcw } from 'lucide-react';
import { ContextMenu, DIVIDER, type ContextMenuState, type MenuEntry } from '../ui/ContextMenu';
import { useTranslation } from '../../lib/i18n';
import { useSaveMyNavSettings } from '../../lib/mutations';
import { EMPTY_NAV_LAYOUT, applyNavLayout, hiddenNavEntries, moveNavEntry, reorderNavEntry, setNavEntryHidden } from '../../lib/navLayout';
import type { NavLayout } from '../../lib/types';
import type { NavEntry } from './navEntry';

/** Arranging the menu happens IN the menu. An entry is moved by dragging it where it belongs, hidden
 *  from its own right-click (or long-press) menu, and brought back from that same menu on empty space.
 *
 *  There is deliberately no editor dialog and no settings page: a menu that needs a second surface to
 *  arrange it is one surface too many, and the arrangement is easiest to judge in the place it applies.
 *
 *  Only entries carrying an id can be customized — the layout addresses them by id, and an entry without
 *  one could be hidden but never brought back. */
export function useNavCustomization(allWorlds: NavEntry[], layout: NavLayout, displayOrder?: string[]) {
  const { t } = useTranslation();
  const save = useSaveMyNavSettings();
  const qc = useQueryClient();
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  // The stored order starts out empty, so the first edit has to seed it — and it must seed it with the
  // sequence the user is looking at. Seeding from the registry instead would silently rearrange a menu
  // whose surface sorts differently (the rail arranges by its spatial axis), which reads as the menu
  // reshuffling itself the moment you touch it. `displayOrder` is that surface's own sequence.
  const entryIds = useMemo(() => {
    const known = new Set(allWorlds.flatMap((entry) => (entry.id ? [entry.id] : [])));
    const shown = (displayOrder ?? []).filter((id) => known.has(id));
    const seen = new Set(shown);
    return [...shown, ...[...known].filter((id) => !seen.has(id))];
  }, [allWorlds, displayOrder]);
  const visible = useMemo(() => applyNavLayout(allWorlds, layout), [allWorlds, layout]);
  const hidden = useMemo(() => hiddenNavEntries(allWorlds, layout), [allWorlds, layout]);

  // Every edit is computed from the layout the LAST edit produced, not from the one this render was
  // built with. Two quick edits — hide something, then immediately move something else — would
  // otherwise both start from the same base and the second would undo the first.
  const apply = (compute: (current: NavLayout) => NavLayout) => {
    const next = compute(qc.getQueryData<NavLayout>(['my-nav-settings']) ?? layout);
    qc.setQueryData(['my-nav-settings'], next);
    save.mutate(next);
  };

  /** The hidden spaces, each one click from coming back. This is the ONLY way back, so it hangs off
   *  every menu the navigation opens rather than only off empty space. */
  const hiddenGroup = (): MenuEntry[] => (hidden.length === 0 ? [] : [
    {
      label: t.nav.hiddenCount.replace('{count}', String(hidden.length)),
      icon: Eye,
      items: hidden.map((entry) => ({
        label: entry.label,
        icon: entry.icon,
        onClick: () => apply((current) => setNavEntryHidden(current, entry.id as string, false)),
      })),
    },
    DIVIDER,
  ]);

  const restoreItem = (): MenuEntry => ({
    label: t.nav.restoreDefaults,
    icon: RotateCcw,
    disabled: layout.hidden.length === 0 && layout.order.length === 0,
    onClick: () => apply(() => EMPTY_NAV_LAYOUT),
  });

  const surfaceItems = (): MenuEntry[] => [...hiddenGroup(), restoreItem()];

  const entryItems = (entry: NavEntry): MenuEntry[] => {
    const id = entry.id;
    if (!id) return surfaceItems();
    const position = visible.findIndex((candidate) => candidate.id === id);
    // The arrows stay beside the drag: they are the only way to arrange the menu from a keyboard.
    return [
      { label: t.nav.hideEntry, icon: EyeOff, onClick: () => apply((current) => setNavEntryHidden(current, id, true)) },
      { label: t.nav.moveUp, icon: ChevronUp, disabled: position <= 0, onClick: () => apply((current) => moveNavEntry(current, entryIds, id, -1)) },
      { label: t.nav.moveDown, icon: ChevronDown, disabled: position < 0 || position >= visible.length - 1, onClick: () => apply((current) => moveNavEntry(current, entryIds, id, 1)) },
      DIVIDER,
      ...surfaceItems(),
    ];
  };

  const openMenu = (x: number, y: number, items: MenuEntry[]) => setMenu({ x, y, items });

  return {
    /** Right-click handler for a navigation entry. */
    onEntryContextMenu: (event: React.MouseEvent, entry: NavEntry) => {
      event.preventDefault();
      event.stopPropagation();
      openMenu(event.clientX, event.clientY, entryItems(entry));
    },
    /** Right-click handler for the empty area of the navigation — the way to reach hidden entries. */
    onSurfaceContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      openMenu(event.clientX, event.clientY, surfaceItems());
    },
    /** Opens the same menu without a right-click, for a long press. Touch has no right-click, and
     *  without this the hidden spaces would be unreachable on a phone. */
    openEntryMenu: (x: number, y: number, entry: NavEntry) => openMenu(x, y, entryItems(entry)),
    /** The surface menu without a right-click — for a long press and for the keyboard. Hiding every
     *  entry leaves nothing to right-click ON, so this is the way back. */
    openSurfaceMenu: (x: number, y: number) => openMenu(x, y, surfaceItems()),
    /** Commits a drag: put `id` at `toIndex` among the entries currently on show. */
    reorderTo: (id: string, toIndex: number) => apply((current) => reorderNavEntry(current, entryIds, id, toIndex)),
    /** Rendered by the surface that owns the navigation. */
    overlays: menu ? <ContextMenu state={menu} onClose={() => setMenu(null)} /> : null,
  };
}
