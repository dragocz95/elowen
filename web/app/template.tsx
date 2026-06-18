'use client';
import type { ReactNode } from 'react';

// Re-mounts on every navigation (Next.js template semantics), so the page content
// area fades in on each route change. Sidebar lives in the layout, so it stays put.
export default function Template({ children }: { children: ReactNode }) {
  return <div className="h-full animate-route">{children}</div>;
}
