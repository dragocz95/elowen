'use client'

import * as React from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { SearchIcon } from 'lucide-react'

import { cn } from '../../../lib/utils'

/** The shadcn/ui Command, on `cmdk`.
 *
 *  This file is the shadcn component itself — its anatomy, its `data-slot` attributes and its prop
 *  surface are shadcn's, and the parts are exported individually so a call site composes them. What is
 *  ours is only the styling, which reads this app's design tokens instead of shadcn's default palette;
 *  that is the intended way to own a shadcn component, and it is why adopting shadcn does not repaint
 *  the product.
 *
 *  Behaviour is cmdk's and is NOT reimplemented here: filtering, the roving cursor, Home/End, Enter and
 *  the `combobox`/`listbox`/`option` ARIA wiring. `components/shell/CommandPalette.tsx` is the app-shaped
 *  call site.
 *
 *  NO `CommandDialog`. Stock shadcn ships one, wrapping `Dialog` + `DialogContent` from this directory —
 *  but the palette keeps its own overlay shell (the app's `Dialog` + `useOverlayIsolation`, see
 *  `CommandPalette.tsx`), so the stock composition would sit beside it, not under it, and the app's
 *  `dialog.tsx` does not export the `DialogTitle`/`DialogDescription` pair it imports anyway.
 *  Re-running `shadcn add command` will put it back — that is the one part to remove again.
 *
 *  DELIBERATELY NOT PORTALED, like every other overlay primitive here. This app isolates the background
 *  of an open modal by marking every other child of <body> `inert` and `aria-hidden`
 *  (`components/ui/overlayStack.ts`), so a portaled sub-panel — a second child of <body> outside the
 *  dialog it visually belongs to — is marked inert by the very next overlay and blanks itself. cmdk has
 *  no portal of its own; the danger is only its call sites (and stock `CommandDialog`, removed above).
 */

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
        className
      )}
      {...props}
    />
  )
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-9 items-center gap-2 border-b px-3"
    >
      <SearchIcon className="size-4 shrink-0 opacity-50" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...props}
      />
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        'max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto',
        className
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-sm"
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('-mx-1 h-px bg-border', className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        'relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4 [&_svg:not([class*="text-"])]:text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        'ml-auto text-xs tracking-widest text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}