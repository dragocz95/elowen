'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useMobileViewport } from '../../lib/useMobile';

/** How many overlays deep the tree currently is. 0 means nothing is open yet, so the next overlay is
 *  the FIRST click out of a section. */
const OverlayDepthContext = createContext(0);

function useOverlayDepth(): number {
  return useContext(OverlayDepthContext);
}

/** Wraps an overlay's own children so anything opened from inside it counts as one level deeper.
 *  A React portal keeps its owner's context, so this stays accurate even though every overlay renders
 *  into document.body rather than where it was written. */
export function OverlayDepthProvider({ children }: { children: ReactNode }) {
  const depth = useOverlayDepth();
  return <OverlayDepthContext.Provider value={depth + 1}>{children}</OverlayDepthContext.Provider>;
}

/** What the overlay is FOR, which is the only thing a call site knows that the rule below cannot work
 *  out for itself. `inspect` is a browsing surface you read and dismiss — a detail rail, a record card.
 *  `edit` is a surface you work IN and commit or cancel. The distinction is retained for call-site intent
 *  and future presentation rules; both shapes take the full screen on a phone. */
export type OverlayIntent = 'inspect' | 'edit';

/** How much room the window has. `phone` is the same breakpoint the stylesheets use — see
 *  `lib/breakpoints.ts`, which both this and every CSS mirror read from. */
export type OverlayViewport = 'phone' | 'roomy';

export type OverlayPresentation = 'drawer' | 'center' | 'sheet' | 'fullscreen';

/** The house rule, in one place. It is a function of BOTH how deep the overlay is and how much room
 *  the window has, because either one alone gives the wrong answer:
 *
 *    - With room, the first click inside a section opens a right-hand drawer and a centered window is
 *      only ever a step taken FROM an already-open drawer.
 *    - On a phone neither of those exists. A drawer that leaves a 48px strip of backdrop is not a
 *      layer, it is a broken layout, and a centered window inside a 390px viewport is a desktop dialog
 *      that happens to be small. Every automatic overlay therefore takes the full screen — there is no
 *      room to show two layers at once, and a partial-height sheet hides half the surface just opened.
 *
 *  Resolved at render time so a control cannot pick the wrong one and no call site has to remember the
 *  rule. `resolveOverlayPresentation(depth)` still answers the desktop question on its own, which is
 *  what the geometry tests and any non-React caller need. */
export function resolveOverlayPresentation(
  depth: number,
  viewport: OverlayViewport = 'roomy',
  _intent: OverlayIntent = 'edit',
): OverlayPresentation {
  if (viewport === 'phone') return 'fullscreen';
  return depth === 0 ? 'drawer' : 'center';
}

/** The rule above, bound to the live viewport. "Not measured yet" reads as roomy: that is the safe
 *  first paint everywhere, and `useMobileViewport` settles within the same commit as the overlay's own
 *  mount effect, so a phone never paints the desktop presentation. */
export function useOverlayPresentation(intent: OverlayIntent = 'edit'): OverlayPresentation {
  const depth = useOverlayDepth();
  const phone = useMobileViewport() === true;
  return resolveOverlayPresentation(depth, phone ? 'phone' : 'roomy', intent);
}
