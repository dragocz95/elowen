'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { cva } from 'class-variance-authority';
import { Check } from 'lucide-react';

import { cn } from '../../../lib/utils';

const checkboxVariants = cva([
  'peer inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-input bg-card text-primary-foreground shadow-xs outline-none transition-colors',
  'data-[state=checked]:border-primary data-[state=checked]:bg-primary',
  'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50',
  'disabled:cursor-not-allowed disabled:opacity-50',
]);

function Checkbox({ className = '', children, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
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
          <Check className="size-3" strokeWidth={3} />
        </CheckboxPrimitive.Indicator>
      )}
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
