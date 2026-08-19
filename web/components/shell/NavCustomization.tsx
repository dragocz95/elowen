'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Eye, EyeOff, GripVertical, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { ContextMenu, DIVIDER, type ContextMenuState, type MenuEntry } from '../ui/ContextMenu';
import { Modal, ModalBody, ModalFooter } from '../ui/Modal';
import { Button } from '../ui/Button';
import { useTranslation } from '../../lib/i18n';
import { useSaveMyNavSettings } from '../../lib/mutations';
import { EMPTY_NAV_LAYOUT, applyNavLayout, moveNavEntry, reorderNavEntry, setNavEntryHidden } from '../../lib/navLayout';
import type { NavLayout } from '../../lib/types';
import type { NavEntry } from './NavItem';

/** Right-click customization of the primary navigation: hide an entry, move it past its neighbour, or
 *  open the full editor. Shared by the sidebar and the orbital shell so both surfaces behave identically.
 *
 *  Only entries carrying an id can be customized — the layout addresses them by id, and an entry without
 *  one could be hidden but never brought back. */
export function useNavCustomization(allWorlds: NavEntry[], layout: NavLayout, displayOrder?: string[]) {
  const { t } = useTranslation();
  const save = useSaveMyNavSettings();
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

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
  const hiddenCount = allWorlds.length - visible.length;

  const apply = (next: NavLayout) => save.mutate(next);

  const entryItems = (entry: NavEntry): MenuEntry[] => {
    const id = entry.id;
    if (!id) return [{ label: t.nav.customize, icon: SlidersHorizontal, onClick: () => setEditorOpen(true) }];
    const position = visible.findIndex((candidate) => candidate.id === id);
    return [
      { label: t.nav.hideEntry, icon: EyeOff, onClick: () => apply(setNavEntryHidden(layout, id, true)) },
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
            orderSeed={entryIds}
            onApply={apply}
            onClose={() => setEditorOpen(false)}
          />
        ) : null}
      </>
    ),
  };
}

/** What a row is doing while the pointer holds it: where it started, where it would land, and how far the
 *  pointer has travelled — everything the list needs to render the drag without committing anything. */
type NavDrag = { id: string; from: number; to: number; dy: number; startY: number; step: number };

/** The full editor: every space in menu order, each with its visibility and its position.
 *
 *  Reordering is a drag, because "hold the thing and put it where you want it" is what the gesture means
 *  and the row follows the pointer to say so. The arrow buttons stay next to it — they are the only way
 *  to reorder from a keyboard, and dropping them would trade one group of users for another. */
function NavCustomizeModal({
  allWorlds,
  layout,
  orderSeed,
  onApply,
  onClose,
}: {
  allWorlds: NavEntry[];
  layout: NavLayout;
  orderSeed: string[];
  onApply: (layout: NavLayout) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const hidden = new Set(layout.hidden);
  const visible = applyNavLayout(allWorlds, layout);
  // Visible entries in menu order first, then the hidden ones — the list reads exactly like the menu it
  // edits, with everything the menu is currently leaving out gathered underneath.
  const rows = [...visible, ...allWorlds.filter((entry) => !!entry.id && hidden.has(entry.id))];
  const [drag, setDrag] = useState<NavDrag | null>(null);

  const beginDrag = (event: React.PointerEvent<HTMLElement>, id: string, from: number) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const row = event.currentTarget.closest('li');
    if (!row) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // One row plus the gap between rows: the distance the pointer must cover to displace a neighbour.
    const step = row.getBoundingClientRect().height + 4;
    setDrag({ id, from, to: from, dy: 0, startY: event.clientY, step });
  };

  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (!drag) return;
    const dy = event.clientY - drag.startY;
    const to = Math.max(0, Math.min(visible.length - 1, drag.from + Math.round(dy / drag.step)));
    if (dy !== drag.dy || to !== drag.to) setDrag({ ...drag, dy, to });
  };

  const endDrag = () => {
    if (!drag) return;
    if (drag.to !== drag.from) onApply(reorderNavEntry(layout, orderSeed, drag.id, drag.to));
    setDrag(null);
  };

  /** How far a row that is NOT being dragged has to step aside to open the gap the dragged one will fill. */
  const shiftOf = (index: number, isHidden: boolean) => {
    if (!drag || isHidden || index === drag.from) return 0;
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -drag.step;
    if (drag.from > drag.to && index < drag.from && index >= drag.to) return drag.step;
    return 0;
  };

  return (
    <Modal title={t.nav.customizeTitle} description={t.nav.customizeHint} icon={SlidersHorizontal} onClose={onClose} size="md">
      <ModalBody gap={4}>
        {visible.length === 0 ? <p className="text-xs text-text-muted">{t.nav.allHidden}</p> : null}
        <ul className="flex flex-col gap-1">
          {rows.map((entry, index) => {
            const id = entry.id as string;
            const isHidden = hidden.has(id);
            const position = visible.findIndex((candidate) => candidate.id === id);
            const Icon = entry.icon;
            const dragging = drag?.id === id;
            const shift = shiftOf(index, isHidden);
            return (
              <li
                key={id}
                data-dragging={dragging || undefined}
                className={`flex items-center gap-3 rounded-lg border bg-surface px-3 py-2 ${isHidden ? 'opacity-55' : ''} ${dragging
                  ? 'relative z-10 border-accent/70 shadow-lg shadow-black/40'
                  : `border-border/60 ${drag ? '' : 'transition-transform duration-150'}`}`}
                style={dragging
                  ? { transform: `translateY(${drag.dy}px) scale(1.02)` }
                  : shift !== 0 ? { transform: `translateY(${shift}px)` } : undefined}
              >
                {/* The handle owns the gesture rather than the whole row, so a drag can never be mistaken
                    for a press of one of the buttons on the right. */}
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={`${t.nav.reorderEntry}: ${entry.label}`}
                  onPointerDown={isHidden ? undefined : (event) => beginDrag(event, id, index)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  className={`-ml-1 shrink-0 touch-none p-1 text-text-muted ${isHidden
                    ? 'cursor-not-allowed opacity-40'
                    : dragging ? 'cursor-grabbing text-text' : 'cursor-grab hover:text-text'}`}
                >
                  <GripVertical size={14} aria-hidden />
                </span>
                <Icon size={16} strokeWidth={1.6} className="shrink-0 text-text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm text-text">{entry.label}</span>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    aria-label={`${t.nav.moveUp}: ${entry.label}`}
                    disabled={isHidden || position <= 0}
                    onClick={() => onApply(moveNavEntry(layout, orderSeed, id, -1))}
                  >
                    <ChevronUp size={14} aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`${t.nav.moveDown}: ${entry.label}`}
                    disabled={isHidden || position < 0 || position >= visible.length - 1}
                    onClick={() => onApply(moveNavEntry(layout, orderSeed, id, 1))}
                  >
                    <ChevronDown size={14} aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`${isHidden ? t.nav.showEntry : t.nav.hideEntry}: ${entry.label}`}
                    onClick={() => onApply(setNavEntryHidden(layout, id, !isHidden))}
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
