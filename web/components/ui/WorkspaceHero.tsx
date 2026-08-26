'use client';

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { SpatialMascot, type SpatialMascotState } from './SpatialMascot';

/** The mascot hero shared by the register workspaces (Projects, Memory, Users) and by the settings and
 *  account control decks. It lives in its own module so the deck can mount it without importing
 *  WorkspacePrimitives, which already imports the deck's section rail — the two would otherwise form an
 *  import cycle. WorkspacePrimitives re-exports both symbols, so existing call sites are unaffected. */
export interface SpatialWorkspaceHeroProps {
  eyebrow?: string;
  title: string;
  count?: number;
  description?: string;
  status?: ReactNode;
  action?: ReactNode;
  mascotState?: SpatialMascotState;
  children: ReactNode;
}

export function SpatialWorkspaceHero({ eyebrow, title, count, description, status, action, mascotState = 'idle', children }: SpatialWorkspaceHeroProps) {
  return (
    <section className="spatial-workspace-hero">
      <header className="spatial-workspace-hero__header">
        <div className="min-w-0">
          {eyebrow ? <div className="workspace-header__eyebrow">{eyebrow}</div> : null}
          <div className="flex min-w-0 items-baseline gap-3">
            <h1>{title}</h1>
            {count !== undefined ? <span className="workspace-header__count">{count}</span> : null}
          </div>
          {description ? <p>{description}</p> : null}
        </div>
        <div className="workspace-header__actions">{status}{action}</div>
      </header>
      <div className="spatial-workspace-hero__body">
        <div className="spatial-workspace-hero__mascot" data-testid="workspace-hero-mascot"><SpatialMascot state={mascotState} /></div>
        <div className="spatial-workspace-hero__metrics">{children}</div>
      </div>
    </section>
  );
}

export function WorkspaceMetric({ label, value, icon: Icon }: { label: string; value: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="workspace-metric">
      <span className="workspace-metric__value">{value}</span>
      <span className="workspace-metric__label">{Icon ? <Icon size={12} aria-hidden /> : null}{label}</span>
    </div>
  );
}
