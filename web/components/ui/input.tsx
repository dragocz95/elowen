import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utils';

const inputVariants = cva(
  [
    'h-9 w-full min-w-0 border border-input text-sm text-foreground placeholder:text-muted-foreground',
    'transition-[border-color,background-color,box-shadow] selection:bg-primary selection:text-primary-foreground',
    'file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
    'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
    'disabled:cursor-not-allowed disabled:opacity-40',
    'aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20',
  ],
  {
    variants: {
      variant: {
        default: 'rounded-md bg-card py-1 pl-3 pr-3',
        line: 'rounded-none border-x-0 border-t-0 bg-transparent px-0 py-1 focus-visible:ring-0',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Input({ className, type, variant, ...props }: React.ComponentProps<'input'> & VariantProps<typeof inputVariants>) {
  return (
    <input
      type={type}
      data-slot="input"
      data-variant={variant ?? 'default'}
      className={cn(inputVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Input, inputVariants };
