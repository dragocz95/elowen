import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { SpatialMascot, type SpatialMascotState } from './SpatialMascot';
import { SpatialSectionRail, type SpatialDeckSection } from './SpatialControlDeck';

export function WorkspacePage({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`workspace-page ${className}`}>{children}</div>;
}

export function CompactWorkspaceHeader({ eyebrow, title, count, description, status, action, icon: Icon }: {
  eyebrow?: string;
  title: string;
  count?: number;
  description?: string;
  status?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <header className="workspace-header">
      <div className="flex min-w-0 items-start gap-4">
        {Icon ? <span className="workspace-header__icon"><Icon size={20} strokeWidth={1.5} aria-hidden /></span> : null}
        <div className="min-w-0">
          {eyebrow ? <div className="workspace-header__eyebrow">{eyebrow}</div> : null}
          <div className="flex min-w-0 items-baseline gap-3">
            <h1>{title}</h1>
            {count !== undefined ? <span className="workspace-header__count">{count}</span> : null}
          </div>
          {description ? <p>{description}</p> : null}
        </div>
      </div>
      <div className="workspace-header__actions">
        {status}
        {action}
      </div>
    </header>
  );
}

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

export interface SpatialWorkspaceLayoutProps {
  hero: Omit<SpatialWorkspaceHeroProps, 'children'> & { metrics: ReactNode };
  navigation?: {
    sections: SpatialDeckSection[];
    value: string;
    onChange: (id: string) => void;
    ariaLabel: string;
  };
  children: ReactNode;
  className?: string;
}

export function SpatialWorkspaceLayout({ hero, navigation, children, className = '' }: SpatialWorkspaceLayoutProps) {
  const { metrics, ...heroProps } = hero;
  return (
    <WorkspacePage className={`spatial-workspace-layout ${className}`}>
      <div className="spatial-workspace-layout__hero">
        <SpatialWorkspaceHero {...heroProps}>{metrics}</SpatialWorkspaceHero>
      </div>
      {navigation ? <SpatialSectionRail {...navigation} /> : null}
      <div className="workspace-content" data-testid="spatial-workspace-layout">{children}</div>
    </WorkspacePage>
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

export function WorkspaceDetailRail({ label, closeLabel, onClose, children }: { label: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside className="workspace-detail-rail" aria-label={label}>
      <header className="workspace-detail-rail__header">
        <span>{label}</span>
        <button type="button" onClick={onClose} aria-label={closeLabel} className="workspace-detail-rail__close">×</button>
      </header>
      <div className="workspace-detail-rail__body">{children}</div>
    </aside>
  );
}
