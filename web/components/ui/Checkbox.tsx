'use client';

import { Check } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Checkbox as CheckboxPrimitive } from './shadcn/checkbox';

/** A presentational checkbox indicator. The clickable parent continues to own selection, so the Radix
 * root renders through its child and stays out of the parent's keyboard and pointer interaction. */
export function Checkbox({ checked, className = '' }: { checked: boolean; className?: string }) {
  return (
    <CheckboxPrimitive checked={checked} asChild className={cn('pointer-events-none', className)}>
      <span aria-hidden tabIndex={-1}>
        <Check
          size={11}
          strokeWidth={3}
          className={cn(
            'transition-transform duration-150',
            checked ? 'scale-100 opacity-100' : 'scale-50 opacity-0',
          )}
          style={{ transitionTimingFunction: 'var(--ease-spring)' }}
        />
      </span>
    </CheckboxPrimitive>
  );
}
