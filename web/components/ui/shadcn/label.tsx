'use client';

import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../../lib/utils';

/** The shadcn/ui Label, on Radix `@radix-ui/react-label`.
 *
 *  What Radix owns here is small but not nothing: the label forwards a press to the control it labels
 *  without stealing the selection, and a double click on the words no longer selects the paragraph
 *  around them — the mousedown guard skips a press that landed on an embedded control and cancels the
 *  default only for the second click of a double.
 *
 *  `stack` is this app's wrapping form label. `components/ui/Field.tsx` puts the control INSIDE the
 *  label rather than pointing at it with `htmlFor`, because a field's control is whatever the caller
 *  renders and the field has no id to point at. That label is therefore the field's column — the label
 *  row above, the control below — and must not carry the row layout the standalone `default` variant
 *  uses. */
const labelVariants = cva(
  'select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'flex items-center gap-2 text-sm font-medium leading-none text-foreground',
        stack: 'flex flex-col gap-1.5',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

function Label({
  className = '',
  variant,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root> & VariantProps<typeof labelVariants>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(labelVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Label };
