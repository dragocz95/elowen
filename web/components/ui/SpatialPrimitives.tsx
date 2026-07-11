import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { HelpTip } from './HelpTip';

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

/** Open document section used by spatial control surfaces. It deliberately has no card shell. */
export function SpatialGroup({ title, description, icon, children, className = '' }: {
  title?: string;
  description?: string;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
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

/** A responsive label/control row. Controls become horizontal only when the document has room. */
export function SpatialRow({ title, description, icon, children, className = '' }: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`spatial-form-row ${className}`}>
      <SpatialLabel title={title} description={description} icon={icon} />
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
