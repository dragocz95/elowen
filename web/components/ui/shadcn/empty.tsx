import * as React from 'react';

import { cn } from '../../../lib/utils';

/** The shadcn/ui Empty parts. Plain elements in shadcn too, so there is no Radix package behind them.
 *
 *  This is the centred block a register shows INSTEAD of its content — nothing here, or nothing loaded.
 *  The parts carry the app's own geometry rather than shadcn's defaults, for the same reason
 *  `shadcn/select.tsx` does: adopting shadcn is meant to move the anatomy, not to repaint the product.
 *
 *  `components/ui/states.tsx` composes them twice, and that is the point of the file — `EmptyState` and
 *  `ErrorState` were two hand-written centred columns that had drifted a gap and two paddings apart. */

function Empty({ className = '', ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty"
      className={cn('flex flex-col items-center justify-center gap-3 py-14 text-center', className)}
      {...props}
    />
  );
}

function EmptyHeader({ className = '', ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="empty-header" className={cn('flex flex-col gap-1', className)} {...props} />;
}

/** The icon slot. Deliberately faint: it is the least important thing in the block and sits behind the
 *  sentence that explains the state. */
function EmptyMedia({ className = '', ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty-media"
      className={cn('flex shrink-0 items-center justify-center text-muted-foreground/40', className)}
      {...props}
    />
  );
}

function EmptyTitle({ className = '', ...props }: React.ComponentProps<'p'>) {
  return <p data-slot="empty-title" className={cn('text-sm text-foreground', className)} {...props} />;
}

function EmptyDescription({ className = '', ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="empty-description"
      className={cn('text-xs text-muted-foreground', className)}
      {...props}
    />
  );
}

/** Whatever the user can do about the state — a retry, a "create the first one" button. */
function EmptyContent({ className = '', ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty-content"
      className={cn('flex flex-col items-center gap-2', className)}
      {...props}
    />
  );
}

export { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle };
