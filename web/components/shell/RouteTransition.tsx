'use client';

import { AnimatePresence } from 'motion/react';
import * as m from 'motion/react-m';
import { usePathname } from 'next/navigation';
import { useRef, type ReactNode } from 'react';
import { useEffects } from '../../lib/useEffects';

/**
 * Keeps the outgoing page visible long enough to make the change legible, then softly reveals the
 * next route. The shell and spatial navigation stay mounted, so only the working surface crossfades.
 */
export function RouteTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { resolvedMode } = useEffects();
  const disabled = resolvedMode === 'off';
  const reduced = resolvedMode === 'reduced';
  const routeSequence = useRef(0);
  const previousPathname = useRef(pathname);
  if (previousPathname.current !== pathname) {
    routeSequence.current += 1;
    previousPathname.current = pathname;
  }
  // The sequence matters when a user returns to the same route before its previous instance has
  // finished exiting (Stats → Settings → Stats). A pathname-only key would collide with that exiting
  // layer and Motion could leave the reused node at opacity 0.
  const routeKey = `${pathname}:${routeSequence.current}`;

  return (
    <div className="grid h-full">
      <AnimatePresence initial={false} mode="sync">
        <m.div
          key={routeKey}
          data-testid="route-transition"
          className="h-full [grid-area:1/1]"
          initial={disabled ? false : { opacity: 0 }}
          animate={{ opacity: 1, transition: disabled
            ? { duration: 0 }
            : reduced
              ? { duration: 0.12, ease: 'linear' }
              : { duration: 0.32, ease: [0.16, 1, 0.3, 1] } }}
          exit={disabled ? undefined : { opacity: 0, transition: { duration: reduced ? 0.08 : 0.2, ease: 'linear' } }}
        >
          {children}
        </m.div>
      </AnimatePresence>
    </div>
  );
}
