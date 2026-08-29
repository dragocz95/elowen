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
 *  a later phase moves the call sites onto the shadcn names and deletes the map with this wrapper.
 *
 *  It is also the ONLY app→shadcn variant map: `IconButton` used to keep a second, silently divergent one
 *  in which `default` meant `outline` rather than `secondary`. The two outline names below are what that
 *  wrapper needs, expressed in this vocabulary, so no file outside this one spells a shadcn variant. */
export type ButtonVariant = 'default' | 'accent' | 'ghost' | 'danger' | 'ghost-danger' | 'outline' | 'outline-danger';

const SHADCN_VARIANT = {
  default: 'secondary',
  accent: 'default',
  ghost: 'ghost',
  danger: 'destructive',
  'ghost-danger': 'ghost-destructive',
  outline: 'outline',
  'outline-danger': 'outline-destructive',
} as const satisfies Record<ButtonVariant, NonNullable<Parameters<typeof buttonVariants>[0]>['variant']>;

/** The size axis is the primitive's, passed through under its own names — unlike `variant`, the two
 *  vocabularies do not disagree here, so a second map would be a second thing to keep in sync for nothing.
 *  `satisfies` is what ties it to the CVA: a name that is not a real size there fails to compile. `icon`
 *  is on the list because `IconButton` composes this wrapper; it is the one size that expects no children.
 *
 *  Both axes are exported as VALUES because the gallery renders them exhaustively, and reading them off
 *  this file is the only way a name added here cannot quietly go uncovered. Declaration order is the
 *  render order there. */
export const BUTTON_SIZES = ['sm', 'default', 'lg', 'icon'] as const satisfies readonly NonNullable<Parameters<typeof buttonVariants>[0]>['size'][];
export type ButtonSize = (typeof BUTTON_SIZES)[number];

export const BUTTON_VARIANTS = Object.keys(SHADCN_VARIANT) as ButtonVariant[];

/** The button's classes without the button — for the handful of places that need the same control on an
 *  `<a>` or a `<label>`. Callers append their own overrides through `className`, and going through `cn()`
 *  means an override actually WINS: the old template-literal version emitted both `h-9` and the caller's
 *  `h-10` and left the winner to stylesheet order. `size` is a real parameter rather than one more thing
 *  to hand-write into `className`, so that a link-shaped button picks the same geometry a real one would. */
export function buttonClassName(variant: ButtonVariant = 'default', size: ButtonSize = 'default', className = ''): string {
  return cn(buttonVariants({ variant: SHADCN_VARIANT[variant], size }), className);
}

export function Button({ variant = 'default', size = 'default', icon: Icon, className = '', children, ...rest }: { variant?: ButtonVariant; size?: ButtonSize; icon?: LucideIcon } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <ShadcnButton variant={SHADCN_VARIANT[variant]} size={size} className={className} {...rest}>
      {Icon ? <Icon size={14} aria-hidden /> : null}
      {children}
    </ShadcnButton>
  );
}
