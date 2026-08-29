'use client';

import { type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { SpatialWorkspaceHero, WorkspaceHero, WorkspaceMetric, type SpatialWorkspaceHeroProps } from './WorkspaceHero';
import { WorkspaceShell, type SpatialDeckSection } from './WorkspaceShell';
import { Modal, ModalBody } from './Modal';

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

/** The master/detail rail: a surface you open to READ a record, not to work in one.
 *
 *  It is `Modal` with `intent="inspect"`, and nothing else. It used to be a second dialog
 *  implementation — its own portal, its own overlay-stack registration, its own Radix `DialogContent`,
 *  its own backdrop, header, close control and scroll body, and its own paint and geometry in
 *  `app/styles/components/workspace-detail.css`. Two implementations of one thing is two of everything
 *  that can be got wrong, and they had already diverged: the rail dismissed on `mousedown` where the
 *  dialog required a press that BEGAN on the backdrop (so releasing a drag from inside the rail onto the
 *  backdrop closed it), and it painted itself `--color-document` with a hand-rolled cast shadow where
 *  the dialog took the shared raised material.
 *
 *  Everything the name promised survives the collapse, because `Modal` already owned all of it: the
 *  portal to <body>, the overlay stack's `inert` isolation and scroll lock, the focus it puts in and
 *  gives back, the `OverlayDepthProvider` that makes anything opened from inside the rail resolve one
 *  level deeper, and the full-screen presentation on a phone — where a side rail would leave a useless
 *  strip of backdrop beside it.
 *
 *  What `intent="inspect"` buys is the z-band: a browsing surface sits on the drawer band, below the
 *  modal band an editing dialog raised FROM it takes. `drawerWidth="default"` is the rail's own width
 *  (`min(38rem, calc(100vw - 3rem))`), stated because `Modal` widens a drawer for `size="lg"`.
 *
 *  Kept as a named component rather than folded into call sites: eleven plugin bundles across two
 *  repositories mount it through the plugin UI runtime, and the plugin API version is a compatibility
 *  ceiling that cannot express a removal. */
export function WorkspaceDetailRail({ label, closeLabel, onClose, children }: { label: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal title={label} closeLabel={closeLabel} onClose={onClose} intent="inspect" size="md" drawerWidth="default">
      <ModalBody>{children}</ModalBody>
    </Modal>
  );
}
