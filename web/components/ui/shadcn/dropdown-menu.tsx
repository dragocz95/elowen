'use client';

import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { cva, type VariantProps } from 'class-variance-authority';
import { Check, ChevronRight, Circle } from 'lucide-react';

import { cn } from '../../../lib/utils';

/** The shadcn/ui DropdownMenu, on Radix `@radix-ui/react-dropdown-menu`.
 *
 *  This file is the shadcn component itself — its anatomy, its `data-slot` attributes and its prop
 *  surface are shadcn's, and the parts are exported individually so a call site composes them. What is
 *  ours is the styling, which reads this app's design tokens instead of shadcn's default palette.
 *
 *  Behaviour is Radix's and is NOT reimplemented here: roving focus, typeahead, Home/End, Escape,
 *  focus restoration to the trigger, outside-press dismissal, submenu hover intent, `aria-*` wiring and
 *  collision-aware positioning. `components/ui/ActionMenu.tsx` is the app-shaped wrapper over these
 *  parts and is what the app imports. */

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuRadioGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

/** Every floating panel in this family — the menu and each submenu — wears the same surface. */
const menuPanel = cn(
  // `overlay-layer-menu` is the app's menu z-index band, so a menu paints above the surface it opens
  // from. The stacking order lives once in tokens.css; never a literal `z-` here.
  'overlay-layer-menu min-w-48 overflow-y-auto overflow-x-hidden',
  'rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-[var(--shadow-raised)]',
  'data-[state=open]:animate-fade-up',
);

/** Radix keeps `onOpenAutoFocus` off a menu content's PUBLIC type — in its model a menu always takes
 *  focus the moment it opens — while `MenuContentImpl` still reads and composes it, which is how Radix's
 *  own modal/non-modal wrappers drive it. It is declared here, on the component this app owns, because
 *  `ActionMenu` also opens on HOVER, and a pointer drifting across a row's trigger must not pull focus
 *  out of whatever the reader was typing in. `ActionMenu`'s "hover does not move focus" test is what
 *  fails loudly if a future Radix stops forwarding it. */
type MenuOpenAutoFocus = {
  /** Fired when the panel is about to take focus on open; `preventDefault()` leaves focus alone. */
  onOpenAutoFocus?: (event: Event) => void;
};

function DropdownMenuContent({
  className = '',
  sideOffset = 4,
  onOpenAutoFocus,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & MenuOpenAutoFocus) {
  const contentProps = { ...props, onOpenAutoFocus };
  return (
    // DELIBERATELY NOT PORTALED, unlike stock shadcn. This app isolates the background of an open
    // modal by marking every other child of <body> `inert` and `aria-hidden`
    // (`components/ui/overlayStack.ts`), and it traps focus inside the dialog. A portaled menu is a new
    // child of <body>, so it lands outside the dialog it visually belongs to: the focus trap pulls
    // focus back out of it, and the next overlay to open marks it inert. Rendering in place keeps the
    // menu inside whatever surface owns it. Radix positions the panel with `position: fixed`, so
    // staying in the tree costs it nothing — it still escapes an ancestor's overflow.
    // Re-running `shadcn add dropdown-menu` will put the Portal back — that is the one line to remove.
    <DropdownMenuPrimitive.Content
      data-slot="dropdown-menu-content"
      sideOffset={sideOffset}
      className={cn(menuPanel, 'max-h-[var(--radix-dropdown-menu-content-available-height)]', className)}
      {...contentProps}
    />
  );
}

function DropdownMenuSubContent({
  className = '',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    // Not portaled, for the same reason as the root content above.
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(menuPanel, 'max-h-[60dvh]', className)}
      {...props}
    />
  );
}

/** The row. `variant` is shadcn's vocabulary — `default` and `destructive`, not the app's older
 *  `tone: 'danger'`; `ActionMenu` and `ContextMenu` translate their public prop into it.
 *
 *  The highlight is `bg-accent`, which in this app is a wash of the FOREGROUND rather than a step up
 *  the surface ramp. That matters: a surface step is a highlight a design can silently erase, and both
 *  designs here do erase it (studio-oled paints surface, elevated and overlay with one card fill), which
 *  is how these rows used to highlight invisibly. A skin may collapse the surface ramp but may not lower
 *  text contrast, so the wash reads by construction. */
const dropdownMenuItemVariants = cva(
  cn(
    'overlay-menu-item relative flex w-full cursor-default select-none items-center gap-2.5 rounded-md px-3 py-2',
    'text-left text-sm outline-none transition-colors',
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
        true: 'pl-8',
        false: '',
      },
    },
    defaultVariants: { variant: 'default', inset: false },
  },
);

function DropdownMenuItem({
  className = '',
  variant,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & VariantProps<typeof dropdownMenuItemVariants>) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant ?? 'default'}
      className={cn(dropdownMenuItemVariants({ variant, inset }), className)}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className = '',
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      checked={checked}
      className={cn(dropdownMenuItemVariants({ inset: true }), className)}
      {...props}
    >
      <span className="absolute left-2.5 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check size={14} aria-hidden className="text-primary" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioItem({
  className = '',
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(dropdownMenuItemVariants({ inset: true }), className)}
      {...props}
    >
      <span className="absolute left-2.5 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle size={8} aria-hidden className="fill-primary text-primary" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuSubTrigger({
  className = '',
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(
        dropdownMenuItemVariants({ inset }),
        'data-[state=open]:bg-accent data-[state=open]:text-accent-foreground',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight size={13} aria-hidden className="ml-auto text-muted-foreground" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuLabel({
  className = '',
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn(
        'px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground',
        inset && 'pl-8',
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className = '',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('-mx-1.5 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className = '', ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn('ml-auto font-mono text-[10px] tracking-widest text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  dropdownMenuItemVariants,
};
