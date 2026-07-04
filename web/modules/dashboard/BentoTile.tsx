import type { ReactNode } from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Chip, type ChipTone } from './Chip';

/** Grid footprint of a tile. `hero` is the 2×2 focal card, `wide` a 2×1 strip; the rest are 1×1.
 *  On narrow containers spans collapse (see DashboardView's grid) so everything stacks cleanly. */
type Span = 'hero' | 'wide' | 'cell';

const SPAN: Record<Span, string> = {
  hero: '@xl:col-span-2 @xl:row-span-2 @4xl:col-span-2 @4xl:row-span-2',
  wide: '@xl:col-span-2',
  cell: '',
};

/** The bento tile shell: a flat `surface` card (1px border, tight radius, card shadow) with a header
 *  row — a colored `Chip` + uppercase label + optional trailing slot — above free-form children. When
 *  `href` is set the whole tile is a link with a subtle hover lift. Purely presentational; each tile's
 *  data lives in its own wrapper (HeroNowTile, SpendTile, …). */
export function BentoTile({
  tone, icon, label, trailing, href, span = 'cell', className = '', children,
}: {
  tone: ChipTone;
  icon: LucideIcon;
  label: string;
  trailing?: ReactNode;
  href?: string;
  span?: Span;
  className?: string;
  children?: ReactNode;
}) {
  const cls = `group relative flex flex-col gap-3 overflow-hidden rounded-xl border border-border bg-surface p-[18px] transition-[border-color,transform] duration-200 hover:border-border-strong hover:-translate-y-0.5 motion-reduce:hover:translate-y-0 ${SPAN[span]} ${className}`;
  const inner = (
    <>
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Chip tone={tone} icon={icon} />
          <span className="truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">{label}</span>
        </div>
        {trailing}
      </div>
      {children}
    </>
  );
  return href
    ? <Link href={href} className={cls} style={{ boxShadow: 'var(--shadow-card)' }}>{inner}</Link>
    : <div className={cls} style={{ boxShadow: 'var(--shadow-card)' }}>{inner}</div>;
}
