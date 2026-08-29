'use client';
import type { LucideIcon } from 'lucide-react';

import { Button } from './shadcn/button';

/** A square, icon-only control, composed from the shadcn/ui `Button` in `./shadcn/button.tsx` at its `icon`
 *  size. It is not a second primitive: it is that button with the label moved out of the child and into
 *  `aria-label`, plus this app's own 28px geometry — `size-7` rather than shadcn's `size-9`, because
 *  these sit in table rows and toolbars where a 36px control would set the row height. */
export function IconButton({ icon: Icon, label, onClick, variant = 'default', disabled = false }: { icon: LucideIcon; label: string; onClick?: () => void; variant?: 'default' | 'danger'; disabled?: boolean }) {
  return (
    <Button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      variant={variant === 'danger' ? 'outline-destructive' : 'outline'}
      size="icon"
      // Square, not rounded, and deliberately so: these align to the edge of a cell or a toolbar, where a
      // radius reads as a gap in the rule the row is drawn on.
      className="size-7 rounded-none"
      style={{ transitionDuration: 'var(--motion-fast)' }}
    >
      <Icon size={14} aria-hidden />
    </Button>
  );
}
