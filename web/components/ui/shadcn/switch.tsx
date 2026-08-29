'use client';

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cva } from 'class-variance-authority';

import { cn } from '../../../lib/utils';

const switchVariants = cva([
  'peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border px-0.5 shadow-xs transition-colors outline-none',
  'data-[state=checked]:bg-primary data-[state=unchecked]:bg-secondary',
  'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50',
  'disabled:cursor-not-allowed disabled:opacity-40',
]);

function Switch({ className = '', ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(switchVariants(), className)}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-3.5 rounded-full transition-transform',
          'data-[state=checked]:translate-x-4 data-[state=checked]:bg-primary-foreground',
          'data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-muted-foreground',
        )}
        style={{
          transitionDuration: 'var(--motion-base)',
          transitionTimingFunction: 'var(--ease-spring)',
        }}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
