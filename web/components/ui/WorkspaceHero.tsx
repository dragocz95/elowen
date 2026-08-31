'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { SpatialMascotState } from './SpatialMascot';
import { horizontalOverflowState, NO_HORIZONTAL_OVERFLOW, type HorizontalOverflowState } from './horizontalScroll';

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
  /** The page's ambient state, as a visual input and nothing more.
   *
   *  It used to mount a decorative mascot panel beside the title — a 12rem column of artwork that carried
   *  no information, pushed the first record of every register most of a screen further down, and was
   *  already hidden outright by both shipped designs and by the phone stylesheet. The column is gone.
   *
   *  The PROP is not: eleven plugin bundles across two repositories pass it, `SpatialWorkspaceHero`
   *  defaults it to `idle`, and the plugin UI API version is a compatibility ceiling that cannot express
   *  a removal. It is now inert — published on the hero as `data-mascot` so a design can still read the
   *  page's state and answer it in CSS, with no artwork and no layout of its own. */
  mascot?: SpatialMascotState | false;
  /** WorkspaceMetric children. Supplying them opens the hairline metric rail below the title block. */
  metrics?: ReactNode;
}

function WorkspaceHeroMetrics({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<HorizontalOverflowState>(NO_HORIZONTAL_OVERFLOW);
  const measure = useCallback(() => {
    const track = ref.current;
    if (!track) return;
    const next = horizontalOverflowState(track);
    setOverflow((current) => (
      current.overflow === next.overflow && current.left === next.left && current.right === next.right
        ? current
        : next
    ));
  }, []);

  useEffect(() => {
    const track = ref.current;
    if (!track) return;
    measure();
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    const mutationObserver = new MutationObserver(measure);
    resizeObserver?.observe(track);
    mutationObserver.observe(track, { characterData: true, childList: true, subtree: true });
    track.addEventListener('scroll', measure, { passive: true });
    return () => {
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      track.removeEventListener('scroll', measure);
    };
  }, [measure]);

  const edgeStyle = {
    '--workspace-metrics-fade-left': overflow.left ? 'var(--workspace-metrics-fade-size)' : '0px',
    '--workspace-metrics-fade-right': overflow.right ? 'var(--workspace-metrics-fade-size)' : '0px',
  } as CSSProperties;

  return (
    <div
      ref={ref}
      className="workspace-hero__metrics"
      data-testid="workspace-hero-metrics"
      data-overflow={overflow.overflow}
      data-overflow-left={overflow.left}
      data-overflow-right={overflow.right}
      style={edgeStyle}
    >
      {children}
    </div>
  );
}

export function WorkspaceHero({ eyebrow, title, count, description, status, action, icon: Icon, mascot = false, metrics }: WorkspaceHeroProps) {
  const hasActions = status != null || action != null;

  return (
    <section className="workspace-hero" data-mascot={mascot === false ? undefined : mascot}>
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
      {metrics != null ? <WorkspaceHeroMetrics>{metrics}</WorkspaceHeroMetrics> : null}
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
