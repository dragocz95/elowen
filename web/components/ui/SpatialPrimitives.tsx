'use client';
import { useRef, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { HelpTip } from './HelpTip';
import { CosmosGroup, useConstellation } from './Constellation';

function SpatialLabel({ title, description, icon: Icon }: { title: string; description?: string; icon?: LucideIcon }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      {Icon ? (
        <span className="spatial-field-icon" aria-hidden>
          <Icon size={15} strokeWidth={1.6} />
        </span>
      ) : null}
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-medium text-text">
          {title}
          {description ? <HelpTip align="left">{description}</HelpTip> : null}
        </span>
      </span>
    </div>
  );
}

/** Open document section used by spatial control surfaces. It deliberately has no card shell.
 *  PROTOTYPE(constellation): inside a ConstellationScope the group renders as an orbital cosmos
 *  instead — `variant="classic"` opts a group out (for non-row content like the permission rules). */
export function SpatialGroup({ title, description, icon, children, className = '', variant }: {
  title?: string;
  description?: string;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
  variant?: 'classic';
}) {
  const cosmos = useConstellation();
  if (cosmos && variant !== 'classic') {
    return <CosmosGroup core={title ?? cosmos.core}>{children}</CosmosGroup>;
  }
  return (
    <section className={`spatial-form-group ${className}`}>
      {title ? (
        <header className="spatial-form-group__header">
          <SpatialLabel title={title} description={description} icon={icon} />
        </header>
      ) : null}
      <div className="spatial-form-group__body">{children}</div>
    </section>
  );
}

/** A responsive label/control row. Controls become horizontal only when the document has room.
 *  PROTOTYPE(constellation): inside a ConstellationScope the row renders as a floating pod. */
export function SpatialRow({ title, description, icon: Icon, children, className = '' }: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  const cosmos = useConstellation();
  const podRef = useRef<HTMLDivElement>(null);
  if (cosmos) {
    // Inline "manage" buttons and toggle captions stay out of the pod — the orb itself is the
    // manage trigger (it forwards to the control's hidden [data-selection-manage] button when one
    // exists). The description keeps its HelpTip "?" next to the title.
    return (
      <div className="cosmos-pod" ref={podRef}>
        <div className="cosmos-pod__inner">
          {Icon ? (
            <button
              type="button"
              className="cosmos-pod__orb"
              aria-label={title}
              onClick={() => podRef.current?.querySelector<HTMLButtonElement>('[data-selection-manage]')?.click()}
            >
              <Icon size={17} strokeWidth={1.6} aria-hidden />
            </button>
          ) : null}
          <span className="cosmos-pod__title">
            {title}
            {description ? <HelpTip align="left">{description}</HelpTip> : null}
          </span>
          <div className="cosmos-pod__control">{children}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={`spatial-form-row ${className}`}>
      <SpatialLabel title={title} description={description} icon={Icon} />
      <div className="spatial-form-row__control">{children}</div>
    </div>
  );
}

/** Short status/identity strip without turning it into a detached card. */
export function SpatialIdentity({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="spatial-identity">
      <div className="min-w-0 flex-1">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
