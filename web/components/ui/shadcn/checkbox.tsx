'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { cva } from 'class-variance-authority';
import { Check, Minus } from 'lucide-react';

import { cn } from '../../../lib/utils';

const checkboxVariants = cva([
  'peer inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-input bg-card text-primary-foreground shadow-xs outline-none transition-colors',
  'data-[state=checked]:border-primary data-[state=checked]:bg-primary',
  'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50',
  'disabled:cursor-not-allowed disabled:opacity-50',
]);

function Checkbox({ className = '', children, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  // Radix renders the indicator for `indeterminate` as well as for `checked`, so a single Check glyph
  // told the user the row was selected when it was only partially selected — the two states looked
  // identical. The dash is the platform's own mark for "some, not all" (it is what a native
  // `input.indeterminate` paints), and it is the ONLY thing that distinguishes the two states here:
  // both share the filled box.
  //
  // The state is read off the `checked` prop rather than off the indicator's `data-state`, because
  // `indeterminate` is only reachable as a CONTROLLED value in this app — every call site drives
  // `checked` itself — and a prop is a value a test can assert on where a CSS `data-state` rule is not.
  const indeterminate = props.checked === 'indeterminate';
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(checkboxVariants(), className)}
      {...props}
    >
      {children ?? (
        <CheckboxPrimitive.Indicator
          data-slot="checkbox-indicator"
          className="flex items-center justify-center text-current"
        >
          {indeterminate ? <Minus className="size-3" strokeWidth={3} /> : <Check className="size-3" strokeWidth={3} />}
        </CheckboxPrimitive.Indicator>
      )}
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
