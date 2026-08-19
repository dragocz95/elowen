'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Eye, EyeOff, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { ContextMenu, DIVIDER, type ContextMenuState, type MenuEntry } from '../ui/ContextMenu';
import { Modal, ModalBody, ModalFooter } from '../ui/Modal';
import { Button } from '../ui/Button';
import { useTranslation } from '../../lib/i18n';
import { useSaveMyNavSettings } from '../../lib/mutations';
import { EMPTY_NAV_LAYOUT, applyNavLayout, moveNavEntry, setNavEntryHidden } from '../../lib/navLayout';
import type { NavLayout } from '../../lib/types';
import type { NavEntry } from './NavItem';

/** Right-click customization of the primary navigation: hide an entry, move it past its neighbour, or
 *  open the full editor. Shared by the sidebar and the orbital shell so both surfaces behave identically.
 *
 *  Only entries carrying an id can be customized — the layout addresses them by id, and an entry without
 *  one could be hidden but never brought back. */
export function useNavCustomization(allWorlds: NavEntry[], layout: NavLayout) {
  const { t } = useTranslation();
  const save = useSaveMyNavSettings();
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const entryIds = useMemo(() => allWorlds.flatMap((entry) => (entry.id ? [entry.id] : [])), [allWorlds]);
  const visible = useMemo(() => applyNavLayout(allWorlds, layout), [allWorlds, layout]);
  const hiddenCount = allWorlds.length - visible.length;

  const apply = (next: NavLayout) => save.mutate(next);

  const entryItems = (entry: NavEntry): MenuEntry[] => {
    const id = entry.id;
    if (!id) return [{ label: t.nav.customize, icon: SlidersHorizontal, onClick: () => setEditorOpen(true) }];
    const position = visible.findIndex((candidate) => candidate.id === id);
    return [
      { label: t.nav.hideEntry, icon: EyeOff, onClick: () => apply(setNavEntryHidden(layout, entryIds, id, true)) },
      { label: t.nav.moveUp, icon: ChevronUp, disabled: position <= 0, onClick: () => apply(moveNavEntry(layout, entryIds, id, -1)) },
      { label: t.nav.moveDown, icon: ChevronDown, disabled: position < 0 || position >= visible.length - 1, onClick: () => apply(moveNavEntry(layout, entryIds, id, 1)) },
      DIVIDER,
      { label: t.nav.customize, icon: SlidersHorizontal, onClick: () => setEditorOpen(true) },
    ];
  };

  const surfaceItems = (): MenuEntry[] => [
    ...(hiddenCount > 0
      ? [{ label: t.nav.hiddenCount.replace('{count}', String(hiddenCount)), icon: Eye, onClick: () => setEditorOpen(true) }, DIVIDER as typeof DIVIDER]
      : []),
    { label: t.nav.customize, icon: SlidersHorizontal, onClick: () => setEditorOpen(true) },
  ];

  return {
    /** Right-click handler for a navigation entry. */
    onEntryContextMenu: (event: React.MouseEvent, entry: NavEntry) => {
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY, items: entryItems(entry) });
    },
    /** Right-click handler for the empty area of the navigation — the way to reach hidden entries. */
    onSurfaceContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY, items: surfaceItems() });
    },
    /** Rendered by the surface that owns the navigation. */
    overlays: (
      <>
        {menu ? <ContextMenu state={menu} onClose={() => setMenu(null)} /> : null}
        {editorOpen ? (
          <NavCustomizeModal
            allWorlds={allWorlds}
            layout={layout}
            onApply={apply}
            onClose={() => setEditorOpen(false)}
          />
        ) : null}
      </>
    ),
  };
}

/** The full editor: every space in menu order, each with its visibility and its position. Deliberately not
 *  drag-and-drop — the same two buttons work with a mouse, a finger and a keyboard. */
function NavCustomizeModal({
  allWorlds,
  layout,
  onApply,
  onClose,
}: {
  allWorlds: NavEntry[];
  layout: NavLayout;
  onApply: (layout: NavLayout) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const entryIds = useMemo(() => allWorlds.flatMap((entry) => (entry.id ? [entry.id] : [])), [allWorlds]);
  const hidden = new Set(layout.hidden);
  const visible = applyNavLayout(allWorlds, layout);
  // Visible entries in menu order first, then the hidden ones — the list reads exactly like the menu it
  // edits, with everything the menu is currently leaving out gathered underneath.
  const rows = [...visible, ...allWorlds.filter((entry) => !!entry.id && hidden.has(entry.id))];

  return (
    <Modal title={t.nav.customizeTitle} description={t.nav.customizeHint} icon={SlidersHorizontal} onClose={onClose} size="md">
      <ModalBody gap={4}>
        {visible.length === 0 ? <p className="text-xs text-text-muted">{t.nav.allHidden}</p> : null}
        <ul className="flex flex-col gap-1">
          {rows.map((entry) => {
            const id = entry.id as string;
            const isHidden = hidden.has(id);
            const position = visible.findIndex((candidate) => candidate.id === id);
            const Icon = entry.icon;
            return (
              <li
                key={id}
                className={`flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2 ${isHidden ? 'opacity-55' : ''}`}
              >
                <Icon size={16} strokeWidth={1.6} className="shrink-0 text-text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm text-text">{entry.label}</span>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    aria-label={`${t.nav.moveUp}: ${entry.label}`}
                    disabled={isHidden || position <= 0}
                    onClick={() => onApply(moveNavEntry(layout, entryIds, id, -1))}
                  >
                    <ChevronUp size={14} aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`${t.nav.moveDown}: ${entry.label}`}
                    disabled={isHidden || position < 0 || position >= visible.length - 1}
                    onClick={() => onApply(moveNavEntry(layout, entryIds, id, 1))}
                  >
                    <ChevronDown size={14} aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`${isHidden ? t.nav.showEntry : t.nav.hideEntry}: ${entry.label}`}
                    onClick={() => onApply(setNavEntryHidden(layout, entryIds, id, !isHidden))}
                  >
                    {isHidden ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" icon={RotateCcw} onClick={() => onApply(EMPTY_NAV_LAYOUT)}>{t.nav.restoreDefaults}</Button>
        <Button onClick={onClose}>{t.common.close}</Button>
      </ModalFooter>
    </Modal>
  );
}
