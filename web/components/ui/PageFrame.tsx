import type { ReactNode } from 'react';

const WIDTHS = {
  reading: 'max-w-4xl', workspace: 'max-w-6xl', wide: 'max-w-7xl', fluid: 'max-w-none',
} as const;

/** Common body frame below ModuleHeader. Specialist canvases can opt into fluid width. */
export function PageFrame({ children, toolbar, intro, width = 'wide', className = '' }: {
  children: ReactNode;
  toolbar?: ReactNode;
  intro?: ReactNode;
  width?: keyof typeof WIDTHS;
  className?: string;
}) {
  return (
    <div className={`mx-auto flex w-full min-w-0 flex-col gap-5 ${WIDTHS[width]} ${className}`}>
      {intro ? <div className="max-w-3xl text-sm leading-relaxed text-text-muted">{intro}</div> : null}
      {toolbar ? <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 border-y border-border/70 py-2.5">{toolbar}</div> : null}
      {children}
    </div>
  );
}

/** Container-aware master/detail composition shared by entity workspaces. */
export function AdaptiveSplit({ children, aside, asideWidth = '19rem', className = '' }: {
  children: ReactNode;
  aside: ReactNode;
  asideWidth?: string;
  className?: string;
}) {
  return (
    <div className={`@container ${className}`} style={{ '--adaptive-aside': asideWidth } as React.CSSProperties}>
      <div className="adaptive-split grid min-w-0 gap-5">
        <div className="min-w-0">{children}</div>
        <aside className="min-w-0">{aside}</aside>
      </div>
    </div>
  );
}
