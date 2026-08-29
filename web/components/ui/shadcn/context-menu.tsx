'use client';

import * as React from 'react';
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import { cva, type VariantProps } from 'class-variance-authority';
import { Check, ChevronRight, Circle } from 'lucide-react';

import { cn } from '../../../lib/utils';

/** The shadcn/ui ContextMenu, on Radix `@radix-ui/react-context-menu`.
 *
 *  This file is the shadcn component itself — anatomy, `data-slot` attributes and prop surface are
 *  shadcn's; the styling is ours and reads this app's design tokens.
 *
 *  Behaviour is Radix's and is NOT reimplemented here: opening at the pointer, viewport-aware placement
 *  and submenu flipping, roving focus, typeahead, Escape, outside-press dismissal and `aria-*` wiring.
 *  `components/ui/ContextMenu.tsx` is the app-shaped wrapper over these parts.
 *
 *  A context menu is denser than a dropdown by design (this is the file-tree / register right-click
 *  menu), so its rows are smaller than `dropdown-menu.tsx`'s — but the highlight is spelled exactly the
 *  same way, because that spelling is the part that has to be identical everywhere. */

function ContextMenu({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

function ContextMenuGroup({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
  return <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />;
}

function ContextMenuRadioGroup({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />;
}

function ContextMenuSub({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />;
}

/** Both floating panels — the menu and each submenu — wear the same surface. `max-h` is in `dvh` on
 *  purpose: a mobile browser's collapsing toolbar makes `vh` taller than the screen, so a long submenu
 *  measured in `vh` runs off the bottom instead of scrolling. */
const menuPanel = cn(
  // `overlay-layer-menu` is the app's menu z-index band; the stacking order lives once in tokens.css.
  'overlay-layer-menu min-w-44 max-h-[60dvh] overflow-y-auto overflow-x-hidden',
  'rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-[var(--shadow-card)]',
  'data-[state=open]:animate-fade-up',
);

function ContextMenuContent({
  className = '',
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    // DELIBERATELY NOT PORTALED, unlike stock shadcn. This app isolates the background of an open
    // modal by marking every other child of <body> `inert` and `aria-hidden`
    // (`components/ui/overlayStack.ts`), and it traps focus inside the dialog. A portaled menu is a new
    // child of <body>, so it lands outside the dialog it visually belongs to: the focus trap pulls
    // focus back out of it, and the next overlay to open marks it inert. That is not hypothetical here
    // — this menu is opened from inside the sessions dialog. Radix positions the panel with
    // `position: fixed`, so rendering in place still escapes an ancestor's overflow.
    // Re-running `shadcn add context-menu` will put the Portal back — that is the one line to remove.
    <ContextMenuPrimitive.Content
      data-slot="context-menu-content"
      className={cn(menuPanel, className)}
      {...props}
    />
  );
}

function ContextMenuSubContent({
  className = '',
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    // Not portaled, for the same reason as the root content above.
    <ContextMenuPrimitive.SubContent
      data-slot="context-menu-sub-content"
      className={cn(menuPanel, className)}
      {...props}
    />
  );
}

/** The row. The highlight is `bg-accent` — in this app a wash of the FOREGROUND, not a step up the
 *  surface ramp. A surface step is a highlight a design can silently erase, and both designs here do
 *  erase it, which is how this row used to highlight invisibly. A skin may collapse the surface ramp
 *  but may not lower text contrast, so the wash reads by construction. */
const contextMenuItemVariants = cva(
  cn(
    'overlay-menu-item relative flex w-full cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5',
    'text-left outline-none transition-colors',
    'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ),
  {
    variants: {
      variant: {
        default: 'text-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
        destructive: 'text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive',
      },
      inset: {
        true: 'pl-7',
        false: '',
      },
    },
    defaultVariants: { variant: 'default', inset: false },
  },
);

function ContextMenuItem({
  className = '',
  variant,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & VariantProps<typeof contextMenuItemVariants>) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-variant={variant ?? 'default'}
      className={cn(contextMenuItemVariants({ variant, inset }), className)}
      {...props}
    />
  );
}

function ContextMenuCheckboxItem({
  className = '',
  children,
  checked,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      checked={checked}
      className={cn(contextMenuItemVariants({ inset: true }), className)}
      {...props}
    >
      <span className="absolute left-2 flex size-3 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <Check size={12} aria-hidden className="text-primary" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  );
}

function ContextMenuRadioItem({
  className = '',
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem>) {
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      className={cn(contextMenuItemVariants({ inset: true }), className)}
      {...props}
    >
      <span className="absolute left-2 flex size-3 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <Circle size={7} aria-hidden className="fill-primary text-primary" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  );
}

function ContextMenuSubTrigger({
  className = '',
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & { inset?: boolean }) {
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      className={cn(
        contextMenuItemVariants({ inset }),
        'data-[state=open]:bg-accent data-[state=open]:text-accent-foreground',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight size={13} aria-hidden className="ml-auto text-muted-foreground" />
    </ContextMenuPrimitive.SubTrigger>
  );
}

function ContextMenuLabel({
  className = '',
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & { inset?: boolean }) {
  return (
    <ContextMenuPrimitive.Label
      data-slot="context-menu-label"
      className={cn(
        'px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground',
        inset && 'pl-7',
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className = '',
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

function ContextMenuShortcut({ className = '', ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn('ml-auto font-mono text-[10px] tracking-widest text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  contextMenuItemVariants,
};
