'use client';

import * as m from 'motion/react-m';
import { usePathname } from 'next/navigation';
import { useRef, type ReactNode } from 'react';
import { useEffects } from '../../lib/useEffects';

/**
 * Softly reveals one live route tree. We deliberately do not overlap whole pages: overlapping client
 * pages duplicates their data hooks and heavy scenes (Settings briefly created two WebGL mascots).
 *
 * The reveal dims the incoming route with a black scrim that fades out instead of animating the
 * content's own opacity. Fractional opacity on the route tree makes Chromium re-composite the
 * blurred mascot glows, which visibly brightens the whole hero before it settles back to black;
 * a solid black scrim can only darken, so the fade stays smooth on the OLED theme.
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
    <div className="relative h-full">
      <div key={routeKey} data-testid="route-transition" className="h-full">
        {children}
      </div>
      {disabled ? null : (
        <m.div
          key={`scrim:${routeKey}`}
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 bg-black"
          initial={{ opacity: reduced ? 0.14 : 0.38 }}
          animate={{ opacity: 0 }}
          transition={reduced
            ? { duration: 0.14, ease: 'linear' }
            : { duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
        />
      )}
    </div>
  );
}
