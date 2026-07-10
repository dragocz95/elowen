import type { HTMLAttributes, ReactNode } from 'react';

/** Quiet line-based collection used for projects, sessions, plugins and other first-class entities. */
export function EntityList({ children, className = '', ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return <div role="list" className={`overflow-hidden border-y border-border/80 divide-y divide-border/70 ${className}`} {...rest}>{children}</div>;
}

/** Visual row contract. The caller keeps ownership of its semantic link/button and domain content. */
export function EntityRow({ children, selected = false, busy = false, interactive = true, className = '', ...rest }: {
  children: ReactNode;
  selected?: boolean;
  busy?: boolean;
  interactive?: boolean;
} & HTMLAttributes<HTMLDivElement>) {
  const state = busy ? 'busy' : selected ? 'selected' : 'idle';
  return (
    <div
      role="listitem"
      data-state={state}
      aria-busy={busy || undefined}
      className={`${interactive ? 'interactive-row' : ''} min-w-0 px-1 py-3.5 ${selected ? 'bg-accent/[0.055]' : ''} ${busy ? 'opacity-70' : ''} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
