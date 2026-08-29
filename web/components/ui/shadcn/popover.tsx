'use client';

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';

import { cn } from '../../../lib/utils';

/** The shadcn/ui Popover, on Radix `@radix-ui/react-popover`.
 *
 * Behaviour is Radix's: trigger semantics, outside-press and Escape dismissal, focus restoration and
 * collision-aware positioning. The content intentionally stays in place rather than using a Portal so it
 * remains inside the app overlay that owns it. */
function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className = '',
  align = 'center',
  sideOffset = 8,
  collisionPadding = 12,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    // DELIBERATELY NOT PORTALED, unlike stock shadcn. This app isolates the background of an open
    // modal by marking every other child of <body> `inert` and `aria-hidden`
    // (`components/ui/overlayStack.ts`) and traps focus inside the dialog. A portaled popover is a new
    // child of <body>, so it lands outside the dialog it visually belongs to. Radix positions this
    // content with `position: fixed`, so rendering in place still escapes ancestor overflow.
    // Re-running `shadcn add popover` will put the Portal back — that is the one line to remove again.
    <PopoverPrimitive.Content
      data-slot="popover-content"
      align={align}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        'overlay-layer-menu w-72 rounded-lg border border-border bg-popover p-4 text-popover-foreground',
        'shadow-[var(--shadow-raised)] outline-none data-[state=open]:animate-fade-up',
        className,
      )}
      {...props}
    />
  );
}

export { Popover, PopoverContent, PopoverTrigger };
