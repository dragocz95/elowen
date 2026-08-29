import * as React from 'react';

import { cn } from '../../../lib/utils';

/** The shadcn/ui Skeleton. A plain element in shadcn too, so there is no Radix package behind it.
 *
 *  The fill is the app's `.skeleton` rule rather than shadcn's `bg-accent animate-pulse`, and that is
 *  the one thing about this file worth knowing: `.skeleton` is where the reduced-effects setting hangs
 *  (`app/styles/animations.css` stops its drift for `data-effects='reduced'` and `'off'`). A placeholder
 *  that painted itself with Tailwind utilities instead would keep moving for a user who asked the app to
 *  hold still, which is a bug this app has already shipped once. */
function Skeleton({ className = '', ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="skeleton" className={cn('skeleton rounded-md', className)} {...props} />;
}

export { Skeleton };
