'use client';

import type { ReactNode } from 'react';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';
import { AutoSaveStatus } from './AutoSaveStatus';
import { WorkspaceShell, SpatialSectionRail, type SpatialDeckSection } from './WorkspaceShell';
import type { SpatialMascotState } from './SpatialMascot';

// The section rail and its section type are shell anatomy — the registers mount them too — so they
// moved to WorkspaceShell. Re-exported here because callers reach them by this path.
export { SpatialSectionRail };
export type { SpatialDeckSection };

/** Live figures and a primary action for the deck's hero. Supplying it adds the same metric rail used by
 *  register workspaces, so a settings page can open on the state of the thing it configures. Omit it and
 *  the deck keeps the compact title block. */
export interface SpatialDeckHero {
  metrics: ReactNode;
  action?: ReactNode;
  mascotState?: SpatialMascotState;
}

export function SpatialControlDeck({ eyebrow, sections, value, onChange, ariaLabel, status = 'idle', onRetry, hero, children }: {
  eyebrow: string;
  sections: SpatialDeckSection[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  status?: SaveStatus;
  onRetry?: () => void;
  hero?: SpatialDeckHero;
  children: ReactNode;
}) {
  const active = sections.find((section) => section.id === value) ?? sections[0];
  if (!active) return null;

  return (
    <WorkspaceShell
      variant="deck"
      hero={{
        eyebrow,
        title: active.label,
        description: active.description,
        status: <AutoSaveStatus status={status} onRetry={onRetry} />,
        action: hero?.action,
        // Without the optional hero the deck opens on the compact title block: no mascot, no metric row.
        mascot: hero ? hero.mascotState ?? 'idle' : false,
        metrics: hero?.metrics,
      }}
      navigation={{ sections, value: active.id, onChange, ariaLabel }}
    >
      {children}
    </WorkspaceShell>
  );
}
