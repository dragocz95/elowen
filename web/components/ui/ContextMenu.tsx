'use client';
import { useLayoutEffect, useRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ContextMenu as ContextMenuRoot,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from './shadcn/context-menu';

/** A clickable action row. */
interface MenuAction { label: string; icon?: LucideIcon; onClick: () => void; danger?: boolean; disabled?: boolean }
/** A row that expands a nested panel of its own entries on hover/click. */
interface MenuSubmenu { label: string; icon?: LucideIcon; disabled?: boolean; items: MenuEntry[] }
/** A divider between groups. */
export const DIVIDER = 'divider' as const;
export type MenuEntry = MenuAction | MenuSubmenu | typeof DIVIDER;

export interface ContextMenuState { x: number; y: number; items: MenuEntry[] }

function isSubmenu(e: MenuEntry): e is MenuSubmenu { return e !== DIVIDER && 'items' in e; }

/** A floating right-click menu with optional submenus, composed from the shadcn/ui `ContextMenu` parts
 *  in `./shadcn/context-menu.tsx`. Closes on outside click, Esc, or after a leaf item runs. Placement is
 *  clamped to the viewport and each submenu flips left/up when it would overflow — all of that is Radix's
 *  collision handling now, not hand-measured here. Shared across the file tree and the task list.
 *
 *  The public shape is unchanged and is deliberately positional: a call site owns the open state and
 *  hands over the coordinates of the right-click that produced it. Radix's ContextMenu anchors to a
 *  `contextmenu` EVENT rather than to coordinates, so the bridge between the two is the hidden trigger
 *  below: mounting this component replays the right-click on it at the requested point, which is exactly
 *  the input Radix expects and what makes its virtual anchor land under the cursor. Doing it this way
 *  means the zoom compensation this file used to carry is gone on purpose — Floating UI reads the
 *  ancestor scale itself, so the arithmetic no longer belongs here. */
export function ContextMenu({ state, onClose }: { state: ContextMenuState; onClose: () => void }) {
  const triggerRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    triggerRef.current?.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: state.x,
      clientY: state.y,
    }));
  }, [state.x, state.y]);

  return (
    <ContextMenuRoot
      // Not modal: this menu is opened from inside dialogs that already own the page's scroll lock and
      // background isolation, and a second lock fighting the first is how a dialog ends up unscrollable
      // after a right-click. Outside presses still dismiss it.
      modal={false}
      onOpenChange={(open) => { if (!open) onClose(); }}
    >
      <ContextMenuTrigger ref={triggerRef} className="hidden" aria-hidden />
      <ContextMenuContent>
        {state.items.map((item, i) => <MenuRow key={i} entry={item} index={i} />)}
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}

/** One row of a menu panel: a divider, a leaf action, or a submenu that expands a nested panel.
 *  Selecting a leaf closes the whole menu — Radix does that, which is what reaches `onClose`. */
function MenuRow({ entry, index }: { entry: MenuEntry; index: number }) {
  if (entry === DIVIDER) return <ContextMenuSeparator />;
  if (isSubmenu(entry)) return <SubmenuRow entry={entry} />;
  const Icon = entry.icon;
  return (
    <ContextMenuItem
      data-index={index}
      disabled={entry.disabled}
      variant={entry.danger ? 'destructive' : 'default'}
      onSelect={() => entry.onClick()}
    >
      {Icon ? <Icon size={13} aria-hidden /> : <span className="w-[13px]" aria-hidden />}
      <span className="truncate">{entry.label}</span>
    </ContextMenuItem>
  );
}

/** A submenu row: hovering (or clicking, for touch) expands a nested panel of its items. */
function SubmenuRow({ entry }: { entry: MenuSubmenu }) {
  const Icon = entry.icon;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger disabled={entry.disabled}>
        {Icon ? <Icon size={13} aria-hidden /> : <span className="w-[13px]" aria-hidden />}
        <span className="flex-1 truncate">{entry.label}</span>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {entry.items.map((item, i) => <MenuRow key={i} entry={item} index={i} />)}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
