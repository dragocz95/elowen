'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { OverlayDepthProvider, useOverlayPresentation } from './overlayDepth';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { SpatialWorkspaceHero, WorkspaceHero, WorkspaceMetric, type SpatialWorkspaceHeroProps } from './WorkspaceHero';
import { WorkspaceShell, type SpatialDeckSection } from './WorkspaceShell';
import { focusOverlaySurface, useOverlayIsolation } from './overlayStack';
import { Dialog, DialogContent } from './shadcn/dialog';

// The hero, its metric and the page shell live in their own modules so the control deck can mount them
// without an import cycle back through this one. Only the two names existing callers already reach by
// THIS path are re-exported — the plugin UI runtime takes WorkspaceMetric from here, and the hero tests
// take SpatialWorkspaceHero. Everything else imports from the module that owns it.
export { SpatialWorkspaceHero, WorkspaceMetric };

export function WorkspacePage({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`workspace-page ${className}`}>{children}</div>;
}

/** The slim page header for a workspace that is mostly one working surface — a title block with an
 *  optional eyebrow, description, status and action, and no mascot hero. The editor page uses it
 *  through the plugin UI runtime, which is why it lives here rather than inside that bundle: the
 *  header is app chrome and has to keep matching every other workspace header.
 *
 *  It is the mascot-less WorkspaceHero, and nothing more. Kept under its own name because bundles this
 *  repository cannot typecheck import it by that name. */
export function CompactWorkspaceHeader({ eyebrow, title, count, description, status, action, icon }: {
  eyebrow?: string;
  title: string;
  count?: number;
  description?: string;
  status?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
}) {
  return <WorkspaceHero eyebrow={eyebrow} title={title} count={count} description={description} status={status} action={action} icon={icon} mascot={false} />;
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

/** The register shell, kept under its pre-unification name: eleven plugin bundles across two
 *  repositories mount it, and the plugin API version is a compatibility ceiling that cannot express a
 *  removal. A thin alias onto WorkspaceShell's `register` variant. */
export function SpatialWorkspaceLayout({ hero, navigation, children, className = '' }: SpatialWorkspaceLayoutProps) {
  const { metrics, mascotState = 'idle', ...heroProps } = hero;
  return (
    <WorkspaceShell variant="register" className={className} hero={{ ...heroProps, mascot: mascotState, metrics }} navigation={navigation}>
      {children}
    </WorkspaceShell>
  );
}

/** The master/detail rail: a surface you open to READ a record, not to work in one. That is what
 *  `intent="inspect"` says, and it is the whole difference on a phone — the rail comes up as a bottom
 *  sheet there, where the desktop side rail would leave a useless strip of backdrop beside it. The
 *  geometry of each presentation lives in `.overlay-surface[data-presentation]`.
 *
 *  On the shadcn `Dialog` (Radix) for the same split `Modal.tsx` documents: Radix owns the dialog role,
 *  the focus trap, Escape and the layer order among several open overlays; the app keeps the overlay
 *  stack's `inert` isolation, the focus it puts in and gives back, and the backdrop press. */
export function WorkspaceDetailRail({ label, closeLabel, onClose, children }: { label: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  const drawer = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const presentation = useOverlayPresentation('inspect');

  useEffect(() => setPortal(document.body), []);
  const { restoreFocus } = useOverlayIsolation({ enabled: portal != null, rootRef: layer });

  if (!portal) return null;
  return createPortal(
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <div
        ref={layer}
        className="overlay-layer-drawer workspace-detail-layer"
        // Radix's modal content sets `pointer-events: none` on <body> and re-enables them on itself;
        // this layer would inherit the block and the backdrop below would stop answering the press that
        // dismisses the rail. Opting back in is what `DialogOverlay` does for the same reason.
        style={{ pointerEvents: 'auto' }}
      >
        <div data-testid="workspace-detail-backdrop" className="workspace-detail-backdrop" aria-hidden onMouseDown={onClose} />
        <DialogContent
          ref={drawer}
          // The rail's shape is its own (`.workspace-detail-rail`, workspace-detail.css) and the
          // resolved presentation dresses it through `.overlay-surface[data-presentation]`, so the
          // primitive's geometry variants are declined rather than merged over the top of it.
          presentation={null}
          data-presentation={presentation}
          className="overlay-surface workspace-detail-rail workspace-detail-drawer"
          aria-label={label}
          // The rail has no description slot; without this Radix points `aria-describedby` at an id
          // nothing in the tree carries.
          aria-describedby={undefined}
          // The backdrop above already owns dismissal, and it is the only owner that knows a nested
          // overlay's backdrop must not close its parent.
          onInteractOutside={(event) => event.preventDefault()}
          // Focus policy stays the app's: the surface (or whatever asked for `[data-autofocus]`) on the
          // way in, the opener on the way out — Radix would take the first control and then hand focus
          // to a trigger that does not exist.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (drawer.current) focusOverlaySurface(drawer.current);
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
        >
          <header className="workspace-detail-rail__header">
            <span>{label}</span>
            <button type="button" onClick={onClose} aria-label={closeLabel} className="overlay-touch-target workspace-detail-rail__close">×</button>
          </header>
          <div className="workspace-detail-rail__body"><OverlayDepthProvider>{children}</OverlayDepthProvider></div>
        </DialogContent>
      </div>
    </Dialog>,
    portal,
  );
}
