'use client';

import * as React from 'react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { cva, type VariantProps } from 'class-variance-authority';
import { Circle } from 'lucide-react';

import { cn } from '../../../lib/utils';

/** The shadcn/ui RadioGroup, on Radix `@radix-ui/react-radio-group`.
 *
 *  The unconfigured parts retain shadcn's standard radio presentation. The `variant`, `size` and
 *  `nowrap` extensions are the app's segmented presentation: the same Radix roles and keyboard model,
 *  restyled as connected choices without duplicating selection or roving-focus behaviour. */
const radioGroupVariants = cva('grid gap-3', {
  variants: {
    variant: {
      default: 'inline-flex max-w-full gap-0.5 rounded-md border border-border bg-card p-0.5',
      line: 'inline-flex max-w-full gap-4 border-b border-border/80',
      menu: 'inline-flex max-w-full flex-col items-stretch gap-1',
    },
    nowrap: {
      true: '',
      false: '',
    },
  },
  compoundVariants: [
    {
      variant: ['default', 'line'],
      nowrap: false,
      className: 'flex-wrap',
    },
    {
      variant: ['default', 'line'],
      nowrap: true,
      className: 'flex-nowrap overflow-x-auto overflow-y-hidden overscroll-x-contain',
    },
  ],
});

const radioGroupItemVariants = cva(
  'outline-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      appearance: {
        radio: [
          'aspect-square size-4 shrink-0 rounded-full border border-input text-primary shadow-xs',
          'transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        ],
        segmented: [
          'segmented__option inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-xs font-medium transition-colors',
          'pointer-coarse:min-h-[var(--touch-target)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          '[&_[data-slot=radio-group-indicator]]:hidden',
        ],
      },
      variant: {
        default: '',
        line: '',
        menu: '',
      },
      size: {
        sm: '',
        default: '',
      },
    },
    compoundVariants: [
      {
        appearance: 'segmented',
        variant: 'default',
        className: [
          'rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          'data-[state=checked]:bg-primary/15 data-[state=checked]:text-primary',
        ],
      },
      {
        appearance: 'segmented',
        variant: 'line',
        className: [
          '-mb-px border-b-2 border-transparent text-muted-foreground',
          'hover:bg-accent hover:text-accent-foreground',
          'data-[state=checked]:border-primary data-[state=checked]:text-primary',
        ],
      },
      {
        appearance: 'segmented',
        variant: 'menu',
        className: [
          'w-full justify-start rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          'data-[state=checked]:bg-primary/15 data-[state=checked]:text-primary',
        ],
      },
      {
        appearance: 'segmented',
        size: 'sm',
        className: 'h-9 px-2.5',
      },
      {
        appearance: 'segmented',
        size: 'default',
        className: 'h-9 px-3',
      },
      {
        appearance: 'segmented',
        variant: 'menu',
        className: 'h-10 px-2.5',
      },
    ],
    defaultVariants: {
      appearance: 'radio',
    },
  },
);

type RadioGroupProps = React.ComponentProps<typeof RadioGroupPrimitive.Root> &
  VariantProps<typeof radioGroupVariants>;

function RadioGroup({ className = '', variant, nowrap = false, ...props }: RadioGroupProps) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      data-variant={variant ?? undefined}
      className={cn(radioGroupVariants({ variant, nowrap }), className)}
      {...props}
    />
  );
}

type RadioGroupItemProps = React.ComponentProps<typeof RadioGroupPrimitive.Item> &
  VariantProps<typeof radioGroupItemVariants>;

function RadioGroupItem({
  className = '',
  appearance,
  variant,
  size,
  children,
  ...props
}: RadioGroupItemProps) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      data-variant={variant ?? undefined}
      className={cn(radioGroupItemVariants({ appearance, variant, size }), className)}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center"
      >
        <Circle className="absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 fill-primary" />
      </RadioGroupPrimitive.Indicator>
      {children}
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
