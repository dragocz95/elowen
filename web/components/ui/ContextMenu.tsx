'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { uiZoom } from '../../lib/uiZoom';
import { MenuSurface } from './MenuSurface';

/** A clickable action row. */
interface MenuAction { label: string; icon?: LucideIcon; onClick: () => void; danger?: boolean; disabled?: boolean }
/** A row that expands a nested panel of its own entries on hover/click. */
interface MenuSubmenu { label: string; icon?: LucideIcon; disabled?: boolean; items: MenuEntry[] }
/** A divider between groups. */
export const DIVIDER = 'divider' as const;
export type MenuEntry = MenuAction | MenuSubmenu | typeof DIVIDER;

export interface ContextMenuState { x: number; y: number; items: MenuEntry[] }

function isSubmenu(e: MenuEntry): e is MenuSubmenu { return e !== DIVIDER && 'items' in e; }

/** A floating right-click menu (OLED styled) with optional one-level-deep submenus. Closes on outside
 *  click, Esc, scroll/resize, or after a leaf item runs. The root position is clamped to the viewport;
 *  each submenu flips left/up when it would overflow. Shared across the file tree and the task list. */
export function ContextMenu({ state, onClose }: { state: ContextMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // state.x/y are MouseEvent.clientX/Y from the right-click — zoomed (visual) viewport coords. This menu
  // is fixed-positioned inside the UI-scale `zoom`, so divide by z (and the rect width/height likewise)
  // or it lands away from the cursor at any scale ≠ 100%. uiZoom() is 1 at normal scale (no-op).
  const [pos, setPos] = useState(() => { const z = uiZoom(); return { x: state.x / z, y: state.y / z }; });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const z = uiZoom();
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.min(state.x / z, window.innerWidth / z - width / z - 8),
      y: Math.min(state.y / z, window.innerHeight / z - height / z - 8),
    });
  }, [state.x, state.y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    // Defer the outside-click listener a tick so the opening right-click doesn't instantly close it.
    const id = window.setTimeout(() => window.addEventListener('mousedown', close), 0);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => { window.clearTimeout(id); window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey); window.removeEventListener('resize', close); };
  }, [onClose]);

  return createPortal(
    <MenuSurface
      ref={ref}
      onDismiss={() => onClose()}
      onMouseDown={(e) => e.stopPropagation()}
      className="overlay-layer-menu fixed min-w-44 rounded-lg border border-border bg-elevated py-1 text-xs text-text"
      style={{ left: pos.x, top: pos.y, boxShadow: 'var(--shadow-card)' }}
    >
      {state.items.map((item, i) => <MenuRow key={i} entry={item} index={i} onClose={onClose} />)}
    </MenuSurface>,
    document.body,
  );
}

/** One row of a menu panel: a divider, a leaf action, or a submenu that expands a nested panel. */
function MenuRow({ entry, index, onClose }: { entry: MenuEntry; index: number; onClose: () => void }) {
  if (entry === DIVIDER) return <div className="my-1 h-px bg-border" aria-hidden />;
  if (isSubmenu(entry)) return <SubmenuRow entry={entry} onClose={onClose} />;
  const Icon = entry.icon;
  return (
    <button
      key={entry.label}
      type="button"
      role="menuitem"
      data-index={index}
      disabled={entry.disabled}
      onClick={() => { entry.onClick(); onClose(); }}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${entry.danger ? 'text-danger hover:bg-danger/10' : 'hover:bg-surface'}`}
    >
      {Icon ? <Icon size={13} className="shrink-0" aria-hidden /> : <span className="w-[13px]" aria-hidden />}
      <span className="truncate">{entry.label}</span>
    </button>
  );
}

/** A submenu row: hovering (or clicking, for touch) expands a nested panel of its items. The panel
 *  opens to the right by default and flips left/up when it would spill past the viewport edge. */
function SubmenuRow({ entry, onClose }: { entry: MenuSubmenu; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const [flipLeft, setFlipLeft] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const Icon = entry.icon;

  useLayoutEffect(() => {
    if (!open || !panelRef.current || !rowRef.current) return;
    const row = rowRef.current.getBoundingClientRect();
    const panel = panelRef.current.getBoundingClientRect();
    setFlipLeft(row.right + panel.width > window.innerWidth - 4);
    setFlipUp(row.top + panel.height > window.innerHeight - 4);
  }, [open]);

  return (
    <div
      ref={rowRef}
      className="relative"
      onMouseEnter={() => !entry.disabled && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={entry.disabled}
        onClick={() => !entry.disabled && setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40"
      >
        {Icon ? <Icon size={13} className="shrink-0" aria-hidden /> : <span className="w-[13px]" aria-hidden />}
        <span className="flex-1 truncate">{entry.label}</span>
        <ChevronRight size={13} className="shrink-0 text-text-muted" aria-hidden />
      </button>
      {open && !entry.disabled ? (
        <div
          ref={panelRef}
          role="menu"
          className="absolute z-10 min-w-44 max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-elevated py-1"
          style={{ [flipLeft ? 'right' : 'left']: '100%', [flipUp ? 'bottom' : 'top']: 0, boxShadow: 'var(--shadow-card)' }}
        >
          {entry.items.map((item, i) => <MenuRow key={i} entry={item} index={i} onClose={onClose} />)}
        </div>
      ) : null}
    </div>
  );
}
