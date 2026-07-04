import type { LucideIcon } from 'lucide-react';

/** The semantic hues a chip can carry — a superset of `Tone` (adds info/approve, drops the neutral
 *  aliases) mapped straight onto the design tokens in tokens.css. */
export type ChipTone = 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'approve' | 'muted';

const TONE_VAR: Record<ChipTone, string> = {
  accent: '--color-accent',
  success: '--color-success',
  warning: '--color-warning',
  danger: '--color-danger',
  info: '--color-info',
  approve: '--color-approve',
  muted: '--color-text-muted',
};

/** A small tinted square holding a colored icon — the iOS-Settings-style glyph that gives each bento
 *  tile its identity. The hue tints its own background (~13 %) and border (~32 %) via color-mix, so one
 *  token drives all three layers and it reads correctly in both themes. */
export function Chip({ tone, icon: Icon, size = 'md' }: { tone: ChipTone; icon: LucideIcon; size?: 'sm' | 'md' }) {
  const v = `var(${TONE_VAR[tone]})`;
  const box = size === 'sm' ? 'h-[26px] w-[26px] rounded-[7px]' : 'h-8 w-8 rounded-lg';
  return (
    <span
      className={`inline-grid shrink-0 place-items-center border ${box}`}
      style={{
        color: v,
        background: `color-mix(in srgb, ${v} 13%, transparent)`,
        borderColor: `color-mix(in srgb, ${v} 32%, transparent)`,
      }}
    >
      <Icon size={size === 'sm' ? 13 : 16} aria-hidden />
    </span>
  );
}
