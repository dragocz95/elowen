'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { OverlayDepthProvider } from './overlayDepth';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { SpatialWorkspaceHero, WorkspaceMetric, type SpatialWorkspaceHeroProps } from './WorkspaceHero';
import { SpatialSectionRail, type SpatialDeckSection } from './SpatialControlDeck';
import { useDialogOverlay } from './overlayStack';

// The hero and its metric moved to WorkspaceHero so the control deck can mount them without an import
// cycle through this module's section rail. Re-exported here because every existing caller — including
// the plugin UI runtime surface — reaches them by this path.
export { SpatialWorkspaceHero, WorkspaceMetric };

export function WorkspacePage({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`workspace-page ${className}`}>{children}</div>;
}

/** The slim page header for a workspace that is mostly one working surface — a title block with an
 *  optional eyebrow, description, status and action, and no mascot hero. The editor page uses it
 *  through the plugin UI runtime, which is why it lives here rather than inside that bundle: the
 *  header is app chrome and has to keep matching every other workspace header. */
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

export function WorkspaceDetailRail({ label, closeLabel, onClose, children }: { label: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  const drawer = useRef<HTMLElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);

  useEffect(() => setPortal(document.body), []);
  useDialogOverlay({ enabled: portal != null, rootRef: layer, dialogRef: drawer, onClose });

  const content = (
    <div ref={layer} className="overlay-layer-drawer workspace-detail-layer">
      <div data-testid="workspace-detail-backdrop" className="workspace-detail-backdrop" aria-hidden onMouseDown={onClose} />
      <aside ref={drawer} role="dialog" aria-modal="true" tabIndex={-1} className="workspace-detail-rail workspace-detail-drawer" aria-label={label}>
      <header className="workspace-detail-rail__header">
        <span>{label}</span>
        <button type="button" onClick={onClose} aria-label={closeLabel} className="workspace-detail-rail__close">×</button>
      </header>
      <div className="workspace-detail-rail__body"><OverlayDepthProvider>{children}</OverlayDepthProvider></div>
      </aside>
    </div>
  );
  return portal ? createPortal(content, portal) : content;
}
