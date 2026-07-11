'use client';
import type { ReactNode } from 'react';

// RouteTransition in the persistent Shell owns the enter/exit choreography. The template deliberately
// stays neutral so the incoming page does not play a second, much faster fade on top of it.
export default function Template({ children }: { children: ReactNode }) {
  return <div className="h-full">{children}</div>;
}
