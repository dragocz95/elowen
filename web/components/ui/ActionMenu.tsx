'use client';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Trash2, type LucideIcon } from 'lucide-react';
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
 * Global action menu, composed from the shadcn/ui `DropdownMenu` parts in `./shadcn/dropdown-menu.tsx`.
 *
 * In its default `destructive` shape it opens on hover and stays open while the pointer is over the
 * trigger OR the menu — the panel is a DOM child of the wrapper, so moving down onto an item never
 * leaves it, and a short close delay covers the gap between the two. The trigger is a red trash icon.
 *
 * In the `kebab` shape it is the register's row-actions affordance: a neutral 32×32 square that opens on
 * CLICK. Hover is wrong there and not merely a preference — a register row is a thing the pointer
 * crosses on its way somewhere else, and a panel that appears under the cursor on the way past covers
 * the rows below the one being read.
 *
 * The keyboard contract — roving arrows, Home/End, typeahead, Enter/Space, Escape — is Radix's, not
 * this file's. What stays here is the app's policy: hover-to-open with a grace period, ArrowUp opening
 * at the last item, and focus returning to the trigger only when the menu actually held it. `ActionMenu`
 * is handed to plugin bundles through `window.ElowenUiRuntime.components`, so its props are a published
 * contract and did not change with the port.
 */
/** The trigger's shape.
 *
 *  `destructive` is the original: a filled red button for a menu whose whole content is one dangerous
 *  action. `kebab` is the register variant — a 32×32 neutral square with the three dots, the row-actions
 *  affordance the reference dashboard puts at the end of every row. A row is a thing to READ, and a red
 *  button in each one shouts the single action the reader is least likely to want.
 *
 *  It is an enum rather than a `triggerClassName` string because the two are a pair with `openOnHover`:
 *  a kebab in a register has to be click-only (see below), and a variant is what lets that default
 *  follow the shape instead of every register remembering to pass both. */
export type ActionMenuVariant = 'destructive' | 'kebab';

const TRIGGER_CLASS: Record<ActionMenuVariant, string> = {
  destructive: 'inline-flex h-8 w-8 items-center justify-center rounded-md bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/85',
  // 32×32, no fill at rest: quiet until the pointer is on it, then the same foreground wash every other
  // neutral control in the app hovers to. It also stays filled while its menu is open, so the row the
  // panel belongs to is obvious.
  //
  // `rounded-md` is 10px, where the reference measures 8. The app's radius scale has no 8 — it runs
  // 6/10/12/16/20 — and this file may not reach past it for a one-off literal, so the control takes the
  // nearest step and matches the panel it opens rather than introducing a sixth radius for 2px.
  kebab: 'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground',
};

export function ActionMenu({ items, label, trigger, triggerClassName, className, align = 'right', variant = 'destructive', openOnHover }: {
  items: ActionMenuItem[];
  label?: string;
  trigger?: ReactNode;
  /** Override the trigger button styling. Wins over `variant`. */
  triggerClassName?: string;
  /** Classes for the positioning wrapper — the menu's box in its parent's layout, not the trigger's skin.
   *
   *  It exists for one reason. The wrapper is `position: relative` and block-level, so a caller that puts
   *  the menu in a flex ROW gets an item whose automatic minimum size is its content's min-content width.
   *  A trigger holding nowrap text then refuses to shrink and runs past the end of the row, however
   *  carefully the trigger's own children are set to truncate. Such a caller passes `min-w-0` here. */
  className?: string;
  align?: 'left' | 'right';
  /** The trigger's shape. Defaults to the red destructive button the component shipped with, so no
   *  existing caller changes. */
  variant?: ActionMenuVariant;
  /** `false` makes the menu click/keyboard-only. For a trigger that sits in the reading path — a row the
   *  pointer crosses on its way somewhere else — a hover-opened panel is an interruption, not help.
   *
   *  Left undefined it follows the variant: a `kebab` is a register affordance and is click-only,
   *  everything else keeps the hover behaviour it has always had. A caller may still say either
   *  explicitly, which is what makes this a default rather than a rule. */
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
  const hoverOpens = openOnHover ?? variant !== 'kebab';

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
      className={className ? `relative ${className}` : 'relative'}
      onMouseEnter={hoverOpens ? () => openMenu('none') : undefined}
      onMouseLeave={hoverOpens ? scheduleClose : undefined}
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
          className={triggerClassName ?? TRIGGER_CLASS[variant]}
        >
          {trigger ?? (variant === 'kebab' ? <MoreHorizontal size={16} aria-hidden /> : <Trash2 size={15} aria-hidden />)}
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
