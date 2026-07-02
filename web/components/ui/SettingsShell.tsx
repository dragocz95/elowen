import type { ReactNode } from 'react';

/** Centered content column for settings-style pages (Settings, Account): the category content sits
 *  in a dashboard-like centered lane instead of stretching edge to edge. */
export function SettingsShell({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-6">{children}</div>;
}
