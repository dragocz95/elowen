'use client';

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { SpatialMascot, type SpatialMascotState } from './SpatialMascot';

/** The ONE workspace hero. Every page shell — the registers (Memory, Projects, Users, every plugin
 *  register), the control decks (Settings, Account) and the single-surface pages (the editor) — opens
 *  with this block, so an eyebrow, a title, a description, a status and an action mean the same thing
 *  and sit in the same place on all of them.
 *
 *  It lives in its own module so WorkspaceShell can mount it without importing WorkspacePrimitives,
 *  which re-exports the shell — the two would otherwise form an import cycle. */
export interface WorkspaceHeroProps {
  eyebrow?: string;
  title: string;
  count?: number;
  description?: string;
  status?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  /** The decorative mascot panel. `false` (the default) is the compact title block a single working
   *  surface wants; a state renders the panel and makes the hero the full register opening. */
  mascot?: SpatialMascotState | false;
  /** WorkspaceMetric children. Supplying them opens the metric row under the title block. */
  metrics?: ReactNode;
}

export function WorkspaceHero({ eyebrow, title, count, description, status, action, icon: Icon, mascot = false, metrics }: WorkspaceHeroProps) {
  const hasMascot = mascot !== false;
  const hasBody = hasMascot || metrics != null;
  const hasActions = status != null || action != null;

  return (
    <section className="workspace-hero" data-mascot={hasMascot ? mascot : undefined}>
      <header className="workspace-hero__head">
        {Icon ? <span className="workspace-hero__icon"><Icon size={20} strokeWidth={1.5} aria-hidden /></span> : null}
        <div className="workspace-hero__titles">
          {eyebrow ? <div className="workspace-hero__eyebrow">{eyebrow}</div> : null}
          <div className="workspace-hero__headline">
            <h1>{title}</h1>
            {count !== undefined ? <span className="workspace-hero__count">{count}</span> : null}
          </div>
          {description ? <p className="workspace-hero__description">{description}</p> : null}
        </div>
        {/* The status is wrapped rather than dropped in raw: on a narrow hero every action stretches to
            fill the row, and a save indicator must not stretch with them. */}
        {hasActions ? (
          <div className="workspace-hero__actions">
            {status != null ? <span className="workspace-hero__status">{status}</span> : null}
            {action}
          </div>
        ) : null}
      </header>
      {hasBody ? (
        <div className="workspace-hero__body">
          {hasMascot ? (
            <div className="workspace-hero__mascot" data-testid="workspace-hero-mascot"><SpatialMascot state={mascot} /></div>
          ) : null}
          <div className="workspace-hero__metrics">{metrics}</div>
        </div>
      ) : null}
    </section>
  );
}

/** The pre-unification hero. Kept exported and working — it is reached through WorkspacePrimitives by
 *  callers this repository cannot typecheck — as a thin alias onto WorkspaceHero. */
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

export function SpatialWorkspaceHero({ mascotState = 'idle', children, ...rest }: SpatialWorkspaceHeroProps) {
  return <WorkspaceHero {...rest} mascot={mascotState} metrics={children} />;
}

export function WorkspaceMetric({ label, value, icon: Icon }: { label: string; value: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="workspace-metric">
      <span className="workspace-metric__value">{value}</span>
      <span className="workspace-metric__label">{Icon ? <Icon size={12} aria-hidden /> : null}{label}</span>
    </div>
  );
}
