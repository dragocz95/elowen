'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../../lib/utils';

/** The shadcn/ui Button, on `class-variance-authority` and `@radix-ui/react-slot`.
 *
 *  This file is the shadcn component itself — its anatomy, its `data-slot` attribute, its
 *  `variant`/`size` axes and `asChild` are shadcn's. What is ours is only the styling, which reads this
 *  app's design tokens instead of shadcn's default palette, plus two deliberate deviations noted below.
 *
 *  `components/ui/Button.tsx` and `components/ui/IconButton.tsx` are the app-shaped wrappers over this
 *  primitive and are what the app imports; this is the only place a button's geometry is declared. */

const buttonVariants = cva(
  // The border lives in the base rather than in the filled variants: every variant then reserves the
  // same 1px, so a ghost button and a filled one are exactly the same height and swapping between them
  // does not move the row. Variants only choose the border's COLOUR.
  // `box-shadow` joins the transition list because the `default` variant now rests on one; without it
  // the ring would snap while the fill faded, which is worse than either alone.
  //
  // The duration is `--motion-instant`, the app's own fastest step, rather than the reference's literal
  // 100ms: it resolves to 80ms and no skin retunes it. A press is the one interaction that has to feel
  // like it already happened, so 20ms under is the right side to miss on — and a token is what lets
  // `data-effects='off'` and prefers-reduced-motion zero it, which a literal would not.
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md border text-sm font-medium ' +
    'transition-[color,background-color,border-color,box-shadow,transform] duration-[var(--motion-instant)] active:scale-[0.97] ' +
    'disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 ' +
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // The one loud control on a page rests on `--shadow-primary`: a 1px brand ring and a short drop,
        // stated per design because a drop that reads on a near-white page is a no-op on a true-black
        // one. It is what makes the primary read as the ACTION rather than as a coloured label, and it
        // is a token rather than a baked shadow so a white-label theme retints it with `--primary-rgb`.
        default: 'border-primary bg-primary text-primary-foreground shadow-[var(--shadow-primary)] hover:bg-primary/90',
        secondary: 'border-border bg-secondary text-secondary-foreground hover:border-border-strong hover:bg-secondary/80',
        destructive: 'border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        // `accent` is the shadcn token for the interactive surface, and in this app it resolves to a wash
        // of the foreground rather than a step up the surface ramp. That matters: a surface step is a
        // highlight a design is free to erase, and both designs here do erase it, which is how a hover
        // ends up invisible. A wash of the text colour reads on every design by construction.
        ghost: 'border-transparent bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        // shadcn's `link` variant is deliberately absent. It had no call site anywhere in the app, and as
        // a CVA cell it is not neutral: `link` × `icon` is a state nothing can render sensibly — an
        // underline-on-hover with no text to underline, in a square box — yet the gallery is exhaustive
        // over variant × size by construction, so the cell had to be either rendered or removed. A link
        // that looks like a link belongs in prose as an `<a>`, and a link that looks like a button is
        // already reachable through `asChild`.
        // Two app-specific variants, both with no shadcn counterpart, and both the same idea: a
        // destructive action that has to sit quietly in a row or a form. It stays unfilled until the
        // pointer is on it and only then admits what it does — a solid `destructive` button in every row
        // would shout the one thing the user is least likely to want. `ghost-destructive` is the form
        // used inline in prose and forms; `outline-destructive` is the one used in a toolbar, where the
        // control needs an edge to be findable at all.
        'ghost-destructive': 'border-transparent bg-transparent text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive',
        'outline-destructive': 'border-destructive bg-transparent text-destructive hover:bg-destructive hover:text-destructive-foreground',
      },
      size: {
        sm: 'h-8 gap-1.5 px-3',
        default: 'h-9 px-3.5',
        lg: 'h-10 px-5',
        icon: 'size-9 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className = '',
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { Button, buttonVariants };
