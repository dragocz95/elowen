import type { LucideIcon } from 'lucide-react';

/** Chip emphasis. `muted` is the default, restrained look (a plain elevated square with a text-muted
 *  glyph); the toned variants light up ONLY when the tile carries live meaning — accent for the active
 *  agent, warning for a decision that's waiting. Color is a signal here, not decoration. */
export type ChipTone = 'muted' | 'accent' | 'warning' | 'success' | 'danger';

const TONE: Record<ChipTone, string> = {
  muted: 'border-border bg-elevated text-text-muted',
  accent: 'border-accent/40 bg-accent/10 text-accent',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  success: 'border-success/40 bg-success/10 text-success',
  danger: 'border-danger/40 bg-danger/10 text-danger',
};

/** A small square holding a tile's glyph — muted by default, toned only when the tile is live. Mirrors
 *  the icon-chip treatment used across the app (plugin cards, provider pills) so the dashboard reads as
 *  part of the same restrained, monochrome-with-accent system. */
export function Chip({ tone = 'muted', icon: Icon, size = 'md' }: { tone?: ChipTone; icon: LucideIcon; size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'h-[26px] w-[26px] rounded-[7px]' : 'h-8 w-8 rounded-lg';
  return (
    <span className={`inline-grid shrink-0 place-items-center border ${box} ${TONE[tone]}`}>
      <Icon size={size === 'sm' ? 13 : 16} aria-hidden />
    </span>
  );
}
