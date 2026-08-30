'use client';

import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';

import { cn } from '@/lib/utils';

/** The app's meter primitive, on Radix `@radix-ui/react-progress`.
 *
 *  Two deliberate deviations from stock shadcn, both load-bearing here:
 *
 *  1. The indicator is sized by `width`, not by `transform: translateX(-N%)`. A translated indicator is
 *     always the FULL width of the track and merely slid out of view, so its box is not a proportion of
 *     anything — the layout assertions that measure a fill against its track (studio.viewport e2e) and the
 *     reader's own eye on a rounded end cap both need the painted element to actually BE the fraction it
 *     reports.
 *  2. `indicatorClassName` is exposed so a caller can colour the fill without restyling the track. Usage in
 *     this app is pressure, and the ramp that expresses it belongs to the module owning the thresholds
 *     (`usageProgressClass`), not to every call site repeating an arbitrary variant selector.
 *  3. `indicatorValue` may give a tiny non-zero value a visible sliver while `value` remains the truthful
 *     Radix/ARIA value. Visual minimums must never make a screen reader announce the wrong percentage.
 *
 *  The track is `bg-muted` rather than `bg-primary/20` so an empty meter reads as an empty channel rather
 *  than a tinted one, matching every other quiet surface in the app. */
function Progress({
  className,
  indicatorClassName,
  indicatorValue,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & { indicatorClassName?: string; indicatorValue?: number }) {
  const pct = Math.max(0, Math.min(100, indicatorValue ?? value ?? 0));
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
      value={value}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn('block h-full rounded-full bg-primary transition-[width] duration-500', indicatorClassName)}
        style={{ width: `${pct}%` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
