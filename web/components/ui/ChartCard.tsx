'use client';
import type { LucideIcon } from 'lucide-react';

/** The card a chart shows on hover, and the pieces every one of them is built from.
 *
 *  It started inside the dashboard's pulse ring and moved here the moment a second chart needed it:
 *  a hover card that looks different depending on which page you are on is the fastest way to make one
 *  application feel like three. Charts pass their own rows; the frame, the type scale and the way a
 *  value aligns are decided once, here. */

/** One labelled line inside a card. The icon carries the identity — the same reasoning as the activity
 *  feed's tool marks, where a mark reads faster than the word it replaces. */
export function CardRow({ icon: Icon, label, children }: {
  icon: LucideIcon; label: string; children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-5">
      <Icon size={12} className="shrink-0 translate-y-0.5 text-text-subtle" aria-hidden />
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto min-w-0 truncate text-right font-mono tabular-nums text-foreground">{children}</span>
    </div>
  );
}

/** The frame every card sits in, so all of them look like one component rather than several. */
export function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-60 rounded-xl border border-border bg-card/95 p-3 shadow-xl backdrop-blur">
      {children}
    </div>
  );
}

/** A card header: a colour chip tying the card to the slice under the cursor, a name, and the share. */
export function CardHead({ colour, title, share, icon: Icon }: {
  colour: string; title: string; share?: number; icon?: LucideIcon;
}) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colour }} />
      {Icon ? <Icon size={13} className="shrink-0 text-muted-foreground" aria-hidden /> : null}
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight text-foreground">{title}</span>
      {share === undefined ? null : (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{share.toFixed(1)} %</span>
      )}
    </div>
  );
}
