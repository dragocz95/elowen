import { createElement, type HTMLAttributes, type ElementType, type ReactNode } from 'react';

type SurfaceLevel = 'canvas' | 'panel' | 'raised' | 'overlay';
type SurfacePadding = 'none' | 'sm' | 'md' | 'lg';
type SurfaceRadius = 'none' | 'sm' | 'md' | 'lg' | 'xl';
type SurfaceTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

const LEVELS: Record<SurfaceLevel, string> = {
  canvas: 'border-border/70 bg-transparent',
  panel: 'border-border bg-surface',
  raised: 'border-border-strong/75 bg-elevated shadow-[var(--shadow-card)]',
  overlay: 'border-border-strong bg-overlay shadow-[var(--shadow-raised)]',
};
const PADDING: Record<SurfacePadding, string> = { none: '', sm: 'p-3', md: 'p-4', lg: 'p-5' };
const RADIUS: Record<SurfaceRadius, string> = {
  none: 'rounded-none', sm: 'rounded-md', md: 'rounded-lg', lg: 'rounded-xl', xl: 'rounded-2xl',
};
const TONES: Record<SurfaceTone, string> = {
  neutral: '', brand: 'border-accent/45', success: 'border-success/40', warning: 'border-warning/45', danger: 'border-danger/45',
};

/** Canonical Elowen surface. Tone communicates meaning, while level controls physical elevation. */
export function Surface({
  as = 'div', level = 'panel', padding = 'none', radius = 'md', tone = 'neutral',
  interactive = false, selected = false, busy = false, className = '', children, ...rest
}: {
  as?: ElementType;
  level?: SurfaceLevel;
  padding?: SurfacePadding;
  radius?: SurfaceRadius;
  tone?: SurfaceTone;
  interactive?: boolean;
  selected?: boolean;
  busy?: boolean;
  children: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  const state = busy ? 'busy' : selected ? 'selected' : 'idle';
  const classes = [
    'border', LEVELS[level], PADDING[padding], RADIUS[radius], TONES[tone],
    interactive ? 'card-interactive' : '',
    selected ? 'border-accent bg-accent/[0.055]' : '',
    busy ? 'opacity-70' : '', className,
  ].filter(Boolean).join(' ');
  return createElement(as, { ...rest, 'data-state': state, 'aria-busy': busy || undefined, className: classes }, children);
}
