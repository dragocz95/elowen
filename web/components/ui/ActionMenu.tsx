'use client';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './shadcn/dropdown-menu';

/** An item carries EITHER a Lucide `icon` component OR a pre-rendered `iconNode` (e.g. a brand
 *  <ModelIcon/> for glyphs that aren't Lucide), never both — the two are mutually exclusive so the
 *  render can't silently prefer one over the other. */
export type ActionMenuItem = {
  label: string;
  tone?: 'default' | 'danger';
  onSelect: () => void;
  /** Run only after Radix has closed the menu and restored focus to its stable trigger. Use this when the
   *  action opens another focus-owning overlay, so that overlay captures the trigger rather than a menuitem
   *  that is about to unmount. */
  onAfterClose?: () => void;
} & (
  | { icon?: LucideIcon; iconNode?: never }
  | { icon?: never; iconNode?: ReactNode }
);

/** Grace period before a hover-opened menu closes, so a pointer crossing the gap between the trigger
 *  and the panel doesn't dismiss it on the way down. */
const CLOSE_DELAY_MS = 160;

/** Where focus should land when the menu opens. Radix's own answer ("the panel, then its first item if
 *  the user is on the keyboard") is right for a click and for ArrowDown, but wrong for the other two
 *  ways this menu opens: a HOVER must not take focus away from whatever the reader was doing, and
 *  ArrowUp is the menu-button pattern's "open at the last item". */
type OpenFocus = 'none' | 'default' | 'last';

/**
 * Global hover/click action menu, composed from the shadcn/ui `DropdownMenu` parts in
 * `./shadcn/dropdown-menu.tsx`. Opens on hover (and click for touch), and stays open while the pointer
 * is over the trigger OR the menu — the panel is a DOM child of the wrapper, so moving down onto an
 * item never leaves it, and a short close delay covers the gap between the two. Default trigger is a
 * red trash icon. Reusable across destructive/contextual actions.
 *
 * The keyboard contract — roving arrows, Home/End, typeahead, Enter/Space, Escape — is Radix's, not
 * this file's. What stays here is the app's policy: hover-to-open with a grace period, ArrowUp opening
 * at the last item, and focus returning to the trigger only when the menu actually held it. `ActionMenu`
 * is handed to plugin bundles through `window.ElowenUiRuntime.components`, so its props are a published
 * contract and did not change with the port.
 */
export function ActionMenu({ items, label, trigger, triggerClassName, align = 'right', openOnHover = true }: {
  items: ActionMenuItem[];
  label?: string;
  trigger?: ReactNode;
  /** Override the trigger button styling. Defaults to the red destructive-action look. */
  triggerClassName?: string;
  align?: 'left' | 'right';
  /** `false` makes the menu click/keyboard-only. For a trigger that sits in the reading path — a row
   *  the pointer crosses on its way somewhere else — a hover-opened panel is an interruption, not help. */
  openOnHover?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openFocus = useRef<OpenFocus>('none');
  const afterClose = useRef<(() => void) | null>(null);
  // Whether closing should hand focus back to the trigger. It should when the menu owned focus — a
  // keyboard open, a selection, Escape — and must not when it was merely hovered open, or dismissed by
  // a click somewhere else, because that would steal focus from what the reader actually pressed.
  const restoreFocus = useRef(false);
  const { t } = useTranslation();
  const resolvedLabel = label ?? t.common.actions;

  const cancelClose = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);
  const openMenu = useCallback((focus: OpenFocus) => {
    cancelClose();
    openFocus.current = focus;
    restoreFocus.current = false;
    setOpen(true);
  }, [cancelClose]);
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpen(false); }, CLOSE_DELAY_MS);
  };

  useEffect(() => () => cancelClose(), [cancelClose]);

  return (
    <div
      className="relative"
      onMouseEnter={openOnHover ? () => openMenu('none') : undefined}
      onMouseLeave={openOnHover ? scheduleClose : undefined}
    >
      <DropdownMenu
        open={open}
        // Not modal: this menu opens on hover, so it must not lock the page's scroll or make the rest
        // of the document unclickable just because a pointer crossed the trigger.
        modal={false}
        onOpenChange={(next) => { cancelClose(); setOpen(next); }}
      >
        <DropdownMenuTrigger
          ref={triggerRef}
          aria-label={resolvedLabel}
          title={resolvedLabel}
          onPointerDown={() => { if (!open) openMenu('default'); }}
          // Radix opens a menu on POINTERDOWN, which a click synthesised by assistive technology or by
          // a script never produces — and this menu has always opened on click. `detail === 0` is that
          // click: a real pointer press carries a click count, so this cannot double-fire with the
          // handler above, and Enter/Space are already consumed by the keyboard branch.
          onClick={(event) => { if (event.detail === 0) (open ? setOpen(false) : openMenu('default')); }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              openMenu('last');
              return;
            }
            if (['ArrowDown', 'Enter', ' '].includes(event.key)) openMenu('default');
          }}
          className={triggerClassName ?? 'inline-flex h-8 w-8 items-center justify-center rounded-md bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/85'}
        >
          {trigger ?? <Trash2 size={15} aria-hidden />}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          ref={contentRef}
          align={align === 'right' ? 'end' : 'start'}
          onFocus={() => { restoreFocus.current = true; }}
          onInteractOutside={() => { restoreFocus.current = false; }}
          onOpenAutoFocus={(event) => {
            if (openFocus.current === 'default') return;
            // Radix would focus the panel here; a hover-opened menu must leave focus alone.
            event.preventDefault();
            if (openFocus.current !== 'last') return;
            const rows = contentRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([data-disabled])');
            rows?.[rows.length - 1]?.focus();
          }}
          onCloseAutoFocus={(event) => {
            // Radix always returns focus to the trigger; that is wrong for a menu the pointer merely
            // passed over, so the decision is made here instead.
            event.preventDefault();
            if (restoreFocus.current) triggerRef.current?.focus({ preventScroll: true });
            const next = afterClose.current;
            afterClose.current = null;
            next?.();
          }}
        >
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <DropdownMenuItem
                key={item.label}
                variant={item.tone === 'danger' ? 'destructive' : 'default'}
                onSelect={() => {
                  restoreFocus.current = true;
                  afterClose.current = item.onAfterClose ?? null;
                  item.onSelect();
                }}
              >
                {item.iconNode ?? (Icon ? <Icon size={15} aria-hidden /> : null)}
                {item.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
