import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../../lib/utils';

/** The shadcn/ui Badge. A badge is a plain element in shadcn too, so there is no Radix package under it;
 *  what makes it the shadcn component is its anatomy — one `data-slot="badge"` element, `asChild`, and a
 *  `variant` axis declared with `class-variance-authority` — and its styling read from this app's tokens.
 *
 *  `components/ui/Badge.tsx` is the app-shaped wrapper and is what the app imports. */

const badgeVariants = cva(
  // `badge` is not a Tailwind class: it is the hook a skin styles the whole family through
  // (`skins/studio/surfaces.css` gives every badge a pill radius and the page's own typeface). Removing
  // it would silently unstyle every badge under the Studio designs.
  // Stock shadcn also carries `w-fit shrink-0` here; both are left off deliberately. Badges in this app
  // sit inside dense flex rows that are allowed to squeeze them (the Studio designs then ellipsise the
  // text), and pinning an intrinsic width would make those rows overflow instead.
  'badge inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        // Deviates from stock shadcn, which paints `secondary` as a borderless fill with full-strength
        // text. This app's quiet badge is the one it uses most — a plugin's id, a model's context window
        // — and it has to sit inside dense rows without competing with the record's own name, so it keeps
        // an edge and muted ink.
        secondary: 'border-border bg-secondary text-muted-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'border-border bg-transparent text-foreground',
        // App-specific. Stock shadcn only knows solid badges, but every status this app shows — running,
        // failed, deprecated — is a state on a row rather than a call to action, and a row of solid chips
        // reads as a row of buttons. The soft form states the same colour at a tenth of the emphasis, and
        // `success` / `warning` have no shadcn variant at all.
        'soft-primary': 'border-primary/40 bg-primary/10 text-primary',
        'soft-destructive': 'border-destructive/40 bg-destructive/10 text-destructive',
        'soft-success': 'border-success/40 bg-success/10 text-success',
        'soft-warning': 'border-warning/40 bg-warning/10 text-warning',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className = '',
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span';
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
