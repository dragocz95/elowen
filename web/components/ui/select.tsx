'use client';

import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';

import { cn } from '../../lib/utils';

/** The shadcn/ui Select, on Radix `@radix-ui/react-select`.
 *
 *  This file is the shadcn component itself — its anatomy, its `data-slot` attributes and its prop
 *  surface are shadcn's, and the parts are exported individually so a call site composes them. What is
 *  ours is only the styling, which reads this app's design tokens instead of shadcn's default palette;
 *  that is the intended way to own a shadcn component, and it is why adopting shadcn does not repaint
 *  the product.
 *
 *  Behaviour is Radix's and is NOT reimplemented here: typeahead, roving focus, Home/End, Escape,
 *  focus restoration to the trigger, outside-press dismissal, scroll locking, `aria-*` wiring and
 *  collision-aware positioning. `components/ui/SelectMenu.tsx` is the app-shaped wrapper over these
 *  parts and is what most of the app imports. */

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

/** `line` is this app's borderless variant, used where a picker sits inside a toolbar rather than in a
 *  form. It is an extra variant on the shadcn part, not a second component. */
function SelectTrigger({
  className = '',
  variant = 'default',
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & { variant?: 'default' | 'line' }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-variant={variant}
      className={cn(
        'flex h-9 w-full min-w-0 items-center gap-2 text-sm transition-[border-color,background-color,box-shadow]',
        'group focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'line'
          ? 'border-b border-border bg-transparent px-1 text-text hover:border-border-strong data-[state=open]:border-primary data-[state=open]:text-primary'
          : 'rounded-md border border-border bg-surface px-3 text-text hover:border-border-strong hover:bg-elevated data-[state=open]:border-primary/60 data-[state=open]:bg-primary/10 data-[state=open]:text-primary data-[state=open]:shadow-[0_0_0_3px_rgb(var(--primary-rgb)/0.08)]',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown
          size={13}
          aria-hidden
          className="shrink-0 text-text-muted transition-transform group-data-[state=open]:rotate-180"
        />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className = '',
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    // DELIBERATELY NOT PORTALED, unlike stock shadcn. This app isolates the background of an open
    // modal by marking every other child of <body> `inert` and `aria-hidden`
    // (`components/ui/overlayStack.ts`), and it traps focus inside the dialog. A portaled menu is a new
    // child of <body>, so it lands outside the dialog it visually belongs to: the focus trap pulls
    // focus back out of it, and the next overlay to open marks it inert. Rendering in place keeps the
    // menu inside whatever surface owns it, which is also exactly where it was before the port.
    // Re-running `shadcn add select` will put the Portal back — that is the one line to remove again.
    <SelectPrimitive.Content
      data-slot="select-content"
      position={position}
      // `overlay-layer-menu` is the app's menu z-index band, so a menu paints above the surface it
      // opens from.
      className={cn(
        'overlay-layer-menu max-h-96 w-max min-w-[var(--radix-select-trigger-width)] max-w-80 overflow-y-auto overflow-x-hidden',
        'rounded-xl border border-border bg-surface p-1.5 shadow-[var(--shadow-raised)]',
        'data-[state=open]:animate-fade-up',
        position === 'popper' && 'data-[side=bottom]:translate-y-2 data-[side=top]:-translate-y-2',
        className,
      )}
      {...props}
    >
      <SelectScrollUpButton />
      <SelectPrimitive.Viewport
        className={cn(position === 'popper' && 'min-w-full scroll-my-1')}
      >
        {children}
      </SelectPrimitive.Viewport>
      <SelectScrollDownButton />
    </SelectPrimitive.Content>
  );
}

function SelectLabel({ className = '', ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn('px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted', className)}
      {...props}
    />
  );
}

/** `icon` is a sibling of the item's text, never a child of it. `ItemText` renders one inline span whose
 *  content Radix also mirrors into the trigger as the selected value, so a `display:flex` glyph placed
 *  inside it becomes a block box in an inline parent and drops the label onto its own line. Passing the
 *  glyph separately keeps the row a flex row and keeps the mirrored trigger value pure text. */
function SelectItem({ className = '', children, icon, ...props }: React.ComponentProps<typeof SelectPrimitive.Item> & { icon?: React.ReactNode }) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex w-full min-w-0 cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors',
        // The highlight is a wash of the TEXT colour, not a surface step. `elevated` and `overlay` are
        // the tokens a hovered row would normally take, but a skin is free to collapse the surface
        // ramp — studio-oled paints surface, elevated and overlay with one card fill (#080d0f), and the
        // built-in design separates them by 6/255 — so a surface step is a highlight that a design can
        // silently erase. A wash of `--color-text` is relative to the contrast the design already
        // guarantees, so it reads on every skin.
        'text-text data-[highlighted]:bg-text/10 data-[state=checked]:bg-primary/10 data-[state=checked]:text-primary',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      {icon}
      <SelectPrimitive.ItemText className="min-w-0 flex-1 truncate">{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator asChild>
        <Check size={15} aria-hidden className="ml-auto shrink-0 text-primary" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className = '', ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('-mx-1.5 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({ className = '', ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn('flex cursor-default items-center justify-center py-1 text-text-muted', className)}
      {...props}
    >
      <ChevronUp size={13} aria-hidden />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className = '',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn('flex cursor-default items-center justify-center py-1 text-text-muted', className)}
      {...props}
    >
      <ChevronDown size={13} aria-hidden />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
