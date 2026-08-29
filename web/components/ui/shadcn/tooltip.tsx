'use client';

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';

import { cn } from '../../../lib/utils';

/** The app's tooltip primitive — on Radix `@radix-ui/react-popover`, NOT `@radix-ui/react-tooltip`.
 *
 *  That is a deliberate deviation from stock shadcn and the reason is the contract this surface has to
 *  keep. `components/ui/HelpTip.tsx` is a help affordance beside a form label: it opens on hover, on
 *  focus AND on tap, because a touch user has no hover and the "?" is the only way to reach the
 *  explanation. Radix's Tooltip cannot serve that:
 *
 *    - Its trigger CLOSES on click/pointerdown by design (a tooltip is a hover-only hint), so the tap
 *      affordance that exists for phones would dismiss the very thing it is meant to reveal.
 *    - Its Content renders a second, visually hidden copy of the children carrying `role="tooltip"`,
 *      so every hint would be announced and, more concretely, present in the DOM twice — a `getByText`
 *      for a hint in an unrelated suite starts matching two nodes.
 *
 *  Popover gives us the transport we actually need — controlled open state, collision-aware placement,
 *  outside-press and Escape dismissal — while the tooltip SEMANTICS stay ours and stay correct: the
 *  content keeps `role="tooltip"` and is wired to the trigger with `aria-describedby` (a description,
 *  not a dialog the user navigates into), it never takes focus, and it is transparent to the pointer.
 *  The parts are named for what they are to the app, so a call site reads as a tooltip. */

function Tooltip({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="tooltip" {...props} />;
}

/** The element the tip is positioned against. `Anchor` rather than `Trigger` on purpose: the trigger
 *  would stamp `aria-haspopup="dialog"` / `aria-controls` onto the button and announce a dialog that
 *  does not exist. The button stays a plain button described by the tip. */
function TooltipAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="tooltip-anchor" {...props} />;
}

function TooltipContent({
  className = '',
  side = 'bottom',
  sideOffset = 8,
  collisionPadding = 12,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    // DELIBERATELY NOT PORTALED, unlike stock shadcn. This app isolates the background of an open modal
    // by marking every other child of <body> `inert` and `aria-hidden`
    // (`components/ui/overlayStack.ts`) and traps focus inside the dialog. A portaled tip is a new child
    // of <body>, so a tip belonging to a field inside a dialog lands outside it and the next overlay to
    // open marks it inert — an explanation that silently stops being readable. Radix positions the panel
    // with `position: fixed`, so rendering in place still escapes an ancestor's overflow.
    // Re-running `shadcn add popover` will put the Portal back — that is the one line to remove again.
    <PopoverPrimitive.Content
      data-slot="tooltip-content"
      role="tooltip"
      side={side}
      sideOffset={sideOffset}
      // The old hand-rolled geometry is expressed here, in Radix's vocabulary: prefer below the
      // trigger, flip above only when the body would spill past the fold, and keep a 12px gutter to
      // every viewport edge. `avoidCollisions` (on by default) is what does the flipping.
      collisionPadding={collisionPadding}
      // The tip is a description, not a destination: opening it must never move focus off the control
      // the reader is on, and closing it must not yank focus back from wherever they went.
      onOpenAutoFocus={(event) => { onOpenAutoFocus?.(event); event.preventDefault(); }}
      onCloseAutoFocus={(event) => { onCloseAutoFocus?.(event); event.preventDefault(); }}
      className={cn(
        // `pointer-events-none` is load-bearing: the body floats over neighbouring controls and holds
        // no links or selectable data worth reaching, so it must never intercept a click meant for the
        // field underneath.
        'overlay-layer-menu pointer-events-none w-64 rounded-md border border-border p-3',
        'bg-popover text-xs font-normal normal-case leading-relaxed tracking-normal text-muted-foreground',
        'shadow-[var(--shadow-raised)] data-[state=open]:animate-fade-up',
        className,
      )}
      {...props}
    />
  );
}

export { Tooltip, TooltipAnchor, TooltipContent };
