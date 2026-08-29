import * as React from 'react';
import { cva } from 'class-variance-authority';

import { cn } from '../../../lib/utils';

// Unlike stock shadcn, this app deliberately lets `rows` own the minimum height. Existing editors use
// compact two- and three-row textareas through the exported `textareaClass` compatibility surface.
const textareaVariants = cva(
  [
    'w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground',
    'placeholder:text-muted-foreground transition-[border-color,background-color,box-shadow]',
    'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
    'disabled:cursor-not-allowed disabled:opacity-40',
    'aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20',
  ],
);

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(textareaVariants(), className)} {...props} />;
}

export { Textarea, textareaVariants };
