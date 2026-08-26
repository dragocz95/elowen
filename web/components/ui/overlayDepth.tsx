'use client';

import { createContext, useContext, type ReactNode } from 'react';

/** How many overlays deep the tree currently is. 0 means nothing is open yet, so the next overlay is
 *  the FIRST click out of a section. */
const OverlayDepthContext = createContext(0);

export function useOverlayDepth(): number {
  return useContext(OverlayDepthContext);
}

/** Wraps an overlay's own children so anything opened from inside it counts as one level deeper.
 *  A React portal keeps its owner's context, so this stays accurate even though every overlay renders
 *  into document.body rather than where it was written. */
export function OverlayDepthProvider({ children }: { children: ReactNode }) {
  const depth = useOverlayDepth();
  return <OverlayDepthContext.Provider value={depth + 1}>{children}</OverlayDepthContext.Provider>;
}

/** The house rule, in one place: the first click inside a section opens a right-hand drawer, and a
 *  centered window is only ever a step taken FROM an already-open drawer. Resolved at render time from
 *  the depth above, so a control cannot pick the wrong one and no call site has to remember the rule. */
export function resolveOverlayPresentation(depth: number): 'drawer' | 'center' {
  return depth === 0 ? 'drawer' : 'center';
}
