import type { ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Button as ShadcnButton, buttonVariants } from './shadcn/button';

/** The app-shaped button, composed from the shadcn/ui `Button` in `./shadcn/button.tsx`.
 *
 *  Only the vocabulary is this file's: the app names its variants by emphasis (`accent` is the brand
 *  fill, `default` is the quiet one) where shadcn names them by role (`default` IS the brand). The two
 *  disagree on the meaning of the word `default`, so they cannot be merged into one prop type without
 *  making 39 call sites ambiguous — this map is what keeps every one of them untouched. It is temporary:
 *  a later phase moves the call sites onto the shadcn names and deletes the map with this wrapper. */
type Variant = 'default' | 'accent' | 'ghost' | 'danger' | 'ghost-danger';

const SHADCN_VARIANT = {
  default: 'secondary',
  accent: 'default',
  ghost: 'ghost',
  danger: 'destructive',
  'ghost-danger': 'ghost-destructive',
} as const satisfies Record<Variant, NonNullable<Parameters<typeof buttonVariants>[0]>['variant']>;

/** The button's classes without the button — for the handful of places that need the same control on an
 *  `<a>` or a `<label>`. Callers append their own overrides through `className`, and going through `cn()`
 *  means an override actually WINS: the old template-literal version emitted both `h-9` and the caller's
 *  `h-10` and left the winner to stylesheet order. */
export function buttonClassName(variant: Variant = 'default', className = ''): string {
  return cn(buttonVariants({ variant: SHADCN_VARIANT[variant] }), className);
}

export function Button({ variant = 'default', icon: Icon, className = '', children, ...rest }: { variant?: Variant; icon?: LucideIcon } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <ShadcnButton variant={SHADCN_VARIANT[variant]} className={className} {...rest}>
      {Icon ? <Icon size={14} aria-hidden /> : null}
      {children}
    </ShadcnButton>
  );
}
